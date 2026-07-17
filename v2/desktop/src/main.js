const { app, BrowserWindow, ipcMain, shell, Menu } = require("electron");
const { autoUpdater } = require("electron-updater");
const fs = require("node:fs/promises");
const fss = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const API_URL = process.env.ELEVATE_API_URL || "https://contas-v2.elevateecom.com.br";
const APP_NAME = "ElevateHub";

// Rede de seguranca: um erro nao tratado (ex: evento 'error' de um processo sem
// listener) NUNCA deve derrubar o app inteiro. So registra e segue.
process.on("uncaughtException", (err) => { try { console.error("[uncaught]", err?.message || err); } catch { /* nada */ } });
process.on("unhandledRejection", (err) => { try { console.error("[unhandledRejection]", err?.message || err); } catch { /* nada */ } });

// Gravacao atomica (tmp + rename): evita arquivo corrompido por escrita interrompida.
async function atomicWrite(file, data) {
  const tmp = `${file}.${Date.now()}.${Math.floor(Math.random() * 1e6)}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

// ===== Navegador local por perfil (modelo Dolphin) =====
const openBrowsers = new Map(); // profileId -> child process
const adsInProgress = new Set(); // perfis sendo lidos pelo Relatorio de ADS agora
const openingProfiles = new Set(); // perfis EM PROCESSO de abertura (trava a corrida de duplo-clique)
let creatorsPanel = null; // processo do painel "Adicionar creators" (Afiliador), 1 instancia
let creatorsLaunching = false; // reserva sincrona anti duplo-clique no spawn do painel
let creatorsAccountsKey = ""; // ids (ordenados) das contas do painel ATUAL -> se a selecao muda, reabre

// Acha o executavel do painel de creators (Afiliador) empacotado, ou o dev.
function resolveCreatorsSidecar() {
  const candidates = [];
  if (app.isPackaged) candidates.push(path.join(process.resourcesPath, "creators", "creators-panel.exe"));
  candidates.push(path.join(__dirname, "..", "..", "afiliador", "dist", "creators-panel.exe")); // dev/local
  for (const c of candidates) {
    try { if (fss.existsSync(c)) return c; } catch { /* segue */ }
  }
  return null;
}

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

// Resolve um arquivo da pasta "tools" (empacotada em resources/tools, ou dev em ./tools).
function resolveTool(fileName) {
  const candidates = [];
  if (app.isPackaged) candidates.push(path.join(process.resourcesPath, "tools", fileName));
  candidates.push(path.join(__dirname, "..", "tools", fileName)); // dev: v2/desktop/tools
  for (const c of candidates) {
    try { if (fss.existsSync(c)) return c; } catch { /* segue */ }
  }
  return null;
}

// "Marca" a janela do Chrome recem-aberto com a logo do ElevateHub (azul) na barra de
// tarefas, estilo Dolphin. O Chrome IGNORA o icone do exe, entao um ajudante nativo
// (brand-window.exe) injeta o icone na janela via WM_SETICON e fica vivo segurando-o
// ate o Chrome fechar (o handle do icone morreria se o ajudante saisse antes).
// MELHOR-ESFORCO: tudo em try/catch e desanexado -> se falhar, o navegador abre normal.
function brandChromeWindow(child) {
  try {
    if (process.platform !== "win32" || !child || !child.pid) return;
    const brander = resolveTool("brand-window.exe");
    const ico = resolveTool("chrome-elevatehub.ico");
    if (!brander || !ico) return;
    const b = spawn(brander, [String(child.pid), ico], { detached: true, windowsHide: true, stdio: "ignore" });
    b.on("error", () => { /* ignora: e so o icone, nao pode atrapalhar */ });
    b.unref();
  } catch { /* nunca propaga: cosmetico */ }
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
          // Timeout de seguranca: se um comando CDP for ACEITO mas nunca responder
          // (socket vivo, sem close/error), o `await` ficaria preso p/ sempre — isso
          // travava o deadline do Relatorio de ADS e deixava adsInProgress preso ate
          // reiniciar o app. Rejeita apos 30s e limpa o pendente.
          const timer = setTimeout(() => {
            if (pending.has(id)) { pending.delete(id); rej(new Error("cdp-timeout")); }
          }, 30000);
          pending.set(id, {
            res: (v) => { clearTimeout(timer); res(v); },
            rej: (e) => { clearTimeout(timer); rej(e); }
          });
          const msg = { id, method, params };
          if (sessionId) msg.sessionId = sessionId;
          try {
            ws.send(JSON.stringify(msg));
          } catch (err) {
            clearTimeout(timer);
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
    // Timeout de CONEXAO: se o WebSocket abrir o TCP mas nunca completar o handshake
    // (nem 'open', nem 'error'/'close'), o await ficaria preso p/ sempre -> travava o
    // collectAdsMetrics e deixava adsInProgress preso ate reiniciar o app.
    const connectTimer = setTimeout(() => {
      if (!settled) { settled = true; try { ws.close(); } catch { /* ja fechado */ } reject(new Error("cdp-connect-timeout")); }
    }, 15000);
    ws.addEventListener("open", () => { clearTimeout(connectTimer); settled = true; resolve(client); });
    ws.addEventListener("error", () => { clearTimeout(connectTimer); if (!settled) { settled = true; reject(new Error("cdp-ws-error")); } else failAll(new Error("cdp-ws-error")); });
    ws.addEventListener("close", () => { clearTimeout(connectTimer); if (!settled) { settled = true; reject(new Error("cdp-ws-closed")); } else failAll(new Error("cdp-ws-closed")); });
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
      platformVersion: "15.0.0",
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

async function startCookieSync(profileId, dir, url, cookies, sender, child, mkt) {
  const port = await waitDevToolsPort(dir);
  // Conecta com tentativas: em PC ocupado o endpoint pode demorar/falhar por um
  // instante. Sem essa conexao a marca "Google Chrome" nao e aplicada e o TikTok
  // bloqueia -> era o erro intermitente que sumia ao reiniciar.
  let version, client;
  for (let attempt = 0; ; attempt++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(8000) })).json();
      client = await connectCdp(version.webSocketDebuggerUrl);
      break;
    } catch (err) {
      if (attempt >= 5) throw err;
      await sleep(600);
    }
  }
  // Se durante a espera o usuario fechou e reabriu (novo Chrome), este sync ficou
  // orfao -> nao mexe (senao abriria aba duplicada e vazaria timer/conexao).
  if (child && openBrowsers.get(profileId)?.child !== child) { client.close(); return; }

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
  // IMPORTANTE: a marca falsa (e os "client hints" de sistema) SO e aplicada quando
  // o destino e o TikTok. Em Mercado Livre/Shopee/Amazon, mandar uma identidade
  // fabricada fazia esses sites acionarem reCAPTCHA e deslogar a conta. Fora do TikTok
  // o navegador usa a identidade nativa (igual a um Chrome normal), que e o esperado.
  // Decidimos pela URL de destino (nao pela pasta): um cliente de ML arquivado na
  // pasta do TikTok, com link proprio, tambem fica sem o spoof.
  let destHost = "";
  try { destHost = new URL(url).hostname.toLowerCase(); } catch { /* url estranha */ }
  const spoof = /(^|\.)tiktok\.com$/.test(destHost) || (mkt === "tiktok" && !destHost);
  const uaMeta = spoof ? buildUaMetadata(version.Browser, version["User-Agent"]) : null;
  let createdId = null;
  try {
    createdId = (await client.send("Target.createTarget", { url: "about:blank" })).targetId;
    const attached = await client.send("Target.attachToTarget", { targetId: createdId, flatten: true });
    if (spoof) {
      try { await client.send("Emulation.setUserAgentOverride", uaMeta, attached.sessionId); } catch { /* segue sem a marca */ }
    }
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
  // Mesmo cuidado do guard la em cima (fechou e reabriu durante os awaits): so
  // adota a entrada se ela ainda for DESTE Chrome. Senao este sync ficou orfao e
  // sobrescreveria o client/timers do navegador NOVO com os do velho (ja morto)
  // -> vazava setInterval e o navegador reaberto parava de sincronizar cookies.
  if (!entry || (child && entry.child !== child)) { client.close(); return; }
  entry.client = client;
  const pushCookies = async () => {
    try {
      const result = await client.send("Storage.getCookies", {});
      const cookies = result.cookies || [];
      // Nunca envia leitura VAZIA: durante navegacao/redirect/checagem o getCookies
      // pode vir vazio por um instante, e mandar isso tentaria ZERAR a sessao no
      // servidor. O servidor tambem barra (cookie-guard), mas cortar aqui evita o
      // round-trip e o risco. A protecao contra leitura PARCIAL/degradada fica no
      // servidor, que compara com a sessao ja guardada.
      if (!cookies.length) return;
      if (sender && !sender.isDestroyed()) {
        sender.send("browser-profile-cookies", { id: profileId, cookies });
      }
    } catch { /* proxima rodada tenta de novo */ }
  };
  // 1a sincronizacao um pouco mais tarde (era 3s): da tempo da sessao injetada
  // assentar no cookie store do Chrome antes da 1a leitura -> evita mandar um
  // estado incompleto logo na abertura.
  entry.firstSync = setTimeout(pushCookies, 6000);
  entry.interval = setInterval(pushCookies, 8000);   // e mantem sincronizado
}

// Identidade da janela (estilo Dolphin): nome do cliente + cor propria no
// perfil do Chrome -> cada conta aparece com seu nome na barra de tarefas,
// no lugar de "Test". Mescla no Preferences (nao apaga login/cookies).
const WINDOW_PALETTE = [0xA78BFA, 0x34D399, 0x60A5FA, 0xFBBF24, 0xFB7185, 0x22D3EE, 0xF472B6, 0x4ADE80, 0x818CF8, 0xF0883E];
async function markChromeProfile(dir, name) {
  const clean = String(name || "").trim();
  if (!clean) return;
  let h = 0;
  for (const ch of clean) h = (h + ch.charCodeAt(0)) >>> 0;
  const rgb = WINDOW_PALETTE[h % WINDOW_PALETTE.length];
  const avatarIdx = h % 56;

  // 1) Preferences (perfil Default): nome + cor/tema
  const defDir = path.join(dir, "Default");
  const prefsPath = path.join(defDir, "Preferences");
  await fs.mkdir(defDir, { recursive: true });
  let prefs = {};
  try { prefs = JSON.parse(await fs.readFile(prefsPath, "utf8")); } catch { prefs = {}; }
  prefs.profile = prefs.profile || {};
  prefs.profile.name = clean;
  prefs.profile.avatar_index = avatarIdx;
  prefs.profile.using_default_avatar = false;
  prefs.profile.using_default_name = false;
  prefs.browser = prefs.browser || {};
  prefs.browser.theme = prefs.browser.theme || {};
  prefs.browser.theme.user_color = ((0xFF << 24) | rgb) >>> 0;
  prefs.browser.theme.is_grayscale = false;
  try { await atomicWrite(prefsPath, JSON.stringify(prefs)); } catch { /* segue sem a marca */ }

  // 2) Local State: e DAQUI que o Chrome tira o NOME EXIBIDO (barra/aba/taskbar)
  // -> era o que faltava (por isso continuava "Test").
  const lsPath = path.join(dir, "Local State");
  let ls = {};
  try { ls = JSON.parse(await fs.readFile(lsPath, "utf8")); } catch { ls = {}; }
  ls.profile = ls.profile || {};
  ls.profile.info_cache = ls.profile.info_cache || {};
  ls.profile.info_cache.Default = {
    ...(ls.profile.info_cache.Default || {}),
    name: clean,
    shortcut_name: clean,
    is_using_default_name: false,
    is_using_default_avatar: false,
    avatar_icon: `chrome://theme/IDR_PROFILE_AVATAR_${avatarIdx}`
  };
  if (!Array.isArray(ls.profile.profiles_order)) ls.profile.profiles_order = ["Default"];
  ls.profile.last_used = "Default";
  try { await atomicWrite(lsPath, JSON.stringify(ls)); } catch { /* segue */ }
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
// Diagnóstico do ADS: salva o TEXTO e uma FOTO do painel de cada conta em
// Documentos/ElevateHub/ads-debug -> serve p/ calibrar a leitura contra a tela
// real do GMV Max (e p/ entender quando uma conta falha).
async function saveAdsDebug(name, text, client, sessionId) {
  const safe = String(name || "conta").replace(/[^a-z0-9._-]/gi, "_").slice(0, 60) || "conta";
  const dir = path.join(app.getPath("documents"), APP_NAME, "ads-debug");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${safe}.txt`), String(text || ""), "utf8");
  try {
    const shot = await client.send("Page.captureScreenshot", { format: "png" }, sessionId);
    if (shot?.data) await fs.writeFile(path.join(dir, `${safe}.png`), Buffer.from(shot.data, "base64"));
  } catch { /* screenshot é opcional */ }
}

async function collectAdsMetrics(info) {
  const profileId = String(info?.id || "");
  if (!profileId) return { ok: false, motivo: "perfil invalido" };
  // Checa TAMBEM openingProfiles: se o usuario acabou de clicar "Abrir" e a
  // abertura esta nos awaits (openBrowsers ainda vazio), sem isto o ADS abriria
  // um 2o Chrome no MESMO user-data-dir e mexeria na sessao que ele esta usando.
  if (openBrowsers.has(profileId) || openingProfiles.has(profileId) || adsInProgress.has(profileId)) {
    // adsInProgress: 2 leituras concorrentes da MESMA conta (duplo-clique / lista
    // processando em paralelo) abririam 2 Chromes no mesmo user-data-dir.
    return { ok: false, motivo: "Feche o navegador desta conta antes de ler o ADS." };
  }
  const chrome = resolveChromePath();
  if (!chrome) return { ok: false, motivo: "Navegador do app nao encontrado." };

  adsInProgress.add(profileId); // impede "Abrir" a mesma conta durante a leitura
  const dir = profileDataDir(profileId);
  await fs.mkdir(dir, { recursive: true });
  await fs.rm(path.join(dir, "DevToolsActivePort"), { force: true }).catch(() => {});
  const child = spawn(chrome, [
    `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check",
    // --test-type esconde o banner amarelo (o Chrome empacotado e "Chrome for
    // Testing"); AutomationControlled esconde o navigator.webdriver (anti-deteccao).
    "--test-type", "--disable-infobars", "--disable-blink-features=AutomationControlled", "--remote-debugging-port=0",
    "--window-position=-32000,-32000", "--window-size=1280,800", // abre fora da tela (coleta em segundo plano)
    "about:blank"
  ], { detached: false, windowsHide: true });
  // SEM este listener, um evento 'error' do processo (exe travado, etc.) derruba o app.
  child.on("error", () => { /* tratado no catch/finally (o connect vai falhar) */ });

  let client = null;
  try {
    const port = await waitDevToolsPort(dir);
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(8000) })).json();
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
    await saveAdsDebug(info?.name, text, client, sessionId).catch(() => {}); // captura p/ calibrar
    const { extractAdsMetrics } = require("./ads-metrics");
    const m = extractAdsMetrics(text);
    if (!m.ok) return { ok: false, motivo: m.motivo };
    return { ok: true, metrics: { custo: m.custo, pedidos: m.pedidos, cpp: m.cpp, receita: m.receita, roi: m.roi, ticket: m.ticket } };
  } catch (e) {
    return { ok: false, motivo: String(e?.message || e || "falha ao ler o ADS") };
  } finally {
    try { if (client) client.close(); } catch { /* ja fechado */ }
    killChrome(child);
    adsInProgress.delete(profileId);
  }
}

async function openBrowserProfile(info, sender) {
  const profileId = String(info?.id || "");
  if (!profileId) return { ok: false, error: "no-id" };
  if (adsInProgress.has(profileId)) {
    return { ok: false, error: "ads-busy" };
  }
  // CORRIDA DE DUPLO-CLIQUE: o guard "ja aberto" (openBrowsers) so era gravado
  // DEPOIS de varios awaits (mkdir/markChromeProfile/rm). Dois cliques rapidos (ou
  // dois eventos IPC quase simultaneos) passavam OS DOIS pela checagem antes de
  // qualquer um registrar -> cada um dava spawn = "varios Chromes", e o processo
  // perdido virava orfao. Esta reserva e SINCRONA (roda inteira sem ceder o event
  // loop), entao fecha a janela antes do primeiro await.
  if (openingProfiles.has(profileId)) return { ok: true, already: true };
  if (openBrowsers.has(profileId)) {
    const e = openBrowsers.get(profileId);
    // Só considera "já aberto" se o Chrome ainda está vivo DE VERDADE. Alem do
    // exitCode, confirma que o PID ainda existe no SO: o evento 'exit' as vezes
    // NAO chega (processo morto por fora, ou o Chrome que reencaminha e sai) e a
    // entrada ficava FANTASMA -> dizia "ja aberto" sem janela nenhuma.
    // process.kill(pid, 0) so testa a existencia do processo (nao mata nada).
    let vivoDeVerdade = false;
    if (e?.child && e.child.exitCode === null && !e.child.killed && e.child.pid) {
      try { process.kill(e.child.pid, 0); vivoDeVerdade = true; } catch { vivoDeVerdade = false; }
    }
    if (vivoDeVerdade) {
      return { ok: true, already: true };
    }
    // Entrada fantasma (processo ja morreu) -> limpa e segue pra REABRIR (nao deixa
    // preso em "ja aberto"). Nao mexe no lock: o openLocalBrowser ja registrou.
    try { if (e?.firstSync) clearTimeout(e.firstSync); if (e?.interval) clearInterval(e.interval); if (e?.client) e.client.close(); } catch { /* ignora */ }
    openBrowsers.delete(profileId);
  }

  const chrome = resolveChromePath();
  if (!chrome) return { ok: false, error: "no-chrome" };

  openingProfiles.add(profileId); // reserva o slot ANTES do primeiro await
  try {
    const dir = profileDataDir(profileId);
    await fs.mkdir(dir, { recursive: true });
    await markChromeProfile(dir, info?.name);
    await fs.rm(path.join(dir, "DevToolsActivePort"), { force: true }).catch(() => {});
    const url = /^https?:/i.test(String(info?.url || "")) ? String(info.url) : "about:blank";

    const child = spawn(chrome, [
      `--user-data-dir=${dir}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Anti-deteccao: esconde o navigator.webdriver (o sinal que o anti-fraude do
      // TikTok le via JS) -> menos captcha em loop e menos bloqueio de login.
      // MANTEMOS o --test-type: o Chrome empacotado e "Chrome for Testing" e o
      // --test-type esconde o banner amarelo (senao o usuario ve "Chrome for
      // Testing" no topo e pode clicar em "Baixe o Chrome").
      "--test-type",
      "--disable-infobars",
      "--disable-blink-features=AutomationControlled",
      "--remote-debugging-port=0",
      "about:blank"
    ], { detached: false, windowsHide: false });

    const entry = { child, client: null, interval: null };
    openBrowsers.set(profileId, entry);
    // Marca a janela com a logo azul do ElevateHub na barra de tarefas (estilo Dolphin).
    brandChromeWindow(child);

    // 'exit' e 'error' podem disparar os DOIS pro mesmo Chrome. Um handler unico:
    // (1) so limpa se a entrada ainda for DESTE child (evita mexer no navegador ja
    // reaberto por um evento atrasado, que soltaria o lock recem-adquirido) e
    // (2) avisa o renderer no maximo 1x (senao seriam 2x release/loadProfiles).
    let closedEmitted = false;
    const onGone = () => {
      const e = openBrowsers.get(profileId);
      // Um navegador NOVO ja assumiu este perfil (reabertura) -> este 'exit' e do
      // Chrome VELHO. Ignora por completo: NAO pode avisar "fechou", senao soltaria
      // o lock/sessao do navegador novo (a conta sumia da lista mesmo aberta).
      if (e && e.child !== child) return;
      if (e) {
        if (e.firstSync) clearTimeout(e.firstSync);
        if (e.interval) clearInterval(e.interval);
        if (e.client) e.client.close();
        openBrowsers.delete(profileId);
      }
      if (closedEmitted) return;
      closedEmitted = true;
      // Avisa o renderer pra LIBERAR o lock (senao o perfil fica preso em "em uso")
      if (sender && !sender.isDestroyed()) sender.send("browser-profile-closed", { id: profileId });
    };
    child.on("exit", onGone);
    child.on("error", onGone);

    startCookieSync(profileId, dir, url, info?.cookies || [], sender, child, String(info?.mkt || "")).catch(() => {
      // Se a sincronizacao falhar, o Chrome ja abriu; o usuario navega manual.
    });

    return { ok: true };
  } finally {
    // Libera a reserva: aqui openBrowsers ja tem a entrada (registro sincrono antes
    // deste return), entao as proximas chamadas caem no guard de "ja aberto".
    openingProfiles.delete(profileId);
  }
}

// ===== Atualizacao automatica (delta, sem reinstalar) =====
let autoUpdateReady = false;
let autoUpdateReadyVersion = "";   // versao ja baixada e pendente (pra faixa persistente)

function broadcast(channel, data) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, data);
  }
}

function setupAutoUpdate() {
  autoUpdater.autoDownload = true;            // baixa em segundo plano (fica pronta)
  // Aplica SOZINHA quando o usuario fecha o app (nao interrompe o uso, so ao sair).
  // Assim ninguem fica preso numa versao antiga: na proxima abertura ja esta atualizado.
  // O botao "atualizar agora" continua funcionando pra quem quiser na hora.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-available", (info) => broadcast("update-available", { version: info?.version }));
  autoUpdater.on("download-progress", (p) => broadcast("update-progress", { pct: Math.round(p?.percent || 0) }));
  autoUpdater.on("update-downloaded", (info) => { autoUpdateReady = true; autoUpdateReadyVersion = info?.version || ""; broadcast("update-downloaded", { version: info?.version }); });
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
      // Habilita a tag <webview> — usada SO pra embutir o painel de creators, que e
      // um endereco LOCAL (127.0.0.1). A webview em si roda isolada; contextIsolation
      // e sandbox continuam ligados. Nao expomos webview a conteudo externo.
      webviewTag: true,
      additionalArguments: [`--api-url=${API_URL}`, `--app-version=${app.getVersion()}`]
    }
  });

  win.setMenu(null);
  win.setMenuBarVisibility(false);
  win.once("ready-to-show", () => win.show());
  // Abrir link externo: SO https (nao deixa file://, ms-msdt:, UNC etc. abrirem
  // pelo SO caso a pagina seja comprometida).
  win.webContents.setWindowOpenHandler(({ url }) => {
    try { if (new URL(url).protocol === "https:") shell.openExternal(url); } catch { /* url invalida */ }
    return { action: "deny" };
  });
  // Trava a janela no app local: nunca navega pra conteudo remoto (que herdaria a
  // ponte 'elevate'). Links vao pelo handler acima.
  const blockNav = (e, url) => { try { if (new URL(url).protocol !== "file:") e.preventDefault(); } catch { e.preventDefault(); } };
  win.webContents.on("will-navigate", blockNav);
  win.webContents.on("will-redirect", blockNav);
  win.loadFile(path.join(__dirname, "index.html"));
}

// INSTANCIA UNICA: sem isto, abrir o app 2x (ex.: duplo-clique no atalho) criava
// DOIS processos ElevateHub, cada um com seu proprio controle de navegadores ->
// cada "Abrir" disparava um Chrome por instancia (outra fonte de "varios Chromes",
// alem de 2 sincronizacoes de cookie brigando no servidor). A 2a instancia agora
// so foca a janela que ja existe e encerra.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

app.whenReady().then(() => {
  app.setName(APP_NAME);
  Menu.setApplicationMenu(null);

  ipcMain.handle("open-external", async (_event, url) => {
    try {
      const parsed = new URL(String(url));
      if (parsed.protocol !== "https:") return false;
      await shell.openExternal(parsed.toString());
      return true;
    } catch {
      return false; // url invalida -> nao rejeita a Promise do renderer
    }
  });

  ipcMain.handle("open-browser-profile", async (event, info) => {
    return openBrowserProfile(info, event.sender);
  });

  ipcMain.handle("collect-ads-metrics", async (_event, info) => {
    return collectAdsMetrics(info);
  });

  // Abre o painel "Adicionar creators" (motor Afiliador) — reaproveita as contas,
  // perfis e logins do ElevateHub (sem relogar) e o Chrome que o app ja embute.
  ipcMain.handle("open-creators-panel", async (event, info) => {
    const sidecar = resolveCreatorsSidecar();
    if (!sidecar) return { ok: false, error: "no-sidecar" };
    // COLISAO DE PERFIL: se alguma conta marcada JA esta aberta no ElevateHub, o
    // painel subiria um 2o Chrome sobre o MESMO user-data-dir. Dois Chrome no mesmo
    // perfil brigam pelo lock -> um deles abre um perfil degradado/limpo (= conta
    // "abre DESLOGADA") e pode ate corromper a sessao gravada. Bloqueia com aviso,
    // igual o fluxo de ADS ja faz (openBrowsers.has). Usuario fecha e reabre.
    const selForBusy = Array.isArray(info?.accounts) ? info.accounts : [];
    const busy = selForBusy.filter((a) => openBrowsers.has(String(a.id)));
    if (busy.length) {
      return { ok: false, error: "busy", busy: busy.map((a) => String(a.name || a.id)) };
    }
    const dataDir = path.join(app.getPath("userData"), "creators");
    const urlFile = path.join(dataDir, "panel.url");
    // Espera o sidecar publicar o endereco (panel.url) e manda pro renderer, que o
    // carrega na webview. Se o sidecar morrer antes de publicar, ou estourar o tempo,
    // avisa com erro -> o overlay NAO fica preso em "abrindo..." pra sempre.
    const emitWhenReady = (panelRef) => { (async () => {
      for (let i = 0; i < 90; i++) {                 // ~18s
        let url = "";
        try { url = (await fs.readFile(urlFile, "utf8")).trim(); } catch { /* ainda nao escreveu */ }
        if (url) {
          if (event.sender && !event.sender.isDestroyed()) event.sender.send("creators-panel-ready", { url });
          return;
        }
        if (creatorsPanel && creatorsPanel.exitCode !== null) break;   // sidecar morreu cedo
        await sleep(200);
      }
      // Estourou o tempo e o sidecar NAO publicou o endereco -> esta travado, nao morto.
      // Mata pra nao virar processo orfao consumindo recursos ate o before-quit, E pra
      // que reabrir com a MESMA selecao gere um sidecar NOVO (senao cairia no ramo
      // "already" sobre o processo travado e estouraria timeout de novo, pra sempre).
      // So mata se ainda for o painel ATUAL (um reopen ja pode ter trocado a referencia).
      if (panelRef && creatorsPanel === panelRef && panelRef.exitCode === null) {
        try { killChrome(panelRef); } catch { /* ja morreu */ }
        if (creatorsPanel === panelRef) { creatorsPanel = null; creatorsAccountsKey = ""; }
      }
      if (event.sender && !event.sender.isDestroyed()) event.sender.send("creators-panel-ready", { error: "timeout" });
    })().catch(() => {}); };
    // Chave da selecao ATUAL (ids ordenados). Se for a MESMA do painel aberto,
    // reaproveita; se MUDOU, fecha o antigo e reabre com as contas novas (senao o
    // painel continuava mostrando as contas da abertura anterior — o bug do "3 Melt").
    const newKey = (Array.isArray(info?.accounts) ? info.accounts : [])
      .map((a) => String(a.id)).sort().join(",");
    if (creatorsLaunching) { emitWhenReady(creatorsPanel); return { ok: true, already: true }; }
    if (creatorsPanel && creatorsPanel.exitCode === null && !creatorsPanel.killed) {
      if (newKey === creatorsAccountsKey) {   // mesma selecao -> so mostra de novo
        emitWhenReady(creatorsPanel);
        return { ok: true, already: true };
      }
      // selecao diferente -> encerra o painel antigo pra reabrir com as novas contas
      try { killChrome(creatorsPanel); } catch { /* ja morreu */ }
      creatorsPanel = null;
    }
    creatorsLaunching = true;
    try {
      await fs.mkdir(dataDir, { recursive: true });
      const accounts = (Array.isArray(info?.accounts) ? info.accounts : []).map((a) => ({
        id: String(a.id),
        name: String(a.name || a.id),
        profileDir: profileDataDir(a.id)     // MESMO perfil do ElevateHub
      }));
      const cfg = {
        apiBase: API_URL,
        token: String(info?.token || ""),
        chromePath: resolveChromePath() || "",
        dataDir,
        embed: true,        // abre EMBUTIDO (webview no ElevateHub), nao janela propria
        accounts
      };
      const cfgPath = path.join(dataDir, "config.json");
      await atomicWrite(cfgPath, JSON.stringify(cfg));
      // Limpa o panel.url antigo pra ler o NOVO (nao um url de uma abertura passada).
      await fs.rm(urlFile, { force: true }).catch(() => {});
      const panel = spawn(sidecar, [], {
        detached: false,
        windowsHide: false,
        env: { ...process.env, ELEVATE_CREATORS_CONFIG: cfgPath }
      });
      creatorsPanel = panel;
      creatorsAccountsKey = newKey;   // lembra a selecao deste painel
      // So zera se o processo que saiu ainda for o ATUAL (exit atrasado do painel
      // velho nao pode apagar a referencia de um painel novo).
      panel.on("error", () => { if (creatorsPanel === panel) creatorsPanel = null; });
      panel.on("exit", () => { if (creatorsPanel === panel) creatorsPanel = null; });
      emitWhenReady(panel);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    } finally {
      creatorsLaunching = false;
    }
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

  // Estado do update sob demanda -> o renderer pergunta NO ARRANQUE e remostra a faixa
  // se ja ha versao baixada e pendente. Torna o aviso PERSISTENTE (reaparece a cada
  // abertura ate reiniciar de fato), em vez de depender do evento unico 'update-downloaded'.
  ipcMain.handle("get-update-status", () => ({ ready: autoUpdateReady, version: autoUpdateReadyVersion }));

  createWindow();
  if (app.isPackaged) setupAutoUpdate();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

} // fim do else (esta instancia ganhou o lock de instancia unica)

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Ao SAIR (inclusive quando o auto-update aplica no quit): mata os Chromes de
// conta e o painel de creators que ficariam ORFAOS. Sem isto, eles seguem vivos
// sem sincronizar cookies e travam o user-data-dir -> a proxima abertura da conta
// abre um 2o Chrome que e reencaminhado e sai ("fechou" com o velho ainda aberto).
let quitCleanupDone = false;
app.on("before-quit", () => {
  if (quitCleanupDone) return;
  quitCleanupDone = true;
  for (const entry of openBrowsers.values()) {
    try {
      if (entry?.firstSync) clearTimeout(entry.firstSync);
      if (entry?.interval) clearInterval(entry.interval);
      if (entry?.client) entry.client.close();
      if (entry?.child) killChrome(entry.child);
    } catch { /* best-effort no encerramento */ }
  }
  openBrowsers.clear();
  if (creatorsPanel) { try { killChrome(creatorsPanel); } catch { /* ja morreu */ } creatorsPanel = null; }
});
