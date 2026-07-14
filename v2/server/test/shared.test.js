// Testa helpers do servidor: anti-SSRF, TTL de trava, CSV, squads, senha.
const { test } = require("node:test");
const assert = require("node:assert");
const {
  sanitizeStartUrl, isBlockedHost, canControlProfile, normalizeSquad,
  parseCsv, normalizeTags, hashPassword, verifyPassword, now
} = require("../src/shared");

test("isBlockedHost: bloqueia loopback/rede interna e IP em qualquer forma", () => {
  for (const h of ["localhost", "algo.local", "x.internal", "127.0.0.1", "10.0.0.5",
                   "192.168.1.1", "::1", "2130706433", "0x7f.0.0.1", "0177.0.0.1",
                   "[::ffff:127.0.0.1]"]) {
    assert.strictEqual(isBlockedHost(h), true, `deveria bloquear: ${h}`);
  }
});

test("isBlockedHost: libera dominios reais", () => {
  for (const h of ["seller-br.tiktok.com", "mercadolivre.com.br", "google.com"]) {
    assert.strictEqual(isBlockedHost(h), false, `deveria liberar: ${h}`);
  }
});

test("sanitizeStartUrl: vazio -> '', IP/interno -> '' (SSRF), dominio -> https", () => {
  assert.strictEqual(sanitizeStartUrl(""), "");
  assert.strictEqual(sanitizeStartUrl("   "), "");
  assert.strictEqual(sanitizeStartUrl("http://127.0.0.1/x"), "");     // SSRF barrado
  assert.strictEqual(sanitizeStartUrl("http://2130706433/"), "");     // decimal de 127.0.0.1
  assert.strictEqual(sanitizeStartUrl("http://localhost:8787"), "");  // interno
  assert.strictEqual(sanitizeStartUrl("http://192.168.0.10/"), "");   // rede interna
  // dominio real: sempre vira https e nunca aponta pra IP interno
  const ok = sanitizeStartUrl("seller.shopee.com.br");
  assert.ok(ok.startsWith("https://"), "assume https");
  assert.ok(sanitizeStartUrl("https://seller-br.tiktok.com/x").includes("tiktok.com"));
});

test("canControlProfile: livre / dono / admin / trava recente / trava expirada", () => {
  const eu = { id: "u1", role: "operator" };
  const outro = { id: "u2", role: "operator" };
  const admin = { id: "u3", role: "admin" };
  assert.strictEqual(canControlProfile({ lockedBy: null }, eu), true, "sem trava");
  assert.strictEqual(canControlProfile({ lockedBy: "u1" }, eu), true, "dono da trava");
  assert.strictEqual(canControlProfile({ lockedBy: "u2" }, admin), true, "admin sempre pode");
  const recente = { lockedBy: "u2", lockedAt: now() };
  assert.strictEqual(canControlProfile(recente, eu), false, "trava recente de outro barra");
  const antiga = { lockedBy: "u2", lockedAt: new Date(Date.now() - 21 * 60 * 1000).toISOString() };
  assert.strictEqual(canControlProfile(antiga, eu), true, "trava > 20min expira (fim do 403 eterno)");
});

test("normalizeSquad: conhecido mantem, desconhecido -> fox", () => {
  assert.strictEqual(normalizeSquad("crown"), "crown");
  assert.strictEqual(normalizeSquad("MANALINDA-TIKTOK"), "manalinda-tiktok");
  assert.strictEqual(normalizeSquad("inexistente"), "fox");
  assert.strictEqual(normalizeSquad(undefined), "fox");
});

test("normalizeTags: string ou array -> array limpo, sem vazios/duplicados de espaco", () => {
  assert.deepStrictEqual(normalizeTags("a, b ,c"), ["a", "b", "c"]);
  assert.deepStrictEqual(normalizeTags(["x", " ", "y"]), ["x", "y"]);
  assert.deepStrictEqual(normalizeTags(""), []);
});

test("parseCsv: detecta delimitador e respeita aspas", () => {
  const rows = parseCsv('nome,email\n"Loja, SA",a@x.com\nBeta,b@x.com');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].nome, "Loja, SA");   // virgula dentro de aspas preservada
  assert.strictEqual(rows[0].email, "a@x.com");
  assert.strictEqual(rows[1].nome, "Beta");
  // ponto-e-virgula tambem
  const pv = parseCsv("nome;email\nAna;ana@x.com");
  assert.strictEqual(pv[0].email, "ana@x.com");
});

test("senha: hash + verify (pbkdf2) round-trip", () => {
  const h = hashPassword("segredo123");
  assert.ok(h.includes(":"));
  assert.strictEqual(verifyPassword("segredo123", h), true);
  assert.strictEqual(verifyPassword("errada", h), false);
});
