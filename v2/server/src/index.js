const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

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

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
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
        tiktokEmail: String(body.tiktokEmail || "").trim().toLowerCase(),
        tags: Array.isArray(body.tags) ? body.tags.map(String).filter(Boolean) : [],
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

    if (parts[0] === "api" && parts[1] === "profiles" && parts[2]) {
      const profile = db.profiles.find((item) => item.id === parts[2]);
      if (!profile) return send(res, 404, { error: "Perfil nao encontrado" });

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
        profile.sessionState = profile.sessionState === "empty" ? "queued" : profile.sessionState;
        audit(db, user, "session.start", profile.id);
        saveDb(db);
        return send(res, 202, {
          profile: profileDto(db, profile),
          session: {
            id: id("ses"),
            state: profile.sessionState,
            streamUrl: null,
            message: "Worker de navegador remoto sera plugado nesta etapa."
          }
        });
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
