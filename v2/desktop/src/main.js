const { app, BrowserWindow, ipcMain, shell, Menu } = require("electron");
const { autoUpdater } = require("electron-updater");
const fs = require("node:fs/promises");
const fss = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const API_URL = process.env.ELEVATE_API_URL || "https://contas-v2.elevateecom.com.br";
const APP_NAME = "ElevateHub";

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
    const listeners = new Map();
    const client = {
      send(method, params = {}, sessionId) {
        return new Promise((res, rej) => {
          const id = nextId++;
          pending.set(id, { res, rej });
          const msg = { id, method, params };
          if (sessionId) msg.sessionId = sessionId;
          try {
            ws.send(JSON.stringify(msg));
          } catch (err) {
            pending.delete(id);
            rej(err);
          }
        });
      },
      on(method, fn) { listeners.set(method, fn); },
      close() {
        try { ws.close(); } catch { /* ja fechado */ }
      }
    };
    // Se a conexao cair, rejeita TODAS as chamadas pendentes (senao um `await`
    // de um comando sem resposta fica preso p/ sempre — poderia travar a aba).
    const failAll = (err) => { for (const [, p] of pending) p.rej(err); pending.clear(); };
    ws.addEventListener("open", () => { settled = true; resolve(client); });
    ws.addEventListener("error", () => { if (!settled) reject(new Error("cdp-ws-error")); else failAll(new Error("cdp-ws-error")); });
    ws.addEventListener("close", () => { if (!settled) reject(new Error("cdp-ws-closed")); else failAll(new Error("cdp-ws-closed")); });
    ws.addEventListener("message", (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message || "cdp-error"));
        else p.res(msg.result);
      } else if (msg.method && listeners.has(msg.method)) {
        try { listeners.get(msg.method)(msg.params || {}); } catch { /* handler nao pode derrubar */ }
      }
    });
  });
}

// O Chrome for Testing se identifica como "Chromium" (nao "Google Chrome") no
// navigator.userAgentData.brands. Alguns sites (ex: TikTok Shop) checam isso e
// bloqueiam com "atualize o app". Aqui montamos os metadados de um Chrome normal.
function buildUaMetadata(browserStr, ua) {
  const full = String(browserStr || "").split("/")[1]?.trim() || "150.0.0.0";
  const major = full.split(".")[0];
  return {
    userAgent: ua,
    userAgentMetadata: {
      brands: [
        { brand: "Not;A=Brand", version: "8" },
        { brand: "Chromium", version: major },
        { brand: "Google Chrome", version: major }
      ],
      fullVersionList: [
        { brand: "Not;A=Brand", version: "8.0.0.0" },
        { brand: "Chromium", version: full },
        { brand: "Google Chrome", version: full }
      ],
      fullVersion: full,
      platform: "Windows",
      platformVersion: "19.0.0",
      architecture: "x86",
      model: "",
      mobile: false,
      bitness: "64",
      wow64: false
    }
  };
}

async function waitDevToolsPort(dir) {
  const file = path.join(dir, "DevToolsActivePort");
  for (let i = 0; i < 120; i++) {
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
  // Conecta com tentativas: em PC ocupado o endpoint pode demorar/falhar por um
  // instante. Sem essa conexao a marca "Google Chrome" nao e aplicada e o TikTok
  // bloqueia -> era o erro intermitente que sumia ao reiniciar.
  let version, client;
  for (let attempt = 0; ; attempt++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      client = await connectCdp(version.webSocketDebuggerUrl);
      break;
    } catch (err) {
      if (attempt >= 5) throw err;
      await sleep(600);
    }
  }

  const params = toCookieParams(cookies);
  if (params.length) {
    // Injeta tudo de uma vez (rapido). Se falhar, cai p/ uma a uma (um cookie
    // invalido nao derruba a sessao inteira).
    try {
      await client.send("Storage.setCookies", { cookies: params });
    } catch {
      for (const cookie of params) {
        try { await client.send("Storage.setCookies", { cookies: [cookie] }); } catch { /* ignora esse cookie */ }
      }
    }
  }

  // Faz o navegador se apresentar como "Google Chrome" (senao o TikTok bloqueia).
  // Aplica a marca SO na aba principal e ANTES de navegar (abre em branco, aplica,
  // depois navega). NAO pausa todas as abas/frames — isso deixava o site MUITO lento.
  // A marca vale tambem p/ os frames internos da propria pagina.
  const uaMeta = buildUaMetadata(version.Browser, version["User-Agent"]);
  let createdId = null;
  try {
    createdId = (await client.send("Target.createTarget", { url: "about:blank" })).targetId;
    const attached = await client.send("Target.attachToTarget", { targetId: createdId, flatten: true });
    try { await client.send("Emulation.setUserAgentOverride", uaMeta, attached.sessionId); } catch { /* segue sem a marca */ }
    await client.send("Page.navigate", { url }, attached.sessionId);
  } catch {
    // fallback: abre direto na URL (pode cair no bloqueio, mas abre)
    try { createdId = (await client.send("Target.createTarget", { url })).targetId; } catch { /* abre sem navegar */ }
  }
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
  entry.firstSync = setTimeout(pushCookies, 3000);   // salva cedo caso feche rapido
  entry.interval = setInterval(pushCookies, 8000);   // e mantem sincronizado
}

// Identidade da janela (estilo Dolphin): nome do cliente + cor propria no
// perfil do Chrome -> cada conta aparece com seu nome na barra de tarefas,
// no lugar de "Test". Mescla no Preferences (nao apaga login/cookies).
const WINDOW_PALETTE = [0xA78BFA, 0x34D399, 0x60A5FA, 0xFBBF24, 0xFB7185, 0x22D3EE, 0xF472B6, 0x4ADE80, 0x818CF8, 0xF0883E];
async function markChromeProfile(dir, name) {
  const clean = String(name || "").trim();
  if (!clean) return;
  const defDir = path.join(dir, "Default");
  const prefsPath = path.join(defDir, "Preferences");
  await fs.mkdir(defDir, { recursive: true });
  let prefs = {};
  try { prefs = JSON.parse(await fs.readFile(prefsPath, "utf8")); } catch { prefs = {}; }
  let h = 0;
  for (const ch of clean) h = (h + ch.charCodeAt(0)) >>> 0;
  const rgb = WINDOW_PALETTE[h % WINDOW_PALETTE.length];
  prefs.profile = prefs.profile || {};
  prefs.profile.name = clean;
  prefs.profile.avatar_index = h % 56;
  prefs.profile.using_default_avatar = false;
  prefs.profile.using_default_name = false;
  prefs.browser = prefs.browser || {};
  prefs.browser.theme = prefs.browser.theme || {};
  prefs.browser.theme.user_color = ((0xFF << 24) | rgb) >>> 0;
  prefs.browser.theme.is_grayscale = false;
  try { await fs.writeFile(prefsPath, JSON.stringify(prefs)); } catch { /* segue sem a marca */ }
}

// URL do painel de ADS filtrada no DIA ANTERIOR (data nos parametros, fuso -03:00).
function adsUrlForYesterday() {
  const now = new Date();
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const ms = Date.UTC(y.getFullYear(), y.getMonth(), y.getDate(), 3, 0, 0); // meia-noite -3 em UTC (ms)
  const base = "https://seller-br.tiktok.com/ads-creation/dashboard?mpa=1";
  return `${base}&activated_tab_id=0&list_start_date=${ms}&list_end_date=${ms}`;
}

function killChrome(child) {
  try { spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }); } catch { /* ignora */ }
  try { child.kill(); } catch { /* ja morreu */ }
}

// Fase 1 do "Relatorio de ADS": abre a conta, entra no painel de anuncios do dia
// anterior, LE as metricas do DOM (via ads-metrics) e fecha. Retorna os numeros.
async function collectAdsMetrics(info) {
  const profileId = String(info?.id || "");
  if (!profileId) return { ok: false, motivo: "perfil invalido" };
  if (openBrowsers.has(profileId)) {
    return { ok: false, motivo: "Feche o navegador desta conta antes de ler o ADS." };
  }
  const chrome = resolveChromePath();
  if (!chrome) return { ok: false, motivo: "Navegador do app nao encontrado." };

  const dir = profileDataDir(profileId);
  await fs.mkdir(dir, { recursive: true });
  await fs.rm(path.join(dir, "DevToolsActivePort"), { force: true }).catch(() => {});
  const child = spawn(chrome, [
    `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check",
    "--test-type", "--disable-infobars", "--remote-debugging-port=0",
    "--window-position=-32000,-32000", "--window-size=1280,800", // abre fora da tela (coleta em segundo plano)
    "about:blank"
  ], { detached: false, windowsHide: true });

  let client = null;
  try {
    const port = await waitDevToolsPort(dir);
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    client = await connectCdp(version.webSocketDebuggerUrl);

    const params = toCookieParams(info?.cookies || []);
    if (params.length) {
      try { await client.send("Storage.setCookies", { cookies: params }); }
      catch { for (const c of params) { try { await client.send("Storage.setCookies", { cookies: [c] }); } catch { /* ignora */ } } }
    }

    const uaMeta = buildUaMetadata(version.Browser, version["User-Agent"]);
    const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
    try { await client.send("Emulation.setUserAgentOverride", uaMeta, sessionId); } catch { /* segue */ }
    await client.send("Page.navigate", { url: adsUrlForYesterday() }, sessionId);

    const readText = async () => {
      try {
        const r = await client.send("Runtime.evaluate",
          { expression: "document.body ? document.body.innerText : ''", returnByValue: true }, sessionId);
        return String(r?.result?.value || "");
      } catch { return ""; }
    };

    // espera o painel ("Visao geral") aparecer, ate ~45s; detecta login
    const deadline = Date.now() + 45000;
    let text = "";
    while (Date.now() < deadline) {
      await sleep(1500);
      text = await readText();
      const low = text.toLowerCase();
      if (low.includes("visao geral") || low.includes("visão geral")) break;
      if (low.includes("fazer login") || low.includes("iniciar sess")) {
        return { ok: false, motivo: "conta nao esta logada (abra e faca login primeiro)" };
      }
    }
    await sleep(5000); // deixa os numeros/grafico assentarem
    text = await readText();
    const { extractAdsMetrics } = require("./ads-metrics");
    const m = extractAdsMetrics(text);
    if (!m.ok) return { ok: false, motivo: m.motivo };
    return { ok: true, metrics: { custo: m.custo, pedidos: m.pedidos, cpp: m.cpp, receita: m.receita, roi: m.roi } };
  } catch (e) {
    return { ok: false, motivo: String(e?.message || e || "falha ao ler o ADS") };
  } finally {
    try { if (client) client.close(); } catch { /* ja fechado */ }
    killChrome(child);
  }
}

async function openBrowserProfile(info, sender) {
  const profileId = String(info?.id || "");
  if (!profileId) return { ok: false, error: "no-id" };
  if (openBrowsers.has(profileId)) {
    const e = openBrowsers.get(profileId);
    // Só considera "já aberto" se o Chrome ainda está vivo. Entrada presa de um
    // processo que morreu -> limpa e reabre (senão diria "já aberto" sem janela).
    if (e?.child && e.child.exitCode === null && !e.child.killed) {
      return { ok: true, already: true };
    }
    try { if (e?.firstSync) clearTimeout(e.firstSync); if (e?.interval) clearInterval(e.interval); if (e?.client) e.client.close(); } catch { /* ignora */ }
    openBrowsers.delete(profileId);
  }

  const chrome = resolveChromePath();
  if (!chrome) return { ok: false, error: "no-chrome" };

  const dir = profileDataDir(profileId);
  await fs.mkdir(dir, { recursive: true });
  await markChromeProfile(dir, info?.name);
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
      if (e.client) e.client.close();
    }
    openBrowsers.delete(profileId);
    // Avisa o renderer pra LIBERAR o lock (senao o perfil fica preso em "em uso")
    if (sender && !sender.isDestroyed()) sender.send("browser-profile-closed", { id: profileId });
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
  autoUpdater.autoDownload = true;            // baixa em segundo plano (fica pronta)
  autoUpdater.autoInstallOnAppQuit = false;   // NAO aplica sozinha: o usuario escolhe
  autoUpdater.on("update-available", (info) => broadcast("update-available", { version: info?.version }));
  autoUpdater.on("download-progress", (p) => broadcast("update-progress", { pct: Math.round(p?.percent || 0) }));
  autoUpdater.on("update-downloaded", (info) => { autoUpdateReady = true; broadcast("update-downloaded", { version: info?.version }); });
  autoUpdater.on("error", () => { /* silencioso: nunca atrapalha o uso */ });

  // Checa sem precisar reiniciar: na abertura, a cada 10 min, e quando o usuario
  // volta pro app (com um limite de 1x/2min pra nao checar demais).
  let lastCheck = 0;
  const check = () => {
    lastCheck = Date.now();
    autoUpdater.checkForUpdates().catch(() => {});
  };
  check();
  setInterval(check, 10 * 60 * 1000);
  app.on("browser-window-focus", () => {
    if (Date.now() - lastCheck > 2 * 60 * 1000) check();
  });
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

  ipcMain.handle("collect-ads-metrics", async (_event, info) => {
    return collectAdsMetrics(info);
  });

  ipcMain.handle("save-open-report", async (_event, html) => {
    try {
      const dir = path.join(app.getPath("documents"), "ElevateHub");
      await fs.mkdir(dir, { recursive: true });
      const d = new Date();
      const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const file = path.join(dir, `Relatorio_ADS_${stamp}.html`);
      await fs.writeFile(file, String(html || ""), "utf8");
      shell.openPath(file);
      return { ok: true, path: file };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });

  ipcMain.handle("open-last-report", async () => {
    try {
      const dir = path.join(app.getPath("documents"), "ElevateHub");
      const files = (await fs.readdir(dir).catch(() => []))
        .filter((f) => f.startsWith("Relatorio_ADS_") && f.endsWith(".html")).sort();
      if (!files.length) return { ok: false };
      const file = path.join(dir, files[files.length - 1]);
      shell.openPath(file);
      return { ok: true, path: file };
    } catch {
      return { ok: false };
    }
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
