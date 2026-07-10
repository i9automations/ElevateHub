const http = require("node:http");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const browserWorker = require("./browser-worker");
const { createStore } = require("./store");
const { encrypt, decrypt } = require("./secret");
const { loadMailboxes, loadMailboxesSafe, saveMailboxes, normalizeBox, publicMailbox } = require("./mailboxes");
const { fetchCode, testMailbox, marketplaceInfo } = require("./imap-code");
const {
  now,
  parseCsv,
  canControlProfile
} = require("./shared");

const PORT = Number(process.env.PORT || 8787);
const store = createStore();

// Etapa 2 (modelo Dolphin): sessao compartilhada — cookies por perfil em disco.
const COOKIES_DIR = process.env.V2_COOKIES_DIR
  || path.join(process.env.V2_DATA_DIR || "/opt/contas-tiktok-v2/shared/data", "cookies");

function cookiesFile(profileId) {
  const safe = String(profileId || "").replace(/[^a-z0-9._-]/gi, "_");
  return path.join(COOKIES_DIR, `${safe}.json`);
}

// Cookies de LOGIN conhecidos por marketplace. Se a sessao guardada tem algum
// destes e a que chega perdeu TODOS, e uma leitura degradada (nao um logout real)
// -> a trava anti-regressao no PUT recusa gravar, pra conta nao "cair" sozinha.
const AUTH_COOKIE_NAMES = new Set([
  // TikTok / TikTok Shop
  "sessionid", "sessionid_ss", "sid_tt", "sid_guard", "uid_tt", "uid_tt_ss", "cmpl_token",
  // Mercado Livre
  "orguseridp", "ssid",
  // Shopee
  "spc_ec", "spc_st", "spc_u",
  // Amazon
  "at-main", "sess-at-main", "x-main", "sess-id"
]);
function hasAuthCookie(cookies) {
  return (cookies || []).some(
    (c) => c && c.name && c.value && AUTH_COOKIE_NAMES.has(String(c.name).toLowerCase())
  );
}
// Le a sessao guardada (decifra) p/ comparar com a que chega. null = sem arquivo
// ou ilegivel (nesses casos nao serve de base de comparacao e o PUT segue normal).
async function readStoredCookies(profileId) {
  let raw;
  try {
    raw = await fsp.readFile(cookiesFile(profileId), "utf8");
  } catch {
    return null;
  }
  try {
    const json = raw.startsWith("v1:") ? decrypt(raw) : raw;
    const parsed = JSON.parse(json);
    return Array.isArray(parsed.cookies) ? parsed.cookies : [];
  } catch {
    return null;
  }
}

// Sessoes ativas (quem esta com cada perfil aberto AGORA) em memoria.
// Chaveado por SESSAO (hash do token) e nao por usuario, porque a equipe pode
// compartilhar a mesma conta -> cada PC/login tem um token proprio.
// Varias pessoas podem abrir a mesma conta; a UI avisa quem mais esta nela.
// Expira sozinho (evita "trava presa" se um PC travar/desligar).
const activeSessions = new Map(); // profileId -> Map(sessionKey -> { name, at })
const SESSION_TTL_MS = 15 * 60 * 1000;
const releasedAt = new Map(); // profileId -> Map(key -> ts): "tombstone" p/ ignorar batida atrasada logo apos fechar
const RELEASE_GRACE_MS = 8000;
let cookieTmpSeq = 0; // sufixo unico p/ arquivos temporarios de cookies (escrita atomica)

// Grava de forma atomica (tmp unico + rename). No Windows, rename concorrente p/ o mesmo
// destino pode dar EPERM/EACCES/EEXIST/EBUSY -> tenta de novo com um pequeno intervalo.
// No Linux (producao) rename ja e atomico; o retry so ajuda em casos raros.
async function atomicWriteFile(dest, data) {
  const tmp = `${dest}.${Date.now()}.${cookieTmpSeq++}.tmp`;
  await fsp.writeFile(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      await fsp.rename(tmp, dest);
      return;
    } catch (err) {
      const retryable = ["EPERM", "EACCES", "EEXIST", "EBUSY"].includes(err.code);
      if (!retryable || attempt >= 6) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
    }
  }
}

function sessionKey(req) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return "anon";
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 24);
}
function justReleased(profileId, key) {
  const m = releasedAt.get(profileId);
  const ts = m && m.get(key);
  if (!ts) return false;
  if (Date.now() - ts > RELEASE_GRACE_MS) { m.delete(key); return false; }
  return true;
}
// heartbeat=true: batida automatica da sincronizacao (ignora se o perfil acabou de ser fechado, evita
// "ressuscitar" a presenca de um navegador ja fechado). Sem heartbeat = abertura explicita, sempre registra.
function touchSession(profileId, key, name, heartbeat) {
  if (heartbeat && justReleased(profileId, key)) return;
  let sessions = activeSessions.get(profileId);
  if (!sessions) { sessions = new Map(); activeSessions.set(profileId, sessions); }
  sessions.set(key, { name: name || "Equipe", at: Date.now() });
  const rm = releasedAt.get(profileId); // abriu de novo -> limpa o tombstone
  if (rm) rm.delete(key);
}
function dropSession(profileId, key) {
  const sessions = activeSessions.get(profileId);
  if (sessions) { sessions.delete(key); if (!sessions.size) activeSessions.delete(profileId); }
  let m = releasedAt.get(profileId);
  if (!m) { m = new Map(); releasedAt.set(profileId, m); }
  m.set(key, Date.now());
}
function sessionEntries(profileId) {
  const sessions = activeSessions.get(profileId);
  if (!sessions) return [];
  const now = Date.now();
  const list = [];
  for (const [key, info] of sessions) {
    if (now - info.at > SESSION_TTL_MS) sessions.delete(key);
    else list.push({ key, name: info.name });
  }
  if (!sessions.size) activeSessions.delete(profileId);
  return list;
}
function hasSession(profileId, key) {
  return sessionEntries(profileId).some((entry) => entry.key === key);
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS"
  });
  res.end(body);
}

function errorStatus(error) {
  const code = Number(error.status || error.statusCode) || 500;
  return code >= 100 && code <= 599 ? code : 500;
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
    // Equipe (operador) edita nome/email/responsavel/notas + a caixa Hostinger
    // (alias do cliente, necessario p/ pegar o codigo). Tags e mover de pasta so admin.
    const body = await readBody(req);
    if (user.role !== "admin") {
      delete body.tags;
      delete body.squad;
    }
    const updated = await store.updateProfile(user, profile.id, body);
    return send(res, 200, { profile: updated });
  }

  if (req.method === "DELETE" && parts.length === 3) {
    // Equipe (operador) pode excluir perfis; areas de admin seguem protegidas.
    await browserWorker.stopBrowserSession(profile.id);
    await store.deleteProfile(user, profile.id);
    return send(res, 200, { ok: true });
  }

  if (req.method === "GET" && parts[3] === "cookies") {
    // So quem esta com o perfil aberto (ou admin) le a sessao. Barra varredura
    // em massa; o app "abre" (lock) antes de baixar, entao o fluxo normal funciona.
    if (user.role !== "admin" && !hasSession(profile.id, sessionKey(req))) {
      return send(res, 409, { error: "Abra o perfil antes de baixar a sessao." });
    }
    await store.audit(user, "profile.cookies.read", profile.id).catch(() => {});
    let raw;
    try {
      raw = await fsp.readFile(cookiesFile(profile.id), "utf8");
    } catch {
      return send(res, 200, { cookies: [] }); // arquivo ausente = sem sessao (normal)
    }
    try {
      // Arquivos novos vem cifrados ("v1:"); os antigos (texto puro) ainda leem
      // direto e serao re-gravados cifrados na proxima sincronizacao.
      const json = raw.startsWith("v1:") ? decrypt(raw) : raw;
      const parsed = JSON.parse(json);
      return send(res, 200, { cookies: Array.isArray(parsed.cookies) ? parsed.cookies : [] });
    } catch (e) {
      // Cifrado mas nao decifrou = chave mudou/corrompeu -> loga (senao a sessao
      // some em silencio e o app mostra "logada" sem cookies).
      if (raw.startsWith("v1:")) console.warn(`[cookies] falha ao descriptografar perfil ${profile.id}: ${e.message}`);
      return send(res, 200, { cookies: [] });
    }
  }

  if (req.method === "PUT" && parts[3] === "cookies") {
    // Um PUT so acontece com o navegador aberto no PC. Registrar/renovar a
    // presenca aqui serve de heartbeat (mantem viva enquanto aberto) e de
    // auto-recuperacao caso o servidor tenha reiniciado e perdido a memoria.
    touchSession(profile.id, sessionKey(req), user.name, true);
    const body = await readBody(req);
    const cookies = Array.isArray(body.cookies) ? body.cookies : [];

    // TRAVA ANTI-REGRESSAO: a sincronizacao roda a cada 8s com o navegador aberto.
    // Uma leitura vazia/degradada (navegacao, redirect, checagem de seguranca, ou o
    // Chrome fechando) NAO pode apagar uma sessao boa -> senao a conta "cai" e o
    // estado vazio ainda se espalha pros outros PCs. Guarda a sessao existente.
    const stored = await readStoredCookies(profile.id);
    const storedCount = stored ? stored.length : 0;
    if (storedCount > 0) {
      // 1) vazio nunca substitui uma sessao que existe
      if (cookies.length === 0) {
        return send(res, 200, { ok: true, count: storedCount, skipped: "empty-guard" });
      }
      // 2) a que chega perdeu TODOS os cookies de login que a guardada tinha = degradada
      if (hasAuthCookie(stored) && !hasAuthCookie(cookies)) {
        console.warn(`[cookies] PUT degradado ignorado (perdeu login) perfil ${profile.id}: ${cookies.length} cookies`);
        return send(res, 200, { ok: true, count: storedCount, skipped: "auth-guard" });
      }
    }

    await fsp.mkdir(COOKIES_DIR, { recursive: true });
    // Escrita atomica: 2 pessoas na mesma conta gravam a cada 8s. writeFile direto pode
    // intercalar e corromper o JSON (-> sessao perdida). tmp unico + rename resolve.
    // CRIPTOGRAFADO em repouso: a sessao (cookies) e o dado mais sensivel.
    await atomicWriteFile(cookiesFile(profile.id), encrypt(JSON.stringify({ cookies, updatedAt: now() })));
    // Sessao salva = conta logada. Reflete no status do perfil. RELE fresco antes de
    // gravar: o saveProfile regrava o objeto inteiro; se usasse o snapshot lido no
    // inicio do request, uma edicao concorrente (renomear/tags) seria sobrescrita.
    // Reler + so mexer em sessionState reduz a janela a alguns ms.
    const nowReady = cookies.length > 0;
    if ((profile.sessionState === "ready") !== nowReady) {
      const fresh = await store.getProfile(profile.id);
      if (fresh && (fresh.sessionState === "ready") !== nowReady) {
        fresh.sessionState = nowReady ? "ready" : "empty";
        await store.saveProfile(fresh);
      }
    }
    return send(res, 200, { ok: true, count: cookies.length });
  }

  if (req.method === "POST" && parts[3] === "lock") {
    // Nao bloqueia mais: registra que este usuario abriu e avisa quem mais esta.
    const key = sessionKey(req);
    touchSession(profile.id, key, user.name);
    const inUseBy = sessionEntries(profile.id).filter((e) => e.key !== key).map((e) => e.name);
    await store.audit(user, "profile.open", profile.id).catch(() => {});
    return send(res, 200, { ok: true, inUseBy });
  }

  if (req.method === "POST" && parts[3] === "release") {
    dropSession(profile.id, sessionKey(req));
    await browserWorker.stopBrowserSession(profile.id).catch(() => {});
    // Solta a trava do fluxo remoto (session/start seta lockedBy). Sem isso o
    // perfil ficava "em uso por" para sempre e travava os outros usuarios.
    if (profile.lockedBy) {
      profile.lockedBy = null;
      profile.lockedAt = null;
      await store.saveProfile(profile).catch(() => {});
    }
    return send(res, 200, { ok: true });
  }

  // Pega o codigo de verificacao (TikTok/ML/Shopee/Amazon) nas caixas Hostinger,
  // procurando pelo alias do cliente (mailboxEmail do perfil).
  if (req.method === "POST" && parts[3] === "code") {
    const body = await readBody(req);
    const marketplace = String(body.marketplace || "").toLowerCase() || null;
    if (marketplace && !marketplaceInfo(marketplace)) {
      return send(res, 400, { error: "Marketplace invalido." });
    }
    // Usa a caixa Hostinger (alias) se preenchida; senao cai pro e-mail de login
    // do perfil, que normalmente e o MESMO endereco que recebe o codigo.
    const alias = String(profile.mailboxEmail || profile.tiktokEmail || "").trim();
    if (!alias) {
      return send(res, 422, { error: "Este perfil nao tem e-mail cadastrado. Preencha o e-mail de login em Editar." });
    }
    const boxes = await loadMailboxes();
    if (!boxes.some((b) => b.password)) {
      return send(res, 409, { error: "Nenhuma caixa de e-mail configurada. Peca ao admin em Ajustes." });
    }
    const sinceMinutes = Math.min(Math.max(Number(body.sinceMinutes) || 30, 5), 240);
    const hit = await fetchCode(boxes, { alias, marketplace, sinceMinutes });
    await store.audit(user, "profile.code.fetch", profile.id, { marketplace, found: !!hit }).catch(() => {});
    if (!hit) {
      return send(res, 404, { error: "Nenhum codigo recente encontrado para esta conta." });
    }
    return send(res, 200, { code: hit.code, box: hit.boxLabel, boxEmail: hit.boxEmail, subject: hit.subject, from: hit.from, at: hit.at });
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

    // Renova a sessao usando o cracha de renovacao (sem senha). Fica ANTES do
    // requireUser porque o token de acesso pode estar vencido justamente aqui.
    if (req.method === "POST" && parts.join("/") === "api/auth/refresh") {
      const body = await readBody(req);
      const renewed = await store.refresh(body.refreshToken).catch(() => null);
      if (!renewed) return send(res, 401, { error: "Sessao expirada. Faca login de novo." });
      return send(res, 200, renewed);
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
      const profiles = await store.listProfiles();
      for (const profile of profiles) {
        const users = sessionEntries(profile.id);
        profile.inUse = users.length > 0;
        profile.inUseBy = users.map((u) => u.name);
      }
      return send(res, 200, { profiles });
    }

    if (req.method === "POST" && parts.join("/") === "api/profiles") {
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
      return await handleProfileRoute(req, res, parts, user);
    }

    if (req.method === "GET" && parts.join("/") === "api/audit") {
      if (!requireAdmin(user, res)) return;
      return send(res, 200, { audit: await store.listAudit() });
    }

    // --- Caixas de e-mail (Hostinger) para pegar codigos. ---
    // Liberado p/ qualquer usuario autenticado (a equipe usa a conta compartilhada,
    // que nao e admin) - autorizado pelo dono. A senha nunca volta pra tela (mascarada).
    if (req.method === "GET" && parts.join("/") === "api/mailboxes") {
      const boxes = await loadMailboxes();
      return send(res, 200, { mailboxes: boxes.map(publicMailbox) });
    }

    if (req.method === "PUT" && parts.join("/") === "api/mailboxes") {
      const body = await readBody(req);
      const incoming = Array.isArray(body.mailboxes) ? body.mailboxes : [];
      const existing = await loadMailboxesSafe(); // chave quebrada nao impede recadastro
      const byId = new Map(existing.map((b) => [b.id, b]));
      const saved = incoming
        .filter((b) => String(b.email || "").trim())
        .map((b) => normalizeBox(b, byId.get(b.id)));
      await saveMailboxes(saved);
      await store.audit(user, "mailboxes.update", null, { count: saved.length }).catch(() => {});
      return send(res, 200, { mailboxes: saved.map(publicMailbox) });
    }

    if (req.method === "POST" && parts.join("/") === "api/mailboxes/test") {
      const body = await readBody(req);
      const existing = await loadMailboxesSafe();
      // testa uma caixa ja salva (por id) ou uma enviada agora (com senha inline)
      let box = body.id ? existing.find((b) => b.id === body.id) : null;
      if (!box && body.email) box = normalizeBox(body, existing.find((b) => b.id === body.id));
      if (!box) return send(res, 400, { error: "Caixa nao encontrada para testar." });
      const result = await testMailbox(box);
      return send(res, 200, result);
    }

    send(res, 404, { error: "Rota nao encontrada" });
  } catch (error) {
    const status = errorStatus(error);
    // Erro 500 INESPERADO (sem .status proprio): loga o detalhe (diagnostico) mas
    // devolve mensagem generica (nao vaza detalhe de infra/banco pro cliente).
    if (status >= 500 && !error.status) {
      try { console.error("[500]", req.method, req.url, error?.message || error); } catch { /* nada */ }
      return send(res, 500, { error: "Erro interno. Tente de novo em instantes." });
    }
    send(res, status, { error: error.message || "Erro interno" });
  }
}

const server = http.createServer(handle);
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Contas TikTok V2 API rodando em http://127.0.0.1:${PORT} usando storage ${store.mode}`);
});
