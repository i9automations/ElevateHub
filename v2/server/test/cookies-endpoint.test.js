// Teste de INTEGRACAO do endpoint de cookies (o dado mais sensivel: a sessao/login).
// Sobe o servidor real com json-store num diretorio temporario, loga e exercita a
// TRAVA anti-logout de ponta a ponta: empty-guard, primary-guard, re-login,
// unreadable-guard (arquivo existe mas nao decifra) e JSON invalido -> 400.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const PORT = 8793;
const BASE = `http://127.0.0.1:${PORT}`;
const PID = "prf_demo";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ck-itest-"));
const DATA_DIR = path.join(tmp, "data");

let srv, token;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CK = (name, value = "x") => ({ name, value, domain: "seller-br.tiktok.com", path: "/" });

async function api(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, opts);
  let body = null; try { body = await res.json(); } catch {}
  return { status: res.status, body };
}
const H = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${token}` });
const put = (cookies) => api(`/api/profiles/${PID}/cookies`, { method: "PUT", headers: H(), body: JSON.stringify({ cookies }) });
const get = () => api(`/api/profiles/${PID}/cookies`, { headers: H() });

before(async () => {
  const env = {
    ...process.env,
    V2_DATA_STORE: "json",
    V2_DB_FILE: path.join(tmp, "db.json"),
    V2_DATA_DIR: DATA_DIR,
    V2_ADMIN_EMAIL: "admin@elevate.local",
    V2_ADMIN_PASSWORD: "admin123",
    PORT: String(PORT),
    NODE_ENV: "test"
  };
  srv = spawn("node", ["src/index.js"], { cwd: path.join(__dirname, ".."), env, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch {}
    await sleep(200);
  }
  const login = await api("/api/auth/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@elevate.local", password: "admin123" })
  });
  token = login.body?.token;
  assert.ok(token, "login local deve retornar token");
});

after(async () => { if (srv) srv.kill(); await sleep(200); });

test("grava sessao boa e le de volta", async () => {
  const r = await put([CK("sessionid_tiktokseller"), CK("sid_guard_tiktokseller"), CK("ttwid")]);
  assert.strictEqual(r.body?.count, 3);
  assert.strictEqual((await get()).body?.cookies?.length, 3);
});

test("empty-guard: PUT vazio NAO apaga a sessao", async () => {
  const r = await put([]);
  assert.strictEqual(r.body?.skipped, "empty-guard");
  assert.strictEqual((await get()).body?.cookies?.length, 3);
});

test("primary-guard: leitura sem sessionid NAO sobrescreve", async () => {
  const r = await put([CK("sid_guard_tiktokseller"), CK("ttwid")]);
  assert.ok(r.body?.skipped && r.body.skipped !== "empty-guard");
  assert.strictEqual((await get()).body?.cookies?.length, 3);
});

test("re-login legitimo (sessionid novo) grava", async () => {
  const r = await put([CK("sessionid_tiktokseller", "novo"), CK("sid_guard_tiktokseller"), CK("ttwid"), CK("z")]);
  assert.strictEqual(r.body?.count, 4);
});

test("unreadable-guard: sessao ilegivel + leitura degradada = BARRA; re-login real grava", async () => {
  const file = path.join(DATA_DIR, "cookies", `${PID}.json`);
  assert.ok(fs.existsSync(file), "arquivo de cookies deve existir");
  fs.writeFileSync(file, "v1:XXX:YYY:ZZZ"); // parece cifrado, nao decifra
  const bloqueado = await put([CK("ttwid"), CK("msToken")]);
  assert.strictEqual(bloqueado.body?.skipped, "unreadable-guard");
  const relogin = await put([CK("sessionid_tiktokseller", "recuperado"), CK("ttwid")]);
  assert.strictEqual(relogin.body?.count, 2);
  assert.strictEqual((await get()).body?.cookies?.length, 2);
});

test("JSON invalido no corpo retorna 400 (nao 500)", async () => {
  const res = await fetch(`${BASE}/api/profiles/${PID}/cookies`, { method: "PUT", headers: H(), body: "{nao e json" });
  assert.strictEqual(res.status, 400);
});

test("health das sessoes: conta a logada (prf_demo esta com sessionid apos os testes)", async () => {
  const r = await api("/api/profiles/health", { headers: H() });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body?.total, 1);
  assert.strictEqual(r.body?.loggedIn, 1);
  assert.strictEqual(r.body?.needRelogin?.length, 0);
});
