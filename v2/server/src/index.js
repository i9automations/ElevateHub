const http = require("node:http");
const browserWorker = require("./browser-worker");
const { createStore } = require("./store");
const {
  now,
  parseCsv,
  canControlProfile
} = require("./shared");

const PORT = Number(process.env.PORT || 8787);
const store = createStore();

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

function errorStatus(error) {
  return Number(error.status || error.statusCode || error.code) || 500;
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

function routeParts(url) {
  return new URL(url, "http://localhost").pathname.split("/").filter(Boolean);
}

async function currentUser(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return store.currentUser(token);
}

async function requireUser(req, res) {
  const user = await currentUser(req);
  if (!user) {
    send(res, 401, { error: "Nao autenticado" });
    return null;
  }
  return user;
}

function requireAdmin(user, res) {
  if (user.role === "admin") return true;
  send(res, 403, { error: "Acesso exclusivo do admin" });
  return false;
}

async function handleProfileRoute(req, res, parts, user) {
  const profile = await store.getProfile(parts[2]);
  if (!profile) return send(res, 404, { error: "Perfil nao encontrado" });

  if (req.method === "PATCH" && parts.length === 3) {
    if (!requireAdmin(user, res)) return;
    const body = await readBody(req);
    const updated = await store.updateProfile(user, profile.id, body);
    return send(res, 200, { profile: updated });
  }

  if (req.method === "DELETE" && parts.length === 3) {
    if (!requireAdmin(user, res)) return;
    await browserWorker.stopBrowserSession(profile.id);
    await store.deleteProfile(user, profile.id);
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && parts[3] === "lock") {
    if (profile.lockedBy && profile.lockedBy !== user.id) {
      return send(res, 409, { error: "Perfil ja esta em uso" });
    }
    profile.lockedBy = user.id;
    profile.lockedAt = now();
    const saved = await store.saveProfile(profile);
    await store.audit(user, "profile.lock", profile.id);
    return send(res, 200, { profile: saved });
  }

  if (req.method === "POST" && parts[3] === "release") {
    if (profile.lockedBy && profile.lockedBy !== user.id && user.role !== "admin") {
      return send(res, 403, { error: "Perfil travado por outro usuario" });
    }
    await browserWorker.stopBrowserSession(profile.id);
    profile.lockedBy = null;
    profile.lockedAt = null;
    const saved = await store.saveProfile(profile);
    await store.audit(user, "profile.release", profile.id);
    return send(res, 200, { profile: saved });
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
    const saved = await store.saveProfile(profile);
    await store.audit(user, "session.start", profile.id);
    return send(res, 202, {
      profile: saved,
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

  if (parts[3] === "session") {
    if (!canControlProfile(profile, user)) {
      return send(res, 403, { error: "Perfil travado por outro usuario" });
    }
    const body = req.method === "POST" ? await readBody(req) : {};
    const action = parts[4];
    const handlers = {
      navigate: async () => {
        const session = await browserWorker.navigateBrowser(profile.id, body.url);
        if (session) await store.audit(user, "session.navigate", profile.id, { url: session.url });
        return session;
      },
      reload: () => browserWorker.reloadBrowser(profile.id),
      back: () => browserWorker.goBackBrowser(profile.id),
      forward: () => browserWorker.goForwardBrowser(profile.id),
      click: () => browserWorker.clickBrowser(profile.id, body.x, body.y),
      scroll: () => browserWorker.scrollBrowser(profile.id, body.deltaX, body.deltaY),
      type: () => browserWorker.typeBrowser(profile.id, body.text),
      key: () => browserWorker.pressBrowserKey(profile.id, body.key)
    };
    if (req.method === "POST" && handlers[action]) {
      const session = await handlers[action]();
      if (!session) return send(res, 404, { error: "Sessao remota nao iniciada" });
      return send(res, 200, { session });
    }
  }

  return send(res, 404, { error: "Rota nao encontrada" });
}

async function handle(req, res) {
  if (req.method === "OPTIONS") return send(res, 200, { ok: true });

  const parts = routeParts(req.url);

  try {
    if (req.method === "GET" && parts.join("/") === "api/health") {
      const storage = await store.health().catch((error) => ({ store: store.mode, error: error.message }));
      return send(res, 200, { ok: true, service: "contas-tiktok-v2", storage, at: now() });
    }

    if (req.method === "POST" && parts.join("/") === "api/auth/login") {
      const body = await readBody(req);
      const login = await store.login(body.email, body.password);
      if (!login) return send(res, 401, { error: "E-mail ou senha invalidos" });
      return send(res, 200, login);
    }

    const user = await requireUser(req, res);
    if (!user) return;

    if (req.method === "GET" && parts.join("/") === "api/me") {
      return send(res, 200, { user });
    }

    if (req.method === "GET" && parts.join("/") === "api/users") {
      if (!requireAdmin(user, res)) return;
      return send(res, 200, { users: await store.listUsers() });
    }

    if (req.method === "POST" && parts.join("/") === "api/users") {
      if (!requireAdmin(user, res)) return;
      const body = await readBody(req);
      const created = await store.createUser(user, body);
      return send(res, 201, created);
    }

    if (req.method === "GET" && parts.join("/") === "api/profiles") {
      return send(res, 200, { profiles: await store.listProfiles() });
    }

    if (req.method === "POST" && parts.join("/") === "api/profiles") {
      if (!requireAdmin(user, res)) return;
      const body = await readBody(req);
      const profile = await store.createProfile(user, body);
      return send(res, 201, { profile });
    }

    if (req.method === "POST" && parts.join("/") === "api/profiles/import") {
      if (!requireAdmin(user, res)) return;
      const body = await readBody(req);
      const rows = Array.isArray(body.rows) ? body.rows : parseCsv(body.csvText);
      return send(res, 200, await store.importProfiles(user, rows));
    }

    if (parts[0] === "api" && parts[1] === "profiles" && parts[2]) {
      return handleProfileRoute(req, res, parts, user);
    }

    if (req.method === "GET" && parts.join("/") === "api/audit") {
      if (!requireAdmin(user, res)) return;
      return send(res, 200, { audit: await store.listAudit() });
    }

    send(res, 404, { error: "Rota nao encontrada" });
  } catch (error) {
    send(res, errorStatus(error), { error: error.message || "Erro interno" });
  }
}

const server = http.createServer(handle);
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Contas TikTok V2 API rodando em http://127.0.0.1:${PORT} usando storage ${store.mode}`);
});
