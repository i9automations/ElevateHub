// Busca o codigo de verificacao nas caixas Hostinger via IMAP, filtrando pelo
// alias do cliente (destinatario EXATO) e pontuando por remetente/qualidade.
// Libs carregadas sob demanda: se faltarem, so esta feature falha (servidor nao cai).
function lib() {
  return { ImapFlow: require("imapflow").ImapFlow, simpleParser: require("mailparser").simpleParser };
}

// Dicas de remetente por marketplace (parte que aparece no "From").
const MARKETPLACES = {
  tiktok: { label: "TikTok", senders: ["tiktok", "seller"] },
  mercadolivre: { label: "Mercado Livre", senders: ["mercadolivre", "mercadolibre", "mercado livre"] },
  shopee: { label: "Shopee", senders: ["shopee"] },
  amazon: { label: "Amazon", senders: ["amazon"] }
};

function marketplaceInfo(key) {
  return MARKETPLACES[String(key || "").toLowerCase()] || null;
}

// Extrai o codigo com PONTUACAO (evita pegar ano/pedido/preco):
//  - numero de 4-8 digitos colado (gap <=12) a uma palavra de codigo (antes OU depois): forte (3)
//  - numero isolado de 6 digitos: fraco (1)
//  - descarta anos (19xx/20xx). Prefere 6 digitos. Retorna {code, score} ou null.
function extractCode(subject, text) {
  const hay = `${subject || ""}\n${text || ""}`;
  const KW = "(?:c[oó]digo\\s+de\\s+(?:verifica\\w*|seguran[çc]a)|verification\\s+code|security\\s+code|one[- ]?time\\s+(?:password|code)|c[oó]digo|code|verifica\\w*|otp|pin|token)";
  // Se ESTAS palavras aparecem entre a palavra-chave e o numero, NAO e codigo:
  const BAD = /pedido|order|rastre|track|cupom|coupon|descont|discount|barra|invoice|nota\s|boleto|cpf|cnpj|telefone|phone|whats|fatura/i;
  const cands = [];
  const push = (code, score) => { if (!/^(19|20)\d\d$/.test(code)) cands.push({ code, score }); }; // fora anos
  let m;
  // numero de 4-8 digitos logo apos a palavra-chave (janela curta, sem palavra "ruim")
  const rAfterKw = new RegExp(KW + "(.{0,15}?)(\\d{4,8})(?!\\d)", "gi");
  while ((m = rAfterKw.exec(hay))) { if (!BAD.test(m[1])) push(m[2], m[2].length === 6 ? 5 : 3); }
  // numero logo antes da palavra-chave ("123456 is your code")
  const rBeforeKw = new RegExp("(?<!\\d)(\\d{4,8})(.{0,15}?)" + KW, "gi");
  while ((m = rBeforeKw.exec(hay))) { if (!BAD.test(m[2])) push(m[1], m[1].length === 6 ? 5 : 3); }
  // ultimo recurso: um 6 digitos isolado
  const iso = hay.match(/(?:^|[^0-9])(\d{6})(?:[^0-9]|$)/);
  if (iso) push(iso[1], 1);

  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);
  return cands[0];
}

function senderMatches(fromText, marketplace) {
  const mk = marketplaceInfo(marketplace);
  if (!mk) return true;
  const f = String(fromText || "").toLowerCase();
  return mk.senders.some((s) => f.includes(s));
}

function senderIsKnown(fromText) {
  const f = String(fromText || "").toLowerCase();
  return Object.values(MARKETPLACES).some((mk) => mk.senders.some((s) => f.includes(s)));
}

function emailsIn(str) {
  return String(str || "").toLowerCase().match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/g) || [];
}

// Todos os destinatarios reais do e-mail (to/cc/bcc + Delivered-To/X-Original-To).
function collectRecipients(parsed) {
  const out = new Set();
  for (const f of [parsed.to, parsed.cc, parsed.bcc]) {
    for (const a of (f?.value || [])) if (a.address) out.add(a.address.toLowerCase());
  }
  const hdr = (name) => { const h = parsed.headers?.get?.(name); return typeof h === "string" ? h : (h?.text || ""); };
  for (const raw of [hdr("delivered-to"), hdr("x-original-to")]) {
    for (const e of emailsIn(raw)) out.add(e);
  }
  return out;
}

function makeClient(box) {
  const { ImapFlow } = lib();
  return new ImapFlow({
    host: box.host || "imap.hostinger.com",
    port: box.port || 993,
    secure: box.secure !== false,
    auth: { user: box.user || box.email, pass: box.password },
    logger: false,
    connectionTimeout: 12000, // limita o connect TCP/TLS
    greetingTimeout: 10000,
    socketTimeout: 25000
  });
}

// Testa login/conexao de uma caixa. Retorna {ok} ou {ok:false, error}.
async function testMailbox(box) {
  const client = makeClient(box);
  try {
    await client.connect();
    await client.logout().catch(() => {});
    return { ok: true };
  } catch (error) {
    try { await client.close(); } catch {}
    return { ok: false, error: friendlyImapError(error) };
  }
}

function friendlyImapError(error) {
  const msg = String(error?.responseText || error?.message || error || "").toLowerCase();
  if (msg.includes("auth") || msg.includes("login") || msg.includes("credential")) return "Usuario ou senha incorretos.";
  if (msg.includes("timeout") || msg.includes("etimedout") || msg.includes("econn")) return "Nao consegui conectar no servidor de e-mail (host/porta?).";
  if (msg.includes("certificate") || msg.includes("tls")) return "Problema de certificado/TLS no servidor de e-mail.";
  return "Falha ao acessar a caixa de e-mail.";
}

// Procura o melhor codigo numa caixa. So aceita e-mail cujo destinatario seja
// EXATAMENTE o alias (evita foo@ casar com barfoo@). Retorna {code, score, ...} ou null.
async function fetchCodeFromBox(box, { alias, marketplace, sinceMinutes = 30 }) {
  const aliasLc = String(alias || "").trim().toLowerCase();
  if (!aliasLc) return null; // nunca busca sem alias
  const client = makeClient(box);
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = new Date(Date.now() - sinceMinutes * 60000);
      let uids = await client.search({ since, to: aliasLc }, { uid: true });
      if (!Array.isArray(uids) || !uids.length) return null;
      uids = uids.sort((a, b) => a - b).slice(-8); // ate 8 mais recentes

      const { simpleParser } = lib();
      const candidates = [];
      for await (const msg of client.fetch(uids, { uid: true, source: true, envelope: true }, { uid: true })) {
        let parsed;
        try { parsed = await simpleParser(msg.source); } catch { continue; }

        // destinatario EXATO (a busca IMAP "to" e por substring; aqui confirmamos)
        const recips = collectRecipients(parsed);
        if (recips.size && !recips.has(aliasLc)) continue;
        if (!recips.size) continue; // sem destinatarios legiveis: nao arrisca

        const fromText = parsed.from?.text || msg.envelope?.from?.map((a) => `${a.name} ${a.address}`).join(" ") || "";
        // se pediram um marketplace especifico, exige o remetente dele
        if (marketplace && !senderMatches(fromText, marketplace)) continue;

        const subject = parsed.subject || msg.envelope?.subject || "";
        const text = parsed.text || (parsed.html ? String(parsed.html).replace(/<[^>]+>/g, " ") : "");
        const ex = extractCode(subject, text);
        if (!ex) continue;

        const known = senderIsKnown(fromText);
        // remetente desconhecido + codigo "fraco" (numero solto) -> descarta (provavel falso)
        if (!known && ex.score < 3) continue;

        candidates.push({
          code: ex.code,
          score: ex.score + (known ? 2 : 0),
          subject,
          from: fromText.trim(),
          at: (parsed.date || msg.envelope?.date || new Date()).toISOString(),
          boxId: box.id, boxLabel: box.label, boxEmail: box.email
        });
      }
      if (!candidates.length) return null;
      candidates.sort((a, b) => (b.score - a.score) || (new Date(b.at) - new Date(a.at)));
      return candidates[0];
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => { try { client.close(); } catch {} });
  }
}

// Procura o codigo em TODAS as caixas (em paralelo). Cada caixa tem um teto de
// tempo (nao trava o pedido) e o resultado e o de MAIOR pontuacao, depois o mais novo.
async function fetchCode(boxes, opts) {
  const alias = String(opts?.alias || "").trim();
  if (!alias) return null; // defesa em profundidade: sem alias, nunca busca
  const usable = boxes.filter((b) => b && b.password && b.email);
  const withDeadline = (p) => Promise.race([
    p,
    new Promise((resolve) => setTimeout(() => resolve(null), 22000))
  ]);
  const results = await Promise.allSettled(usable.map((b) => withDeadline(fetchCodeFromBox(b, { ...opts, alias }))));
  const hits = results.filter((r) => r.status === "fulfilled" && r.value).map((r) => r.value);
  if (!hits.length) return null;
  hits.sort((a, b) => (b.score - a.score) || (new Date(b.at) - new Date(a.at)));
  return hits[0];
}

module.exports = { fetchCode, fetchCodeFromBox, testMailbox, extractCode, senderIsKnown, marketplaceInfo, MARKETPLACES };
