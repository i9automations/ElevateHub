const crypto = require("node:crypto");

function now() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const candidate = hashPassword(password, salt).split(":")[1];
  return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(hash, "hex"));
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role
  };
}

function profileDto(users, profile) {
  const lockedBy = profile.lockedBy
    ? users.find((user) => user.id === profile.lockedBy)
    : null;
  return {
    ...profile,
    lockedByName: lockedBy?.name || null
  };
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeTags(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value || "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function applyProfileFields(profile, body) {
  if (body.name !== undefined) profile.name = String(body.name || "").trim();
  if (body.tiktokEmail !== undefined) profile.tiktokEmail = normalizeEmail(body.tiktokEmail);
  if (body.mailboxEmail !== undefined) profile.mailboxEmail = normalizeEmail(body.mailboxEmail);
  if (body.notes !== undefined) profile.notes = String(body.notes || "").trim();
  if (body.tags !== undefined) profile.tags = normalizeTags(body.tags);
  profile.updatedAt = now();
  return profile;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const input = String(text || "").replace(/^\uFEFF/, "");
  const firstLine = input.split(/\r?\n/, 1)[0] || "";
  const delimiterCounts = {
    ",": (firstLine.match(/,/g) || []).length,
    ";": (firstLine.match(/;/g) || []).length,
    "\t": (firstLine.match(/\t/g) || []).length
  };
  const delimiter = Object.entries(delimiterCounts).sort((a, b) => b[1] - a[1])[0][0];

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    const next = input[index + 1];
    if (quoted) {
      if (char === "\"" && next === "\"") {
        field += "\"";
        index += 1;
      } else if (char === "\"") {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === "\"") {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field.trim());
      field = "";
    } else if (char === "\n") {
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  if (!rows.length) return [];

  const headers = rows.shift().map((header) => slugHeader(header));
  return rows
    .filter((item) => item.some(Boolean))
    .map((item) => Object.fromEntries(headers.map((header, index) => [header, item[index] || ""])));
}

function slugHeader(value) {
  return String(value || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function pick(row, names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== "") return row[name];
  }
  return "";
}

function profileFromImportRow(row) {
  const name = String(pick(row, ["name", "nome", "cliente", "perfil", "marca"]) || "").trim();
  const email = normalizeEmail(pick(row, ["tiktok_email", "email_tiktok", "email", "alias", "e_mail"]));
  const mailboxEmail = normalizeEmail(pick(row, ["mailbox_email", "caixa_email", "email_principal", "caixa", "hostinger"]));
  const tags = normalizeTags(pick(row, ["tags", "tag", "categoria", "grupo"]));
  const notes = String(pick(row, ["notes", "observacoes", "obs", "nota"]) || "").trim();
  const fallbackName = email ? email.split("@")[0] : "";
  return {
    name: name || fallbackName,
    tiktokEmail: email,
    mailboxEmail,
    tags,
    notes
  };
}

function canControlProfile(profile, user) {
  return !profile.lockedBy || profile.lockedBy === user.id || user.role === "admin";
}

module.exports = {
  now,
  id,
  hashPassword,
  verifyPassword,
  publicUser,
  profileDto,
  normalizeEmail,
  normalizeTags,
  applyProfileFields,
  parseCsv,
  profileFromImportRow,
  canControlProfile
};
