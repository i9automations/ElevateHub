// Decisao anti-regressao / anti-LOGOUT dos cookies de sessao, isolada aqui pra
// ser testavel (unit tests em test/cookie-guard.test.js). O index.js so chama
// cookieWriteDecision() no PUT /cookies.
//
// Regra: uma sincronizacao roda a cada ~8s com o navegador aberto. Uma leitura
// VAZIA ou PARCIAL (durante navegacao/redirect/checagem de seguranca, ou o Chrome
// fechando) NAO pode apagar/piorar uma sessao boa -> senao a conta "cai" (desloga)
// e o estado ruim ainda se espalha pros outros PCs.

// Cookies de LOGIN conhecidos por marketplace.
// IMPORTANTE: o TikTok SELLER (seller-br.tiktok.com) usa os cookies de sessao com
// o sufixo "_tiktokseller" (sessionid_tiktokseller etc.) — NAO o "sessionid" cru.
// Precisamos reconhecer AMBOS, senao a trava nao protege contas Seller (o caso
// principal do app) e elas deslogam sozinhas.
const AUTH_COOKIE_NAMES = new Set([
  // TikTok / TikTok Shop (afiliado)
  "sessionid", "sessionid_ss", "sid_tt", "sid_guard", "uid_tt", "uid_tt_ss", "cmpl_token",
  // TikTok SELLER (painel do vendedor) — cookies com sufixo
  "sessionid_tiktokseller", "sessionid_ss_tiktokseller", "sid_tt_tiktokseller",
  "sid_guard_tiktokseller", "uid_tt_tiktokseller", "uid_tt_ss_tiktokseller",
  // Mercado Livre
  "orguseridp", "ssid",
  // Shopee (consumidor)
  "spc_ec", "spc_st", "spc_u",
  // Shopee SELLER (seller.shopee.com.br) — nomes proprios do painel do vendedor
  "spc_sc_session", "spc_sc_offline_token", "spc_sc_tk",
  // Amazon
  "at-main", "sess-at-main", "x-main", "sess-id"
]);

// Cookie de SESSAO PRINCIPAL: e a ausencia DELE que significa "deslogado" de
// verdade. Uma leitura parcial pode manter um secundario mas perder o principal.
const PRIMARY_AUTH_NAMES = new Set([
  "sessionid", "sessionid_ss",                              // TikTok afiliado
  "sessionid_tiktokseller", "sessionid_ss_tiktokseller",   // TikTok SELLER
  "orguseridp",                                            // Mercado Livre
  "spc_ec", "spc_st",                                      // Shopee consumidor
  "spc_sc_session", "spc_sc_offline_token",                // Shopee SELLER
  "at-main", "sess-at-main"                                // Amazon
]);

function hasNamed(cookies, nameSet) {
  return (Array.isArray(cookies) ? cookies : []).some(
    (c) => c && c.name && c.value && nameSet.has(String(c.name).toLowerCase())
  );
}
function hasAuthCookie(cookies) { return hasNamed(cookies, AUTH_COOKIE_NAMES); }
function hasPrimaryAuth(cookies) { return hasNamed(cookies, PRIMARY_AUTH_NAMES); }

// Decide se o PUT deve GRAVAR os cookies novos ou RECUSAR (preservando os antigos).
// stored = cookies guardados (array ou null/[]); incoming = os que chegaram.
// Retorna { write: bool, reason: "ok"|"empty-guard"|"auth-guard"|"primary-guard" }.
function cookieWriteDecision(stored, incoming) {
  const inc = Array.isArray(incoming) ? incoming : [];
  const sto = Array.isArray(stored) ? stored : [];
  if (sto.length > 0) {
    // 1) vazio nunca substitui uma sessao que existe
    if (inc.length === 0) return { write: false, reason: "empty-guard" };
    // 2) perdeu TODOS os cookies de login que a guardada tinha = degradada
    if (hasAuthCookie(sto) && !hasAuthCookie(inc)) return { write: false, reason: "auth-guard" };
    // 3) manteve algum de login mas PERDEU o de SESSAO PRINCIPAL (sessionid etc.)
    //    = leitura parcial durante navegacao -> nao pode virar logout
    if (hasPrimaryAuth(sto) && !hasPrimaryAuth(inc)) return { write: false, reason: "primary-guard" };
  }
  return { write: true, reason: "ok" };
}

module.exports = {
  AUTH_COOKIE_NAMES,
  PRIMARY_AUTH_NAMES,
  hasAuthCookie,
  hasPrimaryAuth,
  cookieWriteDecision
};
