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

test("TikTok SELLER: reconhece sessionid_tiktokseller (o caso que deslogava)", () => {
  const seller = [ck("sessionid_tiktokseller"), ck("sid_guard_tiktokseller"), ck("ttwid")];
  assert.strictEqual(hasAuthCookie(seller), true, "conta Seller e login valido");
  assert.strictEqual(hasPrimaryAuth(seller), true, "sessionid_tiktokseller e primario");
  // leitura parcial que perde o sessionid do Seller -> NAO pode sobrescrever
  const parcial = [ck("ttwid"), ck("uid_tt_tiktokseller")];
  assert.strictEqual(cookieWriteDecision(seller, parcial).reason, "primary-guard",
    "perder o sessionid do Seller era o bug do deslogar");
});

test("Shopee SELLER: reconhece SPC_SC_SESSION (mesma classe do bug do Seller)", () => {
  const shopee = [ck("SPC_SC_SESSION"), ck("SPC_SC_OFFLINE_TOKEN"), ck("csrftoken")];
  assert.strictEqual(hasAuthCookie(shopee), true, "Shopee Seller logado");
  assert.strictEqual(hasPrimaryAuth(shopee), true, "SPC_SC_SESSION e primario");
  const parcial = [ck("csrftoken"), ck("SPC_F")]; // perdeu a sessao
  assert.strictEqual(cookieWriteDecision(shopee, parcial).write, false,
    "leitura parcial NAO pode apagar a sessao da Shopee Seller");
});

test("helpers: hasAuthCookie / hasPrimaryAuth ignoram cookie sem valor", () => {
  assert.strictEqual(hasAuthCookie([{ name: "sessionid", value: "" }]), false);
  assert.strictEqual(hasPrimaryAuth([ck("sessionid")]), true);
  assert.strictEqual(hasPrimaryAuth([ck("uid_tt")]), false, "uid_tt e secundario, nao principal");
  assert.strictEqual(hasAuthCookie([ck("SessionId")]), true, "case-insensitive");
});
