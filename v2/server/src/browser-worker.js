const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");

const LOGIN_URL = "https://seller-br.tiktok.com/account/login";
const DEFAULT_VIEWPORT = { width: 1365, height: 768 };
const DRIVER = process.env.V2_BROWSER_DRIVER || "mock";
const MAX_SESSIONS = Number(process.env.V2_BROWSER_MAX_SESSIONS || 2);
const DATA_DIR = process.env.V2_BROWSER_DATA_DIR || path.join(__dirname, "..", "data", "browser-profiles");
const sessions = new Map();

function now() {
  return new Date().toISOString();
}

function slug(value) {
  return String(value || "perfil")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "perfil";
}

function isBlockedHost(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return true;
  // Os marketplaces sao DOMINIOS. Entao bloqueamos QUALQUER endereco IP literal
  // (v4/v6) e suas formas nao-canonicas (decimal, hex, octal, curtas, ::ffff:) —
  // e assim que se driblava o filtro antigo (ex: http://2130706433 = 127.0.0.1).
  if (h.includes(":")) return true;                       // IPv6 (inclui ::ffff:IPv4)
  if (net.isIP(h)) return true;                           // IP literal valido v4/v6
  // Qualquer host cujos segmentos sejam SO numeros/hex = forma de IP (decimal,
  // hex, octal, curta, ou mista tipo 0x7f.0.0.1). Dominios tem letras -> passam.
  if (/^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+))*$/i.test(h)) return true;
  return false;
}

function safeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return LOGIN_URL;
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withProto);
    if (url.protocol !== "http:" && url.protocol !== "https:") return LOGIN_URL;
    if (isBlockedHost(url.hostname)) return LOGIN_URL;               // bloqueia SSRF p/ rede interna
    return withProto;
  } catch {
    return LOGIN_URL;
  }
}

function publicSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    profileId: session.profileId,
    state: session.state,
    mode: session.mode,
    url: session.url,
    viewport: session.viewport,
    message: session.message,
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt
  };
}

function makeMockFrame(session) {
  const title = "Chrome remoto";
  const subtitle = session.mode === "mock"
    ? "Driver visual pronto. Falta instalar Chrome/Playwright no servidor."
    : "Sessao remota ativa.";
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${session.viewport.width}" height="${session.viewport.height}" viewBox="0 0 ${session.viewport.width} ${session.viewport.height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#071018"/>
      <stop offset="1" stop-color="#111b28"/>
    </linearGradient>
    <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#25f4ee"/>
      <stop offset="1" stop-color="#fe2c55"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <rect x="0" y="0" width="100%" height="56" fill="#0d141f"/>
  <circle cx="26" cy="28" r="7" fill="#ff627f"/>
  <circle cx="50" cy="28" r="7" fill="#f6c453"/>
  <circle cx="74" cy="28" r="7" fill="#33d69f"/>
  <rect x="106" y="14" width="${session.viewport.width - 132}" height="28" rx="7" fill="#070b10" stroke="#263548"/>
  <text x="122" y="33" fill="#8d9aae" font-family="Segoe UI, Arial" font-size="13">${escapeXml(session.url)}</text>
  <rect x="120" y="128" width="${session.viewport.width - 240}" height="360" rx="16" fill="#0c131d" stroke="#263548"/>
  <rect x="150" y="158" width="210" height="8" rx="4" fill="url(#bar)"/>
  <text x="150" y="218" fill="#eef5ff" font-family="Segoe UI, Arial" font-size="38" font-weight="700">${title}</text>
  <text x="150" y="262" fill="#b9c6d8" font-family="Segoe UI, Arial" font-size="18">${subtitle}</text>
  <text x="150" y="310" fill="#8d9aae" font-family="Segoe UI, Arial" font-size="15">Perfil: ${escapeXml(session.profileName)}</text>
  <text x="150" y="340" fill="#8d9aae" font-family="Segoe UI, Arial" font-size="15">Modo: ${escapeXml(session.mode)}</text>
  <text x="150" y="370" fill="#8d9aae" font-family="Segoe UI, Arial" font-size="15">Ultima atividade: ${escapeXml(session.lastActivityAt)}</text>
  <rect x="150" y="414" width="188" height="44" rx="8" fill="#25f4ee"/>
  <text x="183" y="442" fill="#061516" font-family="Segoe UI, Arial" font-size="15" font-weight="700">Aguardando driver</text>
</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function escapeXml(value) {
  return String(value || "").replace(/[<>&"']/g, (char) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "\"": "&quot;",
    "'": "&apos;"
  }[char]));
}

function getPlaywright() {
  try {
    return require("playwright");
  } catch {
    try {
      return require("playwright-core");
    } catch {
      return null;
    }
  }
}

async function startPlaywrightSession(profile, session) {
  const playwright = getPlaywright();
  if (!playwright) {
    session.mode = "mock";
    session.message = "playwright-core nao esta instalado no servidor.";
    return session;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const profileDir = path.join(DATA_DIR, slug(profile.id || profile.name));
  fs.mkdirSync(profileDir, { recursive: true });

  const launchOptions = {
    headless: true,
    viewport: session.viewport,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  };
  if (process.env.V2_CHROME_PATH) launchOptions.executablePath = process.env.V2_CHROME_PATH;

  const context = await playwright.chromium.launchPersistentContext(profileDir, launchOptions);
  const page = context.pages()[0] || await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(session.url, { waitUntil: "domcontentloaded" });
  session.context = context;
  session.page = page;
  session.mode = "playwright";
  session.state = "running";
  session.message = "Navegador remoto ativo.";
  return session;
}

async function startBrowserSession(profile, user) {
  const existing = sessions.get(profile.id);
  if (existing) {
    existing.lastActivityAt = now();
    return publicSession(existing);
  }

  if (sessions.size >= MAX_SESSIONS) {
    throw new Error(`Limite de ${MAX_SESSIONS} sessoes remotas simultaneas atingido.`);
  }

  const session = {
    id: `ses_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`,
    profileId: profile.id,
    profileName: profile.name,
    userId: user.id,
    state: "starting",
    mode: DRIVER,
    url: safeUrl(profile.startUrl || LOGIN_URL),
    viewport: DEFAULT_VIEWPORT,
    message: "Iniciando navegador remoto.",
    createdAt: now(),
    lastActivityAt: now(),
    context: null,
    page: null
  };
  sessions.set(profile.id, session);

  if (DRIVER === "playwright") {
    try {
      await startPlaywrightSession(profile, session);
    } catch (error) {
      session.mode = "mock";
      session.state = "running";
      session.message = `Falha ao iniciar Playwright: ${error.message}`;
    }
  } else {
    session.mode = "mock";
    session.state = "running";
    session.message = "Sessao remota de interface pronta. Driver Chrome ainda nao habilitado.";
  }

  session.lastActivityAt = now();
  return publicSession(session);
}

function getBrowserSession(profileId) {
  return publicSession(sessions.get(profileId));
}

async function getBrowserFrame(profileId) {
  const session = sessions.get(profileId);
  if (!session) return null;
  session.lastActivityAt = now();

  if (session.page) {
    const buffer = await session.page.screenshot({ type: "jpeg", quality: 72, fullPage: false });
    session.url = session.page.url();
    return {
      session: publicSession(session),
      image: `data:image/jpeg;base64,${buffer.toString("base64")}`
    };
  }

  return {
    session: publicSession(session),
    image: makeMockFrame(session)
  };
}

async function navigateBrowser(profileId, url) {
  const session = sessions.get(profileId);
  if (!session) return null;
  session.url = safeUrl(url);
  session.lastActivityAt = now();
  if (session.page) {
    await session.page.goto(session.url, { waitUntil: "domcontentloaded" });
  }
  return publicSession(session);
}

async function reloadBrowser(profileId) {
  const session = sessions.get(profileId);
  if (!session) return null;
  session.lastActivityAt = now();
  session.message = "Pagina atualizada.";
  if (session.page) {
    await session.page.reload({ waitUntil: "domcontentloaded" });
    session.url = session.page.url();
  }
  return publicSession(session);
}

async function goBackBrowser(profileId) {
  const session = sessions.get(profileId);
  if (!session) return null;
  session.lastActivityAt = now();
  session.message = "Voltou uma pagina.";
  if (session.page) {
    await session.page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
    session.url = session.page.url();
  }
  return publicSession(session);
}

async function goForwardBrowser(profileId) {
  const session = sessions.get(profileId);
  if (!session) return null;
  session.lastActivityAt = now();
  session.message = "Avancou uma pagina.";
  if (session.page) {
    await session.page.goForward({ waitUntil: "domcontentloaded" }).catch(() => null);
    session.url = session.page.url();
  }
  return publicSession(session);
}

async function clickBrowser(profileId, x, y) {
  const session = sessions.get(profileId);
  if (!session) return null;
  session.lastActivityAt = now();
  session.message = `Clique recebido em ${Math.round(x)},${Math.round(y)}.`;
  if (session.page) {
    await session.page.mouse.click(Number(x), Number(y));
  }
  return publicSession(session);
}

async function scrollBrowser(profileId, deltaX, deltaY) {
  const session = sessions.get(profileId);
  if (!session) return null;
  session.lastActivityAt = now();
  session.message = "Rolagem enviada para o navegador remoto.";
  if (session.page) {
    await session.page.mouse.wheel(Number(deltaX) || 0, Number(deltaY) || 0);
    session.url = session.page.url();
  }
  return publicSession(session);
}

async function typeBrowser(profileId, text) {
  const session = sessions.get(profileId);
  if (!session) return null;
  session.lastActivityAt = now();
  session.message = "Texto enviado para o navegador remoto.";
  if (session.page) {
    await session.page.keyboard.type(String(text || ""));
  }
  return publicSession(session);
}

async function pressBrowserKey(profileId, key) {
  const session = sessions.get(profileId);
  if (!session) return null;
  const normalized = String(key || "").trim();
  if (!normalized) return publicSession(session);
  session.lastActivityAt = now();
  session.message = `Tecla enviada: ${normalized}.`;
  if (session.page) {
    await session.page.keyboard.press(normalized);
    session.url = session.page.url();
  }
  return publicSession(session);
}

async function stopBrowserSession(profileId) {
  const session = sessions.get(profileId);
  if (!session) return false;
  sessions.delete(profileId);
  if (session.context) {
    await session.context.close().catch(() => {});
  }
  return true;
}

module.exports = {
  startBrowserSession,
  getBrowserSession,
  getBrowserFrame,
  navigateBrowser,
  reloadBrowser,
  goBackBrowser,
  goForwardBrowser,
  clickBrowser,
  scrollBrowser,
  typeBrowser,
  pressBrowserKey,
  stopBrowserSession
};
