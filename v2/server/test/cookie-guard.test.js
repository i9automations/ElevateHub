// Testa a trava ANTI-LOGOUT dos cookies (cookie-guard.js). Roda com: node --test
const { test } = require("node:test");
const assert = require("node:assert");
const { cookieWriteDecision, hasAuthCookie, hasPrimaryAuth } = require("../src/cookie-guard");

const ck = (name, value = "x") => ({ name, value });

test("sem sessao guardada: sempre grava (primeira vez)", () => {
  assert.deepStrictEqual(cookieWriteDecision([], [ck("sessionid")]), { write: true, reason: "ok" });
  assert.deepStrictEqual(cookieWriteDecision(null, [ck("qualquer")]), { write: true, reason: "ok" });
  // ate vazio->vazio grava (nao ha o que proteger)
  assert.strictEqual(cookieWriteDecision(null, []).write, true);
});

test("empty-guard: leitura VAZIA nunca apaga sessao existente", () => {
  const d = cookieWriteDecision([ck("sessionid"), ck("ttwid")], []);
  assert.deepStrictEqual(d, { write: false, reason: "empty-guard" });
});

test("auth-guard: perdeu TODOS os cookies de login = degradada", () => {
  const stored = [ck("sessionid"), ck("sid_guard")];
  const incoming = [ck("ttwid"), ck("msToken")]; // nenhum cookie de login
  assert.deepStrictEqual(cookieWriteDecision(stored, incoming), { write: false, reason: "auth-guard" });
});

test("primary-guard (o fix do logout): manteve secundario mas PERDEU o sessionid", () => {
  // leitura parcial durante navegacao: sobrou uid_tt (secundario), sumiu sessionid
  const stored = [ck("sessionid"), ck("sid_guard"), ck("uid_tt")];
  const incoming = [ck("uid_tt"), ck("ttwid")];
  const d = cookieWriteDecision(stored, incoming);
  assert.deepStrictEqual(d, { write: false, reason: "primary-guard" },
    "leitura parcial que perde o sessionid NAO pode sobrescrever (deslogaria)");
});

test("grava: re-login legitimo (sessionid com valor NOVO)", () => {
  const stored = [ck("sessionid", "antigo"), ck("sid_guard", "a")];
  const incoming = [ck("sessionid", "novo"), ck("sid_guard", "b"), ck("uid_tt", "u")];
  assert.strictEqual(cookieWriteDecision(stored, incoming).write, true);
});

test("grava: sessao valida cheia continua valida cheia", () => {
  const full = [ck("sessionid"), ck("sessionid_ss"), ck("sid_guard"), ck("uid_tt"), ck("ttwid")];
  assert.strictEqual(cookieWriteDecision(full, full).write, true);
});

test("conta sem login (so cookies comuns): grava normalmente", () => {
  const stored = [ck("ttwid"), ck("_ga")];
  const incoming = [ck("ttwid"), ck("_ga"), ck("outro")];
  assert.strictEqual(cookieWriteDecision(stored, incoming).write, true);
});

test("Mercado Livre: perder orguseridp (principal) = protegido", () => {
  const stored = [ck("orguseridp"), ck("ssid")];
  const incoming = [ck("ssid")]; // perdeu o principal
  assert.strictEqual(cookieWriteDecision(stored, incoming).reason, "primary-guard");
});

test("helpers: hasAuthCookie / hasPrimaryAuth ignoram cookie sem valor", () => {
  assert.strictEqual(hasAuthCookie([{ name: "sessionid", value: "" }]), false);
  assert.strictEqual(hasPrimaryAuth([ck("sessionid")]), true);
  assert.strictEqual(hasPrimaryAuth([ck("uid_tt")]), false, "uid_tt e secundario, nao principal");
  assert.strictEqual(hasAuthCookie([ck("SessionId")]), true, "case-insensitive");
});
