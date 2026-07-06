// Configuracao central das caixas de e-mail (Hostinger) que recebem os codigos.
// Guardado em arquivo unico criptografado (senhas nunca em texto puro no disco).
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { encrypt, decrypt } = require("./secret");

const DATA_DIR = process.env.V2_DATA_DIR || "/opt/contas-tiktok-v2/shared/data";
const FILE = process.env.V2_MAILBOXES_FILE || path.join(DATA_DIR, "mailboxes.enc");

function normalizeBox(input, existing) {
  const email = String(input.email || "").trim().toLowerCase();
  // senha em branco na edicao = manter a que ja existe
  const password = input.password ? String(input.password) : (existing?.password || "");
  return {
    id: existing?.id || input.id || `mbx_${crypto.randomBytes(6).toString("hex")}`,
    label: String(input.label || email || "Caixa").trim(),
    email,
    user: String(input.user || email).trim().toLowerCase(),
    host: String(input.host || "imap.hostinger.com").trim(),
    port: Number(input.port) || 993,
    secure: input.secure !== false,
    password
  };
}

async function loadMailboxes() {
  let raw;
  try {
    raw = await fsp.readFile(FILE, "utf8");
  } catch {
    return []; // arquivo ainda nao existe = nenhuma caixa cadastrada
  }
  try {
    const list = JSON.parse(decrypt(raw));
    return Array.isArray(list) ? list : [];
  } catch {
    // Arquivo existe mas nao decifrou (chave mudou/corrompeu). NAO retorna [] em
    // silencio (o admin veria "sem caixas" e reescreveria por cima, perdendo tudo).
    const err = new Error("Nao consegui ler as caixas (a chave de seguranca do servidor pode ter mudado). As senhas precisam ser cadastradas de novo.");
    err.status = 500;
    err.code = "MAILBOX_DECRYPT";
    throw err;
  }
}

// Versao que nunca lanca (para merge no PUT): se nao der pra ler, trata como vazio.
async function loadMailboxesSafe() {
  try { return await loadMailboxes(); } catch { return []; }
}

async function saveMailboxes(list) {
  const json = JSON.stringify(list);
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.${Date.now()}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  await fsp.writeFile(tmp, encrypt(json), { mode: 0o600 });
  await fsp.rename(tmp, FILE);
}

// versao para a UI: SEM senha, so indica se ja tem uma cadastrada
function publicMailbox(b) {
  return {
    id: b.id, label: b.label, email: b.email, user: b.user,
    host: b.host, port: b.port, secure: b.secure !== false,
    hasPassword: !!b.password
  };
}

module.exports = { loadMailboxes, loadMailboxesSafe, saveMailboxes, normalizeBox, publicMailbox, FILE };
