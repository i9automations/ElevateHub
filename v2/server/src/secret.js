// Criptografia em repouso (AES-256-GCM) para segredos como senhas das caixas de e-mail.
// A chave vem de V2_SECRET_KEY (base64, 32 bytes) OU de um arquivo persistente que e
// gerado sozinho na 1a vez (chmod 600). O arquivo fica em shared/ (sobrevive a deploys).
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DATA_DIR = process.env.V2_DATA_DIR || "/opt/contas-tiktok-v2/shared/data";
const KEY_FILE = process.env.V2_SECRET_KEY_FILE || path.join(DATA_DIR, "secret.key");

let cachedKey = null;
function getKey() {
  if (cachedKey) return cachedKey;
  const envKey = process.env.V2_SECRET_KEY;
  if (envKey) {
    const buf = Buffer.from(envKey, "base64");
    if (buf.length === 32) { cachedKey = buf; return cachedKey; }
  }
  try {
    const raw = fs.readFileSync(KEY_FILE, "utf8").trim();
    const buf = Buffer.from(raw, "base64");
    if (buf.length === 32) { cachedKey = buf; return cachedKey; }
  } catch { /* gera abaixo */ }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
  fs.writeFileSync(KEY_FILE, key.toString("base64"), { mode: 0o600 });
  try { fs.chmodSync(KEY_FILE, 0o600); } catch { /* Windows ignora */ }
  cachedKey = key;
  return cachedKey;
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`;
}

function decrypt(payload) {
  const s = String(payload || "");
  if (!s.startsWith("v1:")) return "";
  const [, ivB, tagB, dataB] = s.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB, "base64"));
  decipher.setAuthTag(Buffer.from(tagB, "base64"));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataB, "base64")), decipher.final()]);
  return dec.toString("utf8");
}

module.exports = { encrypt, decrypt, getKey };
