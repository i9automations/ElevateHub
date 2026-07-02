const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const browserWorker = require("./browser-worker");

const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = path.join(__dirname, "..", "data");
const DB_FILE = process.env.V2_DB_FILE || path.join(DATA_DIR, "db.json");
const TOKEN_TTL_MS = 1000 * 60 * 60 * 12;
const sessions = new Map();

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

function defaultDb() {
  const adminEmail = process.env.V2_ADMIN_EMAIL || "admin@elevate.local";
  const adminPassword = process.env.V2_ADMIN_PASSWORD || "admin123";
  return {
    users: [{
      id: "usr_admin",
      name: "Admin",
      email: adminEmail,
      role: "admin",
      passwordHash: hashPassword(adminPassword),
      createdAt: now()
    }],
    profiles: [{
      id: "prf_demo",
      name: "Petala Beauty",
      tiktokEmail: "petalabeauty@elevateecom.com.br",
      tags: ["Demo", "Beauty"],
      sessionState: "ready",
      lockedBy: null,
      lockedAt: null,
      lastOpenedAt: null,
      createdAt: now()
    }],
    audit: []
  };
}

function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    const db = defaultDb();
    saveDb(db);
    return db;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function saveDb(db) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
}

function audit(db, user, action, targetId, meta = {}) {
  db.audit.unshift({
    id: id("aud"),
    at: now(),
    userId: user?.id || null,
    userName: user?.name || "sistema",
    action,
    targetId,
    meta
  });
  db.audit = db.audit.slice(0, 500);
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role
  };
}

function profileDto(db, profile) {
  const lockedBy = profile.lockedBy
    ? db.users.find((user) => user.id === profile.lockedBy)
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

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Payload muito grande"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("JSON invalido"));
      }
    });
  });
}

function issueToken(user) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, {
    userId: user.id,
    expiresAt: Date.now() + TOKEN_TTL_MS
  });
  return token;
}

function currentUser(req, db) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) return null;
  return db.users.find((user) => user.id === session.userId) || null;
}

function requireUser(req, res, db) {
  const user = currentUser(req, db);
  if (!user) {
    send(res, 401, { error: "Nao autenticado" });
    return null;
  }
  return user;
}

function routeParts(url) {
  return new URL(url, "http://localhost").pathname.split("/").filter(Boolean);
}

async function handle(req, res) {
  if (req.method === "OPTIONS") return send(res, 200, { ok: true });

  const db = loadDb();
  const parts = routeParts(req.url);

  try {
    if (req.method === "GET" && parts.join("/") === "api/health") {
      return send(res, 200, { ok: true, service: "contas-tiktok-v2", at: now() });
    }

    if (req.method === "POST" && parts.join("/") === "api/auth/login") {
      const body = await readBody(req);
      const email = String(body.email || "").trim().toLowerCase();
      const user = db.users.find((item) => item.email.toLowerCase() === email);
      if (!user || !verifyPassword(String(body.password || ""), user.passwordHash)) {
        return send(res, 401, { error: "E-mail ou senha invalidos" });
      }
      const token = issueToken(user);
      audit(db, user, "auth.login", user.id);
      saveDb(db);
      return send(res, 200, { token, user: publicUser(user) });
    }

    const user = requireUser(req, res, db);
    if (!user) return;

    if (req.method === "GET" && parts.join("/") === "api/me") {
      return send(res, 200, { user: publicUser(user) });
    }

    if (req.method === "GET" && parts.join("/") === "api/users") {
      return send(res, 200, { users: db.users.map(publicUser) });
    }

    if (req.method === "POST" && parts.join("/") === "api/users") {
      if (user.role !== "admin") return send(res, 403, { error: "Apenas admin pode criar usuarios" });
      const body = await readBody(req);
      const name = String(body.name || "").trim();
      const email = normalizeEmail(body.email);
      if (!name || !email) return send(res, 400, { error: "Nome e e-mail sao obrigatorios" });
      if (db.users.some((item) => item.email.toLowerCase() === email)) {
        return send(res, 409, { error: "Usuario ja cadastrado" });
      }
      const temporaryPassword = String(body.password || "").trim() || crypto.randomBytes(6).toString("base64url");
      const created = {
        id: id("usr"),
        name,
        email,
        role: body.role === "admin" ? "admin" : "operator",
        passwordHash: hashPassword(temporaryPassword),
        createdAt: now()
      };
      db.users.push(created);
      audit(db, user, "user.create", created.id, { email: created.email, role: created.role });
      saveDb(db);
      return send(res, 201, { user: publicUser(created), temporaryPassword });
    }

    if (req.method === "GET" && parts.join("/") === "api/profiles") {
      return send(res, 200, { profiles: db.profiles.map((profile) => profileDto(db, profile)) });
    }

    if (req.method === "POST" && parts.join("/") === "api/profiles") {
      const body = await readBody(req);
      const name = String(body.name || "").trim();
      if (!name) return send(res, 400, { error: "Nome vazio" });
      const profile = {
        id: id("prf"),
        name,
        tiktokEmail: normalizeEmail(body.tiktokEmail),
        mailboxEmail: normalizeEmail(body.mailboxEmail),
        notes: String(body.notes || "").trim(),
        tags: normalizeTags(body.tags),
        sessionState: "empty",
        lockedBy: null,
        lockedAt: null,
        lastOpenedAt: null,
        createdAt: now()
      };
      db.profiles.push(profile);
      audit(db, user, "profile.create", profile.id, { name });
      saveDb(db);
      return send(res, 201, { profile: profileDto(db, profile) });
    }

    if (req.method === "POST" && parts.join("/") === "api/profiles/import") {
      const body = await readBody(req);
      const rows = Array.isArray(body.rows) ? body.rows : parseCsv(body.csvText);
      const result = { created: 0, updated: 0, skipped: 0 };
      const changedProfiles = [];

      for (const rawRow of rows) {
        const incoming = profileFromImportRow(rawRow);
        if (!incoming.name) {
          result.skipped += 1;
          continue;
        }
        const existing = incoming.tiktokEmail
          ? db.profiles.find((profile) => normalizeEmail(profile.tiktokEmail) === incoming.tiktokEmail)
          : null;
        if (existing) {
          applyProfileFields(existing, incoming);
          result.updated += 1;
          changedProfiles.push(existing);
        } else {
          const profile = {
            id: id("prf"),
            name: incoming.name,
            tiktokEmail: incoming.tiktokEmail,
            mailboxEmail: incoming.mailboxEmail,
            notes: incoming.notes,
            tags: incoming.tags,
            sessionState: "empty",
            lockedBy: null,
            lockedAt: null,
            lastOpenedAt: null,
            createdAt: now()
          };
          db.profiles.push(profile);
          result.created += 1;
          changedProfiles.push(profile);
        }
      }

      audit(db, user, "profile.import", null, result);
      saveDb(db);
      return send(res, 200, {
        result,
        profiles: changedProfiles.map((profile) => profileDto(db, profile))
      });
    }

    if (parts[0] === "api" && parts[1] === "profiles" && parts[2]) {
      const profile = db.profiles.find((item) => item.id === parts[2]);
      if (!profile) return send(res, 404, { error: "Perfil nao encontrado" });

      if (req.method === "PATCH" && parts.length === 3) {
        const body = await readBody(req);
        applyProfileFields(profile, body);
        if (!profile.name) return send(res, 400, { error: "Nome vazio" });
        audit(db, user, "profile.update", profile.id, { name: profile.name });
        saveDb(db);
        return send(res, 200, { profile: profileDto(db, profile) });
      }

      if (req.method === "DELETE" && parts.length === 3) {
        if (user.role !== "admin") return send(res, 403, { error: "Apenas admin pode remover perfis" });
        await browserWorker.stopBrowserSession(profile.id);
        db.profiles = db.profiles.filter((item) => item.id !== profile.id);
        audit(db, user, "profile.delete", profile.id, { name: profile.name });
        saveDb(db);
        return send(res, 200, { ok: true });
      }

      if (req.method === "POST" && parts[3] === "lock") {
        if (profile.lockedBy && profile.lockedBy !== user.id) {
          return send(res, 409, { error: "Perfil ja esta em uso" });
        }
        profile.lockedBy = user.id;
        profile.lockedAt = now();
        audit(db, user, "profile.lock", profile.id);
        saveDb(db);
        return send(res, 200, { profile: profileDto(db, profile) });
      }

      if (req.method === "POST" && parts[3] === "release") {
        if (profile.lockedBy && profile.lockedBy !== user.id && user.role !== "admin") {
          return send(res, 403, { error: "Perfil travado por outro usuario" });
        }
        await browserWorker.stopBrowserSession(profile.id);
        profile.lockedBy = null;
        profile.lockedAt = null;
        audit(db, user, "profile.release", profile.id);
        saveDb(db);
        return send(res, 200, { profile: profileDto(db, profile) });
      }

      if (req.method === "POST" && parts[3] === "session" && parts[4] === "start") {
        if (profile.lockedBy && profile.lockedBy !== user.id) {
          return send(res, 409, { error: "Perfil ja esta em uso" });
        }
        profile.lockedBy = user.id;
        profile.lockedAt = profile.lockedAt || now();
        profile.lastOpenedAt = now();
        const browserSession = await browserWorker.startBrowserSession(profile, user);
        profile.sessionState = browserSession.state === "running" ? "ready" : "queued";
        audit(db, user, "session.start", profile.id);
        saveDb(db);
        return send(res, 202, {
          profile: profileDto(db, profile),
          session: browserSession
        });
      }

      if (req.method === "GET" && parts[3] === "session" && parts[4] === "frame") {
        if (!canControlProfile(profile, user)) {
          return send(res, 403, { error: "Perfil travado por outro usuario" });
        }
        const frame = await browserWorker.getBrowserFrame(profile.id);
        if (!frame) return send(res, 404, { error: "Sessao remota nao iniciada" });
        return send(res, 200, frame);
      }

      if (req.method === "GET" && parts[3] === "session") {
        return send(res, 200, { session: browserWorker.getBrowserSession(profile.id) });
      }

      if (req.method === "POST" && parts[3] === "session" && parts[4] === "navigate") {
        if (!canControlProfile(profile, user)) {
          return send(res, 403, { error: "Perfil travado por outro usuario" });
        }
        const body = await readBody(req);
        const session = await browserWorker.navigateBrowser(profile.id, body.url);
        if (!session) return send(res, 404, { error: "Sessao remota nao iniciada" });
        audit(db, user, "session.navigate", profile.id, { url: session.url });
        saveDb(db);
        return send(res, 200, { session });
      }

      if (req.method === "POST" && parts[3] === "session" && parts[4] === "reload") {
        if (!canControlProfile(profile, user)) {
          return send(res, 403, { error: "Perfil travado por outro usuario" });
        }
        const session = await browserWorker.reloadBrowser(profile.id);
        if (!session) return send(res, 404, { error: "Sessao remota nao iniciada" });
        return send(res, 200, { session });
      }

      if (req.method === "POST" && parts[3] === "session" && parts[4] === "back") {
        if (!canControlProfile(profile, user)) {
          return send(res, 403, { error: "Perfil travado por outro usuario" });
        }
        const session = await browserWorker.goBackBrowser(profile.id);
        if (!session) return send(res, 404, { error: "Sessao remota nao iniciada" });
        return send(res, 200, { session });
      }

      if (req.method === "POST" && parts[3] === "session" && parts[4] === "forward") {
        if (!canControlProfile(profile, user)) {
          return send(res, 403, { error: "Perfil travado por outro usuario" });
        }
        const session = await browserWorker.goForwardBrowser(profile.id);
        if (!session) return send(res, 404, { error: "Sessao remota nao iniciada" });
        return send(res, 200, { session });
      }

      if (req.method === "POST" && parts[3] === "session" && parts[4] === "click") {
        if (!canControlProfile(profile, user)) {
          return send(res, 403, { error: "Perfil travado por outro usuario" });
        }
        const body = await readBody(req);
        const session = await browserWorker.clickBrowser(profile.id, body.x, body.y);
        if (!session) return send(res, 404, { error: "Sessao remota nao iniciada" });
        return send(res, 200, { session });
      }

      if (req.method === "POST" && parts[3] === "session" && parts[4] === "scroll") {
        if (!canControlProfile(profile, user)) {
          return send(res, 403, { error: "Perfil travado por outro usuario" });
        }
        const body = await readBody(req);
        const session = await browserWorker.scrollBrowser(profile.id, body.deltaX, body.deltaY);
        if (!session) return send(res, 404, { error: "Sessao remota nao iniciada" });
        return send(res, 200, { session });
      }

      if (req.method === "POST" && parts[3] === "session" && parts[4] === "type") {
        if (!canControlProfile(profile, user)) {
          return send(res, 403, { error: "Perfil travado por outro usuario" });
        }
        const body = await readBody(req);
        const session = await browserWorker.typeBrowser(profile.id, body.text);
        if (!session) return send(res, 404, { error: "Sessao remota nao iniciada" });
        return send(res, 200, { session });
      }

      if (req.method === "POST" && parts[3] === "session" && parts[4] === "key") {
        if (!canControlProfile(profile, user)) {
          return send(res, 403, { error: "Perfil travado por outro usuario" });
        }
        const body = await readBody(req);
        const session = await browserWorker.pressBrowserKey(profile.id, body.key);
        if (!session) return send(res, 404, { error: "Sessao remota nao iniciada" });
        return send(res, 200, { session });
      }
    }

    if (req.method === "GET" && parts.join("/") === "api/audit") {
      return send(res, 200, { audit: db.audit.slice(0, 100) });
    }

    send(res, 404, { error: "Rota nao encontrada" });
  } catch (error) {
    send(res, 500, { error: error.message || "Erro interno" });
  }
}

const server = http.createServer(handle);
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Contas TikTok V2 API rodando em http://127.0.0.1:${PORT}`);
});
