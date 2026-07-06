const { app, BrowserWindow, ipcMain, shell, Menu } = require("electron");
const { autoUpdater } = require("electron-updater");
const fs = require("node:fs/promises");
const fss = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const API_URL = process.env.ELEVATE_API_URL || "https://contas-v2.elevateecom.com.br";
const APP_NAME = "ElevateHub";
const UPDATE_HOSTS = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);

function installerFileName(name, url) {
  const fromName = path.basename(String(name || ""));
  const fromUrl = path.basename(new URL(String(url)).pathname);
  const candidate = fromName || fromUrl || "ElevateHub.Setup.exe";
  const clean = candidate.replace(/[^a-z0-9._ -]/gi, "_");
  if (/\.exe$/i.test(clean)) return clean;
  return "ElevateHub.Setup.exe";
}

async function downloadInstaller(info, onProgress) {
  const report = (data) => {
    try {
      if (typeof onProgress === "function") onProgress(data);
    } catch {
      // Progresso e apenas visual; nunca deve quebrar o download.
    }
  };

  const parsed = new URL(String(info?.url || ""));
  if (parsed.protocol !== "https:" || !UPDATE_HOSTS.has(parsed.hostname)) {
    throw new Error("Link de atualizacao invalido.");
  }

  const updatesDir = path.join(app.getPath("temp"), "elevatehub-updates");
  const filePath = path.join(updatesDir, installerFileName(info?.name, parsed.toString()));
  const expectedSize = Number(info?.size) || 0;
  const existing = await fs.stat(filePath).catch(() => null);
  if (existing?.isFile() && ((expectedSize && existing.size === expectedSize) || (!expectedSize && existing.size > 10 * 1024 * 1024))) {
    report({ received: existing.size, total: existing.size, pct: 100, reused: true });
    return filePath;
  }

  const response = await fetch(parsed.toString(), {
    headers: { "User-Agent": `${APP_NAME}/${app.getVersion()}` }
  });
  if (!response.ok || !response.body) throw new Error("Nao foi possivel baixar a atualizacao.");

  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:" || !UPDATE_HOSTS.has(finalUrl.hostname)) {
    throw new Error("Origem da atualizacao invalida.");
  }

  const headerTotal = Number(response.headers.get("content-length")) || 0;
  const total = expectedSize || headerTotal || 0;
  const chunks = [];
  let received = 0;
  report({ received: 0, total, pct: 0 });

  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    chunks.push(chunk);
    received += chunk.byteLength;
    const pct = total ? Math.min(99, Math.round((received / total) * 100)) : 0;
    report({ received, total, pct });
  }

  const buffer = Buffer.concat(chunks, received);
  if (expectedSize && buffer.byteLength !== expectedSize) {
    throw new Error("Download incompleto. Tente novamente.");
  }

  const tempPath = `${filePath}.download`;
  await fs.mkdir(updatesDir, { recursive: true });
  await fs.writeFile(tempPath, buffer);
  await fs.rm(filePath, { force: true });
  await fs.rename(tempPath, filePath);
  report({ received: buffer.byteLength, total: buffer.byteLength, pct: 100 });
  return filePath;
}

// ===== Navegador local por perfil (modelo Dolphin) =====
const openBrowsers = new Map(); // profileId -> child process

function resolveChromePath() {
  const candidates = [];
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, "chrome", "chrome.exe"));
  }
  candidates.push(path.join(__dirname, "..", "chrome", "chrome.exe")); // v2/desktop/chrome
  candidates.push(path.join(__dirname, "..", "..", "..", "chrome", "chrome.exe")); // app antigo (dev)
  for (const candidate of candidates) {
    try {
      if (fss.existsSync(candidate)) return candidate;
    } catch {
      // segue tentando os proximos caminhos
    }
  }
  return null;
}

function profileDataDir(profileId) {
  const safe = String(profileId || "").replace(/[^a-z0-9._-]/gi, "_") || "perfil";
  return path.join(app.getPath("userData"), "profiles", safe);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const client = {
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const id = nextId++;
          pending.set(id, { res, rej });
          try {
            ws.send(JSON.stringify({ id, method, params }));
          } catch (err) {
            pending.delete(id);
            rej(err);
          }
        });
      },
      close() {
        try { ws.close(); } catch { /* ja fechado */ }
      }
    };
    ws.addEventListener("open", () => { settled = true; resolve(client); });
    ws.addEventListener("error", () => { if (!settled) reject(new Error("cdp-ws-error")); });
    ws.addEventListener("message", (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message || "cdp-error"));
        else p.res(msg.result);
      }
    });
  });
}

async function waitDevToolsPort(dir) {
  const file = path.join(dir, "DevToolsActivePort");
  for (let i = 0; i < 80; i++) {
    try {
      const content = await fs.readFile(file, "utf8");
      const port = parseInt(content.split("\n")[0], 10);
      if (port) return port;
    } catch { /* arquivo ainda nao criado */ }
    await sleep(250);
  }
  throw new Error("sem-devtools-port");
}

function toCookieParams(cookies) {
  return (Array.isArray(cookies) ? cookies : [])
    .filter((c) => c && c.name && c.domain)
    .map((c) => {
      const out = {
        name: String(c.name),
        value: String(c.value == null ? "" : c.value),
        domain: String(c.domain),
        path: c.path || "/",
        secure: !!c.secure,
        httpOnly: !!c.httpOnly
      };
      if (c.sameSite === "Strict" || c.sameSite === "Lax" || c.sameSite === "None") out.sameSite = c.sameSite;
      if (typeof c.expires === "number" && c.expires > 0) out.expires = c.expires;
      return out;
    });
}

async function startCookieSync(profileId, dir, url, cookies, sender) {
  const port = await waitDevToolsPort(dir);
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const client = await connectCdp(version.webSocketDebuggerUrl);

  const params = toCookieParams(cookies);
  if (params.length) {
    try { await client.send("Storage.setCookies", { cookies: params }); } catch { /* abre mesmo sem cookies */ }
  }

  let createdId = null;
  try { createdId = (await client.send("Target.createTarget", { url })).targetId; } catch { /* abre sem navegar */ }
  try {
    const { targetInfos } = await client.send("Target.getTargets", {});
    for (const t of targetInfos || []) {
      if (t.type === "page" && t.targetId !== createdId && (t.url === "about:blank" || t.url === "" || t.url.startsWith("chrome://newtab"))) {
        await client.send("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
      }
    }
  } catch { /* deixa a aba em branco se nao der pra fechar */ }

  const entry = openBrowsers.get(profileId);
  if (!entry) { client.close(); return; }
  entry.client = client;
  const pushCookies = async () => {
    try {
      const result = await client.send("Storage.getCookies", {});
      if (sender && !sender.isDestroyed()) {
        sender.send("browser-profile-cookies", { id: profileId, cookies: result.cookies || [] });
      }
    } catch { /* proxima rodada tenta de novo */ }
  };
  entry.firstSync = setTimeout(pushCookies, 6000);   // salva cedo caso feche rapido
  entry.interval = setInterval(pushCookies, 8000);   // e mantem sincronizado
}

async function openBrowserProfile(info, sender) {
  const profileId = String(info?.id || "");
  if (!profileId) return { ok: false, error: "no-id" };
  if (openBrowsers.has(profileId)) return { ok: true, already: true };

  const chrome = resolveChromePath();
  if (!chrome) return { ok: false, error: "no-chrome" };

  const dir = profileDataDir(profileId);
  await fs.mkdir(dir, { recursive: true });
  await fs.rm(path.join(dir, "DevToolsActivePort"), { force: true }).catch(() => {});
  const url = /^https?:/i.test(String(info?.url || "")) ? String(info.url) : "about:blank";

  const child = spawn(chrome, [
    `--user-data-dir=${dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--test-type",
    "--disable-infobars",
    "--remote-debugging-port=0",
    "about:blank"
  ], { detached: false, windowsHide: false });

  const entry = { child, client: null, interval: null };
  openBrowsers.set(profileId, entry);

  child.on("exit", () => {
    const e = openBrowsers.get(profileId);
    if (e) {
      if (e.firstSync) clearTimeout(e.firstSync);
      if (e.interval) clearInterval(e.interval);
      if (e.client) e.client.close();
    }
    openBrowsers.delete(profileId);
    if (sender && !sender.isDestroyed()) sender.send("browser-profile-closed", { id: profileId });
  });
  child.on("error", () => {
    const e = openBrowsers.get(profileId);
    if (e) {
      if (e.firstSync) clearTimeout(e.firstSync);
      if (e.interval) clearInterval(e.interval);
    }
    openBrowsers.delete(profileId);
  });

  startCookieSync(profileId, dir, url, info?.cookies || [], sender).catch(() => {
    // Se a sincronizacao falhar, o Chrome ja abriu; o usuario navega manual.
  });

  return { ok: true };
}

// ===== Atualizacao automatica (delta, sem reinstalar) =====
let autoUpdateReady = false;

function broadcast(channel, data) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, data);
  }
}

function setupAutoUpdate() {
  autoUpdater.autoDownload = true;            // baixa em segundo plano
  autoUpdater.autoInstallOnAppQuit = true;    // aplica ao fechar o app
  autoUpdater.on("update-available", (info) => broadcast("update-available", { version: info?.version }));
  autoUpdater.on("download-progress", (p) => broadcast("update-progress", { pct: Math.round(p?.percent || 0) }));
  autoUpdater.on("update-downloaded", (info) => { autoUpdateReady = true; broadcast("update-downloaded", { version: info?.version }); });
  autoUpdater.on("error", () => { /* silencioso: nunca atrapalha o uso */ });
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 60 * 60 * 1000); // checa 1x/hora
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1120,
    minHeight: 720,
    title: APP_NAME,
    icon: path.join(__dirname, "assets", "elevatehub-mark.png"),
    autoHideMenuBar: true,
    backgroundColor: "#0b0f14",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--api-url=${API_URL}`, `--app-version=${app.getVersion()}`]
    }
  });

  win.setMenu(null);
  win.setMenuBarVisibility(false);
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(() => {
  app.setName(APP_NAME);
  Menu.setApplicationMenu(null);

  ipcMain.handle("open-external", async (_event, url) => {
    const parsed = new URL(String(url));
    if (parsed.protocol !== "https:") return false;
    await shell.openExternal(parsed.toString());
    return true;
  });

  ipcMain.handle("open-browser-profile", async (event, info) => {
    return openBrowserProfile(info, event.sender);
  });

  ipcMain.handle("install-update-now", () => {
    if (!autoUpdateReady) return false;
    setImmediate(() => autoUpdater.quitAndInstall());
    return true;
  });

  createWindow();
  if (app.isPackaged) setupAutoUpdate();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
