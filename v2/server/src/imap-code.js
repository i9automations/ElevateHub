// Busca o codigo de verificacao nas caixas Hostinger via IMAP, filtrando pelo
// alias do cliente (destinatario) e pelo marketplace (remetente).
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

// Acha um numero de 4 a 8 digitos, dando prioridade ao que estiver perto de
// palavras como "codigo", "code", "verification", "OTP".
function extractCode(subject, text) {
  const hay = `${subject || ""}\n${text || ""}`;
  const near = hay.match(/(?:c[oó]digo|code|verif\w*|c[oó]d\.?|otp|pin|token)[^0-9]{0,40}(\d{4,8})/i);
  if (near) return near[1];
  const isolated = hay.match(/(?:^|[^0-9])(\d{4,8})(?:[^0-9]|$)/);
  return isolated ? isolated[1] : null;
}

function senderMatches(fromText, marketplace) {
  const mk = marketplaceInfo(marketplace);
  if (!mk) return true; // sem marketplace definido: aceita qualquer remetente
  const f = String(fromText || "").toLowerCase();
  return mk.senders.some((s) => f.includes(s));
}

function makeClient(box) {
  const { ImapFlow } = lib();
  return new ImapFlow({
    host: box.host || "imap.hostinger.com",
    port: box.port || 993,
    secure: box.secure !== false,
    auth: { user: box.user || box.email, pass: box.password },
    logger: false,
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

// Procura o codigo mais recente numa caixa. Retorna {code, subject, from, at, boxId, boxLabel} ou null.
async function fetchCodeFromBox(box, { alias, marketplace, sinceMinutes = 30 }) {
  const client = makeClient(box);
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const since = new Date(Date.now() - sinceMinutes * 60000);
      const criteria = { since };
      if (alias) criteria.to = alias; // e-mail foi enviado para o alias do cliente
      let uids = await client.search(criteria, { uid: true });
      if (!Array.isArray(uids) || !uids.length) return null;
      uids = uids.sort((a, b) => a - b).slice(-6); // ate 6 mais recentes

      const { simpleParser } = lib();
      const candidates = [];
      for await (const msg of client.fetch(uids, { uid: true, source: true, envelope: true }, { uid: true })) {
        let parsed;
        try { parsed = await simpleParser(msg.source); } catch { continue; }
        const fromText = parsed.from?.text || msg.envelope?.from?.map((a) => `${a.name} ${a.address}`).join(" ") || "";
        if (!senderMatches(fromText, marketplace)) continue;
        const subject = parsed.subject || msg.envelope?.subject || "";
        const text = parsed.text || (parsed.html ? String(parsed.html).replace(/<[^>]+>/g, " ") : "");
        const code = extractCode(subject, text);
        if (!code) continue;
        candidates.push({
          code, subject,
          from: fromText.trim(),
          at: (parsed.date || msg.envelope?.date || new Date()).toISOString(),
          boxId: box.id, boxLabel: box.label, boxEmail: box.email
        });
      }
      if (!candidates.length) return null;
      candidates.sort((a, b) => new Date(b.at) - new Date(a.at));
      return candidates[0];
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => { try { client.close(); } catch {} });
  }
}

// Procura o codigo em TODAS as caixas (em paralelo) e devolve o mais recente encontrado.
async function fetchCode(boxes, opts) {
  const usable = boxes.filter((b) => b && b.password && b.email);
  const results = await Promise.allSettled(usable.map((b) => fetchCodeFromBox(b, opts)));
  const hits = results
    .filter((r) => r.status === "fulfilled" && r.value)
    .map((r) => r.value);
  if (!hits.length) return null;
  hits.sort((a, b) => new Date(b.at) - new Date(a.at));
  return hits[0];
}

module.exports = { fetchCode, fetchCodeFromBox, testMailbox, extractCode, marketplaceInfo, MARKETPLACES };
