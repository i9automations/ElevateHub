const state = {
  token: localStorage.getItem("ctv2.token") || sessionStorage.getItem("ctv2.token") || "",
  refreshToken: localStorage.getItem("ctv2.refresh") || sessionStorage.getItem("ctv2.refresh") || "",
  user: null,
  profiles: [],
  users: [],
  audit: [],
  mailboxes: [],
  selectedId: null,
  selectedSquad: localStorage.getItem("ctv2.squad") || "fox",
  currentSession: null,
  browserPoll: null,
  view: "profiles",
  filter: "all",
  sort: "az",
  // contas marcadas (checkbox) que vao pro painel "Adicionar creators". E um Set de
  // ids -> persiste entre pastas (voce marca contas de folders diferentes) e entre
  // reinicios do app (localStorage) -> um F5/restart nao perde as ~50 marcadas do dia.
  creatorsSelection: loadCreatorsSelection(),
  editProfileId: null,
  frameLoading: false,
  wheelTimer: null,
  wheelDeltaX: 0,
  wheelDeltaY: 0,
  updateInfo: null
};

const $ = (id) => document.getElementById(id);

function storeToken(token, refreshToken, remember) {
  try {
    const keep = remember ? localStorage : sessionStorage;
    const drop = remember ? sessionStorage : localStorage;
    keep.setItem("ctv2.token", token);
    drop.removeItem("ctv2.token");
    if (refreshToken) {
      keep.setItem("ctv2.refresh", refreshToken);
      drop.removeItem("ctv2.refresh");
    }
  } catch {
    // Armazenamento indisponivel não deve impedir o login na sessão atual.
  }
}

// Onde o login ficou salvo antes (localStorage = "lembrar"). Usado ao renovar
// pra manter o crachá no mesmo lugar.
function rememberedInLocal() {
  try { return localStorage.getItem("ctv2.token") !== null || localStorage.getItem("ctv2.refresh") !== null; }
  catch { return true; }
}

function clearToken() {
  try {
    localStorage.removeItem("ctv2.token");
    sessionStorage.removeItem("ctv2.token");
    localStorage.removeItem("ctv2.refresh");
    sessionStorage.removeItem("ctv2.refresh");
  } catch {
    // Ignorar falha ao limpar; a sessão já foi encerrada em memoria.
  }
}

// Troca o crachá de renovação por uma sessão nova (sem senha). Retorna true se
// conseguiu. Chamado automaticamente quando o token de acesso (~1h) vence.
let refreshInFlight = null; // single-flight: 401s simultaneos compartilham 1 refresh
async function tryRefresh() {
  if (!state.refreshToken) return false;
  // Se ja ha um refresh rodando, espera o MESMO (nao dispara outro). Sem isso,
  // varios 401 ao mesmo tempo (ex.: poll do remoto + loadProfiles) fariam N
  // trocas do cracha em paralelo -> se o servidor gira o refresh a cada uso, os
  // seguintes falham e o usuario cai pro login depois.
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${apiBase}/api/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: state.refreshToken })
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (!data.token) return false;
      state.token = data.token;
      if (data.refreshToken) state.refreshToken = data.refreshToken;
      if (data.user) state.user = data.user;
      storeToken(state.token, state.refreshToken, rememberedInLocal());
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}
const apiBase = window.elevate?.apiBase || "https://contas-v2.elevateecom.com.br";
const appVersion = window.elevate?.appVersion || "0.0.0";
const updateReleaseUrl = "https://api.github.com/repos/i9automations/ElevateHub/releases/tags/app-v2";
const MKT_URL = {
  tiktok: "https://seller-br.tiktok.com/account/login",
  ml: "https://www.mercadolivre.com.br/",
  shopee: "https://seller.shopee.com.br/",
  amazon: "https://sellercentral.amazon.com.br/"
};
// Logo do Chrome em UMA cor (traço), no mesmo estilo das iconezinhas da barra lateral.
// Usa currentColor -> pega a cor do botao "Abrir" (verde) e inverte sozinho no hover.
// SVG inline -> nao baixa nada externo, respeita a CSP.
const CHROME_ICON = '<svg class="chrome-ic" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">'
  + '<circle cx="12" cy="12" r="9.2"/>'
  + '<circle cx="12" cy="12" r="3.4"/>'
  + '<path d="M14.9 10.3 19.97 7.4"/>'
  + '<path d="M12 15.4 12 21.2"/>'
  + '<path d="M9.1 10.3 4.03 7.4"/></svg>';
const squads = [
  { key: "fox", name: "Fox", label: "TikTok Seller", startUrl: MKT_URL.tiktok, hub: "Elevate", mkt: "tiktok" },
  { key: "crown", name: "Crown", label: "Mercado Livre", startUrl: MKT_URL.ml, hub: "Elevate", mkt: "ml" },
  { key: "jaguar", name: "Jaguar", label: "Shopee Seller", startUrl: MKT_URL.shopee, hub: "Elevate", mkt: "shopee" },
  { key: "monkey", name: "Monkey", label: "Mercado Livre", startUrl: MKT_URL.ml, hub: "Elevate", mkt: "ml" },
  { key: "sphynx", name: "Sphynx", label: "Amazon Seller", startUrl: MKT_URL.amazon, hub: "Elevate", mkt: "amazon" },
  { key: "manalinda-tiktok", name: "TikTok", label: "TikTok Seller", startUrl: MKT_URL.tiktok, hub: "ManalindaHub", mkt: "tiktok" },
  { key: "manalinda-ml", name: "Mercado Livre", label: "Mercado Livre", startUrl: MKT_URL.ml, hub: "ManalindaHub", mkt: "ml" },
  { key: "manalinda-shopee", name: "Shopee", label: "Shopee Seller", startUrl: MKT_URL.shopee, hub: "ManalindaHub", mkt: "shopee" },
  { key: "manalinda-amazon", name: "Amazon", label: "Amazon Seller", startUrl: MKT_URL.amazon, hub: "ManalindaHub", mkt: "amazon" }
];
function squadOf(key) { return squads.find((s) => s.key === key) || squads[0]; }
// Marketplace EFETIVO do perfil: o padrao vem da pasta (squad), mas uma conta
// pode ser marcada individualmente como TikTok (ex: conta TikTok dentro da pasta
// Amazon) -> ai vale "tiktok" pra tudo (botao Codigo, spoof de UA, ADS, link).
function profileMkt(profile) {
  return profile?.isTikTok ? "tiktok" : squadOf(profileSquad(profile)).mkt;
}
function isTikTokProfile(profile) { return profileMkt(profile) === "tiktok"; }

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function isAdmin() {
  return state.user?.role === "admin";
}

function normalizeSquad(value) {
  const key = String(value || "fox").trim().toLowerCase();
  return squads.some((squad) => squad.key === key) ? key : "fox";
}

function selectedSquad() {
  return squads.find((squad) => squad.key === state.selectedSquad) || squads[0];
}

function profileSquad(profile) {
  return normalizeSquad(profile?.squad);
}

function profilesForSelectedSquad() {
  return state.profiles.filter((profile) => profileSquad(profile) === state.selectedSquad);
}

function roleLabel(role) {
  return role === "admin" ? "Admin" : "";
}

function canAccessView(view) {
  return view === "profiles" || view === "mailboxes" || view === "ads" || view === "reports" || isAdmin();
}

function compareVersions(left, right) {
  const a = String(left || "0").split(".").map((part) => Number(part) || 0);
  const b = String(right || "0").split(".").map((part) => Number(part) || 0);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function friendlyError(error) {
  const message = error?.message || "Não foi possível concluir agora.";
  if (isAdmin()) return message;
  if (/sess|remot|servidor|api|playwright|chrome|driver|vps|limite/i.test(message)) {
    return "Não foi possível abrir essa conta agora. Tente novamente em instantes.";
  }
  return message;
}

function setServer(text, ok = false) {
  $("serverState").textContent = text;
  $("serverState").style.color = ok ? "var(--success)" : "var(--warning)";
  $("settingsServerStatus").textContent = text;
}

function toast(message, tone = "info") {
  const item = document.createElement("div");
  item.className = `toast ${tone}`;
  item.textContent = message;
  $("toastStack").appendChild(item);
  window.setTimeout(() => item.classList.add("show"), 20);
  window.setTimeout(() => {
    item.classList.remove("show");
    window.setTimeout(() => item.remove(), 220);
  }, 4200);
}

async function api(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`${apiBase}${path}`, {
    ...options,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });
  // Token de acesso vencido (401): renova UMA vez com o crachá de renovação e
  // repete a chamada -> ninguém cai na tela de login a cada atualização/reinício.
  if (res.status === 401 && !options._retried && path !== "/api/auth/refresh" && state.refreshToken) {
    if (await tryRefresh()) {
      return api(path, { ...options, _retried: true });
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Carrega o status no erro pra quem chama distinguir 401 (auth de verdade)
    // de erro passageiro (500/rede) -> nao deslogar o usuario a toa.
    const err = new Error(data.error || "Não foi possível concluir agora.");
    err.status = res.status;
    throw err;
  }
  return data;
}

function showApp() {
  $("appShell").classList.remove("auth-mode");
  $("appShell").classList.toggle("admin-mode", isAdmin());
  document.body.classList.toggle("admin-mode", isAdmin());
  $("loginView").classList.add("hidden");
  $("dashboardView").classList.remove("hidden");
  $("appUserName").textContent = state.user?.name || "Equipe";
  $("appUserRole").textContent = roleLabel(state.user?.role);
  $("appUserRole").classList.toggle("hidden", !isAdmin());
  renderSquads();
  if (!canAccessView(state.view)) state.view = "profiles";
  setView(state.view);
  if (isAdmin()) renderSettings();
}

function showLogin() {
  $("appShell").classList.add("auth-mode");
  $("appShell").classList.remove("admin-mode");
  document.body.classList.remove("admin-mode");
  $("loginView").classList.remove("hidden");
  $("dashboardView").classList.add("hidden");
}

function requireAuth(action) {
  if (!state.token) {
    toast("Entre no aplicativo primeiro.", "warning");
    return;
  }
  action();
}

function requireAdminAction(action) {
  requireAuth(() => {
    if (!isAdmin()) {
      toast("Acesso exclusivo do admin.", "warning");
      return;
    }
    action();
  });
}

function renderSquads() {
  const counts = squads.reduce((acc, squad) => ({ ...acc, [squad.key]: 0 }), {});
  state.profiles.forEach((profile) => {
    const key = profileSquad(profile);
    counts[key] = (counts[key] || 0) + 1;
  });
  const mktIcon = {
    tiktok: { icon: "tiktok.svg", bg: "linear-gradient(150deg,#232323,#050505)", sz: 15 },
    ml: { icon: "mercadolivre.svg", bg: "linear-gradient(150deg,#ffffff,#f1f4f8)", sz: 20 },
    shopee: { icon: "shopee.svg", bg: "linear-gradient(150deg,#ff6a3d,#ee4d2d)", sz: 15 },
    amazon: { icon: "amazon.jpg", bg: "linear-gradient(150deg,#ffffff,#f1f4f8)", sz: 20 }
  };
  const hubs = [];
  squads.forEach((s) => { if (!hubs.includes(s.hub)) hubs.push(s.hub); });
  const collapsed = getCollapsedHubs();
  $("squadNav").innerHTML = hubs.map((hub) => {
    const hubCount = squads.filter((s) => s.hub === hub).reduce((n, s) => n + (counts[s.key] || 0), 0);
    // Hub sem nenhuma conta nao aparece (ex: ManalindaHub 0) — volta sozinho quando
    // ganhar a 1a conta. Excecao: se o usuario esta com uma pasta dele selecionada.
    const temSelecionada = squads.some((s) => s.hub === hub && s.key === state.selectedSquad);
    if (hubCount === 0 && !temSelecionada) return "";
    const items = squads.filter((s) => s.hub === hub).map((squad) => {
      const mk = mktIcon[squad.mkt] || mktIcon.tiktok;
      return `
      <button class="squad-item ${state.selectedSquad === squad.key ? "active" : ""}" type="button" data-squad="${squad.key}">
        <span class="squad-tile" style="background:${mk.bg}"><img src="./assets/marketplaces/${mk.icon}" alt="" style="width:${mk.sz}px;height:${mk.sz}px"></span>
        <span class="squad-txt">
          <strong>${escapeHtml(squad.name)}</strong>
          <span>${escapeHtml(squad.label)}</span>
        </span>
        <span class="squad-count">${counts[squad.key] || 0}</span>
      </button>`;
    }).join("");
    const isCol = collapsed.has(hub);
    return `<div class="hub-group${isCol ? " collapsed" : ""}" data-hub="${escapeHtml(hub)}">
      <button class="hub-label" type="button" data-hub-toggle="${escapeHtml(hub)}" aria-expanded="${!isCol}">
        <span class="hub-caret" aria-hidden="true"></span>
        <span class="hub-label-txt">${escapeHtml(hub)}</span>
        <span class="hub-total">${hubCount}</span>
      </button>
      <div class="hub-items">${items}</div>
    </div>`;
  }).join("");
}

// Grupos recolhidos (setinha na barra lateral). Guardado -> lembra entre sessoes.
function getCollapsedHubs() {
  try { return new Set(JSON.parse(localStorage.getItem("ctv2.collapsedHubs") || "[]")); }
  catch { return new Set(); }
}
function toggleHub(hub) {
  const set = getCollapsedHubs();
  if (set.has(hub)) set.delete(hub); else set.add(hub);
  try { localStorage.setItem("ctv2.collapsedHubs", JSON.stringify([...set])); } catch { /* cheio */ }
  renderSquads();
}

function selectedProfile() {
  return state.profiles.find((profile) => profile.id === state.selectedId) || null;
}

function canControl(profile) {
  // Acesso simultaneo: qualquer usuario logado pode abrir/gerenciar.
  return !!profile;
}

function profileStatus(profile) {
  if (profile.inUse) return { text: "em uso", cls: "busy" };
  if (profile.sessionState === "ready") return { text: "logada", cls: "ready" };
  return { text: "disponível", cls: "empty" };
}

function profileMatchesFilter(profile) {
  if (state.filter === "free") return !profile.inUse;
  if (state.filter === "ready") return profile.sessionState === "ready";
  if (state.filter === "busy") return !!profile.inUse;
  return true;
}

function renderMetrics() {
  const profiles = profilesForSelectedSquad();
  const total = profiles.length;
  const ready = profiles.filter((profile) => profile.sessionState === "ready").length;
  const busy = profiles.filter((profile) => profile.inUse).length;
  $("metricTotal").textContent = total;
  $("metricReady").textContent = ready;
  $("metricBusy").textContent = busy;
  $("metricFree").textContent = Math.max(total - busy, 0);
  if (state.view === "profiles") {
    const squad = selectedSquad();
    $("viewTitle").textContent = squad.name;
    $("viewSubtitle").textContent = `${squad.label} - ${total} perfis`;
  }
}

const AV_COLORS = ["#7c9cff", "#4fd6a0", "#59b8e5", "#e6a35c", "#e577a6", "#a78bfa", "#5bd1c4", "#f0883e"];
function profileAvatar(name) {
  const n = String(name || "").trim();
  const parts = n.split(/\s+/).filter(Boolean);
  const ini = ((parts[0]?.[0] || "") + (parts[1]?.[0] || parts[0]?.[1] || "")).toUpperCase() || "?";
  let h = 0;
  for (const ch of n) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { ini, col: AV_COLORS[h % AV_COLORS.length] };
}

function renderProfiles() {
  const term = $("search").value.trim().toLowerCase();
  const visible = profilesForSelectedSquad().filter((profile) => {
    const haystack = [
      profile.name,
      profile.tiktokEmail,
      profile.mailboxEmail,
      profile.responsavel,
      profile.lockedByName,
      profile.notes,
      selectedSquad().label,
      ...(profile.tags || [])
    ].join(" ").toLowerCase();
    return profileMatchesFilter(profile) && haystack.includes(term);
  });

  visible.sort((a, b) => {
    const cmp = String(a.name || "").localeCompare(String(b.name || ""), "pt-BR", { sensitivity: "base" });
    return state.sort === "za" ? -cmp : cmp;
  });

  $("emptyProfiles").classList.toggle("hidden", visible.length > 0);
  $("profileList").innerHTML = visible.map((profile) => {
    const status = profileStatus(profile);
    const selected = profile.id === state.selectedId ? " selected" : "";
    const pid = escapeHtml(profile.id); // defesa: id vai em atributos HTML
    const owner = profile.responsavel || "—";
    const editButton = `<button class="ghost compact" type="button" data-action="edit" data-id="${pid}" title="Editar">Editar</button>`;
    // Botão "Código" só no TikTok (qualquer hub); os outros marketplaces não precisam.
    const codeButton = isTikTokProfile(profile)
      ? `<button class="ghost compact" type="button" data-action="code" data-id="${pid}" title="Pegar código de verificação do e-mail">Código</button>`
      : "";
    // Botao "Capturar" (SO admin): salva o texto+link da pagina aberta da conta, pra
    // calibrar o relatorio. Abra a conta e navegue ate a secao antes de clicar.
    const captureButton = (isAdmin() && isTikTokProfile(profile))
      ? `<button class="ghost compact" type="button" data-action="capture" data-id="${pid}" title="Abra a conta e navegue até a seção; isto salva o texto da página (pra montar o relatório)">Capturar</button>`
      : "";
    const releaseButton = "";
    const openBtn = `<button class="run" type="button" data-action="open" data-id="${pid}">${CHROME_ICON}Abrir</button>`;
    const av = profileAvatar(profile.name);
    // Checkbox de "marcar pra creators": so nas contas TikTok (o painel e TikTok).
    // Nas outras vai um espaco vazio do mesmo tamanho, pra nao desalinhar o avatar.
    const crCheck = isTikTokProfile(profile)
      ? `<span class="cr-check${state.creatorsSelection.has(profile.id) ? " on" : ""}" data-action="cr-select" data-id="${pid}" title="Marcar para 'Adicionar creators'"></span>`
      : `<span class="cr-check cr-off"></span>`;
    return `
      <div class="profile-row${selected} st-row-${status.cls}" data-profile-id="${pid}">
        <div class="c-name">
          ${crCheck}
          <span class="avatar" style="background:${av.col}1f;color:${av.col}">${escapeHtml(av.ini)}</span>
          <span class="ntxt">
            <span class="nm" title="${escapeHtml(profile.name)}">${escapeHtml(profile.name)}</span>
            <span class="em" title="${escapeHtml(profile.tiktokEmail || "")}">${escapeHtml(profile.tiktokEmail || "—")}</span>
          </span>
        </div>
        <div class="pr-status"><span class="st st-${status.cls}"><i></i>${status.text}</span></div>
        <div class="pr-resp">${escapeHtml(owner)}</div>
        <div class="pr-last">${formatDate(profile.lastOpenedAt)}</div>
        <div class="pr-act">${editButton}${codeButton}${captureButton}${releaseButton}${openBtn}</div>
      </div>`;
  }).join("");

  renderSessionPane();
  updateCreatorsButton();   // mantem o contador de "marcadas pra creators" em dia
}

function syncBrowserOverlay() {
  const overlay = $("browserOverlay");
  if (!overlay) return;
  const active = !!state.currentSession
    && state.currentSession.profileId === state.selectedId
    && !state.browserHidden;
  overlay.classList.toggle("open", active);
}

function renderSessionPane() {
  const profile = selectedProfile();
  const status = profile ? profileStatus(profile) : { text: "nenhum", cls: "empty" };
  const hasSession = !!state.currentSession && state.currentSession.profileId === state.selectedId;
  const profileCanControl = canControl(profile);
  const canRelease = !!profile?.lockedBy && profileCanControl;
  syncBrowserOverlay();

  $("selectedName").textContent = profile ? profile.name : "Nenhum perfil";
  $("selectedEmail").textContent = profile
    ? `${profile.tiktokEmail || "sem e-mail"}${isAdmin() && profile.mailboxEmail ? ` | caixa ${profile.mailboxEmail}` : ""}`
    : "Selecione um cliente para abrir a conta.";

  $("selectedStatusPill").className = `badge ${status.cls}`;
  $("selectedStatusPill").textContent = status.text;
  $("lockLine").textContent = profile?.lockedBy
    ? `Em uso por ${profile.lockedByName || "outro usuário"}.`
    : "Perfil disponível.";

  const browserButtons = [
    "browserBackBtn",
    "browserForwardBtn",
    "browserRefreshBtn",
    "browserGoBtn",
    "browserTypeBtn",
    "browserEnterBtn",
    "browserTabBtn",
    "browserEscBtn"
  ];
  browserButtons.forEach((id) => { $(id).disabled = !hasSession; });
  $("browserUrl").disabled = !hasSession;
  $("browserText").disabled = !hasSession;
  $("openRemoteBtn").disabled = !profile || !profileCanControl;
  $("releaseBtn").disabled = !canRelease;

  if (hasSession && state.currentSession.url && document.activeElement !== $("browserUrl")) {
    $("browserUrl").value = state.currentSession.url;
  }

  if (!profile) {
    $("activityLog").textContent = "Selecione um perfil para iniciar.";
    return;
  }

  const savedText = profile.sessionState === "ready"
    ? "Conta pronta para abrir."
    : "Conta ainda não aberta neste app.";
  const remoteText = hasSession
    ? "Navegador aberto."
    : "Navegador fechado.";
  $("activityLog").textContent = `${savedText} ${remoteText}`;
}

async function loadProfiles() {
  const data = await api("/api/profiles");
  state.profiles = data.profiles || [];
  const currentProfiles = profilesForSelectedSquad();
  if (!currentProfiles.some((profile) => profile.id === state.selectedId)) {
    state.selectedId = currentProfiles[0]?.id || null;
  }
  renderSquads();
  renderMetrics();
  renderProfiles();
}

async function loadAudit() {
  if (!isAdmin()) return;
  const data = await api("/api/audit");
  state.audit = data.audit || [];
  renderAudit();
}

async function loadUsers() {
  if (!isAdmin()) return;
  const data = await api("/api/users");
  state.users = data.users || [];
  renderUsers();
}

async function login() {
  $("loginMsg").textContent = "Entrando...";
  try {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: {
        email: $("email").value.trim(),
        password: $("password").value
      }
    });
    state.token = data.token;
    state.refreshToken = data.refreshToken || "";
    state.user = data.user;
    storeToken(state.token, state.refreshToken, $("remember")?.checked !== false);
    setServer("conectado", true);
    showApp();
    await loadProfiles();
    checkForUpdates();
    toast("Login realizado.", "success");
  } catch (error) {
    $("loginMsg").textContent = friendlyError(error);
    setServer("erro de login");
  }
}

async function restoreSession() {
  // Com crachá de renovação, mesmo sem token de acesso válido dá pra voltar
  // logado: o api() renova sozinho no primeiro 401.
  if (!state.token && !state.refreshToken) return false;
  try {
    const data = await api("/api/me");
    state.user = data.user;
  } catch (error) {
    // So cai pro login se for falha de autenticacao DE VERDADE (401 apos o
    // refresh ja ter sido tentado dentro do api()). Um erro passageiro do
    // servidor (500) ou de rede NAO pode apagar o cracha e deslogar o usuario.
    if (error && error.status === 401) {
      clearToken();
      state.token = "";
      state.refreshToken = "";
      state.user = null;
      return false;
    }
    // Autenticado, mas o servidor esta instavel agora: mantem logado e mostra o
    // app. A lista de perfis tenta de novo sozinha; ninguem vai pra tela de login.
    setServer("sem conexão", false);
    showApp();
    return true;
  }
  setServer("conectado", true);
  showApp();
  // Se a lista falhar por erro passageiro, NAO desloga: so nao popula agora.
  try { await loadProfiles(); } catch { /* a lista se recarrega depois */ }
  checkForUpdates();
  return true;
}

// "Link ao abrir": opcoes fixas + personalizado. Vazio = padrao da pasta (squad).
const START_URL_OPTIONS = [MKT_URL.tiktok, MKT_URL.ml, MKT_URL.shopee, MKT_URL.amazon];
function setProfileStartUrl(startUrl, squad) {
  const sel = $("profileStartUrl");
  const custom = $("profileStartUrlCustom");
  if (!sel || !custom) return;
  const url = String(startUrl || "").trim();
  const squadDefault = squad?.startUrl || "";
  if (!url || url === squadDefault) sel.value = "";           // padrao da pasta
  else if (START_URL_OPTIONS.includes(url)) sel.value = url;  // um marketplace conhecido
  else sel.value = "__custom__";                              // link personalizado
  const isCustom = sel.value === "__custom__";
  custom.value = isCustom ? url : "";
  custom.classList.toggle("hidden", !isCustom);
}

// Le a escolha do link no dialogo. "" = padrao da pasta (o servidor resolve).
function readProfileStartUrl() {
  const sel = $("profileStartUrl");
  if (!sel) return "";
  if (sel.value === "__custom__") return $("profileStartUrlCustom")?.value.trim() || "";
  return sel.value || "";
}

// Preenche o seletor de pasta (agrupado por hub) do dialogo "Novo perfil".
function fillSquadSelect(selectedKey) {
  const sel = $("profileSquad");
  if (!sel) return;
  const hubs = [];
  squads.forEach((s) => { if (!hubs.includes(s.hub)) hubs.push(s.hub); });
  sel.innerHTML = hubs.map((hub) =>
    `<optgroup label="${escapeHtml(hub)}">` +
    squads.filter((s) => s.hub === hub).map((s) =>
      `<option value="${escapeHtml(s.key)}"${s.key === selectedKey ? " selected" : ""}>${escapeHtml(s.name)} — ${escapeHtml(s.label)}</option>`
    ).join("") +
    "</optgroup>"
  ).join("");
}

function openProfileDialog(profile = null) {
  const squad = profile ? squads.find((item) => item.key === profileSquad(profile)) || selectedSquad() : selectedSquad();
  state.editProfileId = profile?.id || null;
  $("profileDialogTitle").textContent = profile ? "Editar perfil" : "Novo perfil";
  $("profileSquadName").textContent = `${squad.name} - ${squad.label}`;
  // Ao CRIAR, deixa escolher a pasta (necessario p/ criar em hub vazio/escondido).
  // Ao EDITAR, mantem a pilula (mover de pasta segue so por admin/import).
  const editing = !!profile;
  $("profileSquadName").classList.toggle("hidden", !editing);
  $("profileSquadLabel").classList.toggle("hidden", editing);
  $("profileSquad").classList.toggle("hidden", editing);
  if (!editing) fillSquadSelect(state.selectedSquad);
  $("profileName").value = profile?.name || "";
  $("profileEmail").value = profile?.tiktokEmail || "";
  $("profileResp").value = profile?.responsavel || "";
  $("profileMailbox").value = profile?.mailboxEmail || "";
  $("profileTags").value = (profile?.tags || []).join(", ");
  $("profileNotes").value = profile?.notes || "";
  $("profileIsTikTok").checked = !!profile?.isTikTok;
  setProfileStartUrl(profile?.startUrl || "", squad);
  // Excluir so aparece ao editar um perfil existente
  $("deleteProfileBtn").classList.toggle("hidden", !profile);
  $("profileDialog").showModal();
}

function confirmAction({ title = "Confirmar", message = "", okLabel = "Confirmar", danger = false } = {}) {
  return new Promise((resolve) => {
    const dlg = $("confirmDialog");
    const okBtn = $("confirmOkBtn");
    const cancelBtn = $("confirmCancelBtn");
    $("confirmTitle").textContent = title;
    $("confirmMsg").textContent = message;
    okBtn.textContent = okLabel;
    okBtn.className = danger ? "danger" : "primary";
    const cleanup = () => {
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      dlg.removeEventListener("cancel", onCancel);
    };
    const onOk = () => { cleanup(); dlg.close(); resolve(true); };
    const onCancel = () => { cleanup(); dlg.close(); resolve(false); };
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    dlg.addEventListener("cancel", onCancel);
    dlg.showModal();
    cancelBtn.focus();
  });
}

async function deleteProfile() {
  const id = state.editProfileId;
  const profile = state.profiles.find((item) => item.id === id);
  if (!id) return;
  const nome = profile?.name || "este perfil";
  const ok = await confirmAction({
    title: "Excluir perfil",
    message: `Excluir "${nome}"? Essa ação não pode ser desfeita.`,
    okLabel: "Excluir",
    danger: true
  });
  if (!ok) return;
  try {
    await api(`/api/profiles/${id}`, { method: "DELETE" });
    $("profileDialog").close();
    if (state.selectedId === id) state.selectedId = null;
    // Tira da selecao de creators tambem -> senao o id "fantasma" ficava no Set,
    // era salvo no localStorage e desalinhava o contador do que e enviado.
    if (state.creatorsSelection.delete(id)) saveCreatorsSelection();
    await loadProfiles();
    toast("Perfil excluído.", "success");
  } catch (error) {
    toast(friendlyError(error), "danger");
  }
}

async function saveProfile(event) {
  event.preventDefault();
  const body = {
    name: $("profileName").value.trim(),
    tiktokEmail: $("profileEmail").value.trim(),
    responsavel: $("profileResp").value.trim(),
    notes: $("profileNotes").value.trim(),
    squad: state.editProfileId ? profileSquad(selectedProfile()) : ($("profileSquad").value || state.selectedSquad)
  };
  body.mailboxEmail = $("profileMailbox").value.trim();
  body.startUrl = readProfileStartUrl(); // "" = padrao da pasta
  body.isTikTok = $("profileIsTikTok").checked; // conta TikTok mesmo fora da pasta Fox
  if (isAdmin()) {
    body.tags = $("profileTags").value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  if (!body.name) {
    toast("Informe o nome do cliente.", "warning");
    return;
  }
  const editing = !!state.editProfileId;
  const path = editing ? `/api/profiles/${state.editProfileId}` : "/api/profiles";
  try {
    const data = await api(path, { method: editing ? "PATCH" : "POST", body });
    state.selectedId = data.profile.id;
    // Criou em outra pasta? Muda a pasta atual pra ela, senao o novo perfil nao
    // apareceria (a lista filtra pela pasta selecionada).
    if (!editing && data.profile?.squad && data.profile.squad !== state.selectedSquad) {
      state.selectedSquad = normalizeSquad(data.profile.squad);
      try { localStorage.setItem("ctv2.squad", state.selectedSquad); } catch { /* cheio */ }
    }
    $("profileDialog").close();
    await loadProfiles();
    toast(editing ? "Perfil atualizado." : "Perfil criado.", "success");
  } catch (error) {
    // ex.: e-mail de login duplicado -> mostra a mensagem clara em vez de falhar em silêncio.
    toast(friendlyError(error), "danger");
  }
}

function resetBrowserFrame() {
  $("browserFrame").classList.add("hidden");
  $("browserFrame").removeAttribute("src");
  $("screenGrid").classList.remove("hidden");
  $("screenCopy").classList.remove("hidden");
  $("browserUrl").value = "";
  $("browserText").value = "";
}

function startBrowserPolling() {
  stopBrowserPolling();
  state.browserPoll = setInterval(refreshBrowserFrame, 1300);
}

function stopBrowserPolling() {
  if (state.browserPoll) clearInterval(state.browserPoll);
  state.browserPoll = null;
}

async function openRemote(profileId) {
  state.selectedId = profileId;
  const profile = selectedProfile();
  if (!profile || !canControl(profile)) return;
  $("activityLog").textContent = `Abrindo conta de ${profile.name}...`;
  try {
    const data = await api(`/api/profiles/${profileId}/session/start`, { method: "POST" });
    state.currentSession = data.session || null;
    state.browserHidden = false;
    syncBrowserOverlay();
    startBrowserPolling();
    await loadProfiles();
    await refreshBrowserFrame(true);
    $("sessionScreen").focus();
  } catch (error) {
    const message = friendlyError(error);
    toast(message, "danger");
    $("activityLog").textContent = message;
  }
}

// Guard de duplo-clique no renderer: enquanto uma abertura esta em andamento,
// cliques repetidos no mesmo perfil sao ignorados (evita 2x lock/IPC/toast). A
// trava definitiva contra "varios Chromes" esta no main (openingProfiles); esta
// aqui e defesa em profundidade + evita o lock duplicado no servidor.
const openingLocal = new Set();

// Modelo Dolphin: abre o Chrome PROPRIO do app, no PC, com pasta isolada por conta.
async function openLocalBrowser(profileId) {
  state.selectedId = profileId;
  const profile = selectedProfile();
  if (!profile) return;
  if (!window.elevate?.openBrowserProfile) {
    toast("Esta versão do app ainda não abre o navegador local. Atualize o app.", "warning");
    return;
  }
  if (openingLocal.has(profileId)) return; // ja esta abrindo este perfil
  openingLocal.add(profileId);
  try {
  let inUseBy = [];
  try {
    const lock = await api(`/api/profiles/${profileId}/lock`, { method: "POST" });
    inUseBy = Array.isArray(lock?.inUseBy) ? lock.inUseBy : [];
  } catch {
    toast("Não consegui reservar a conta agora.", "danger");
    return;
  }
  const myName = state.user?.name || "";
  const others = inUseBy.filter((name) => name && name !== myName);
  if (others.length) {
    // ANTI-LOGOUT: abrir a MESMA conta em 2 PCs ao mesmo tempo = 2 IPs -> o TikTok
    // entende como invasao e DERRUBA a sessao (o gatilho nº1 dos logouts, confirmado).
    // Antes so avisava (toast) e abria: nao segurava ninguem. Agora pede confirmacao
    // CLARA, com Cancelar como padrao. Nao e bloqueio duro: se a pessoa esqueceu a
    // conta aberta (presenca antiga), da pra "Abrir mesmo assim" e assumir.
    const nomes = others.join(", ");
    const go = await confirmAction({
      title: "Conta aberta em outro PC agora",
      message: `${nomes} está com esta conta ABERTA neste momento. Abrir a mesma conta em dois PCs ao mesmo tempo é o que MAIS desloga a conta — o TikTok derruba a sessão. O ideal é pedir pra ${nomes} fechar antes. Abrir mesmo assim?`,
      okLabel: "Abrir mesmo assim",
      danger: true
    });
    if (!go) {
      // Desistiu: solta a reserva que o POST /lock acabou de registrar, senao EU
      // ficaria marcado como "em uso" sem ter aberto (bloquearia os outros a toa).
      await api(`/api/profiles/${profileId}/release`, { method: "POST" }).catch(() => {});
      return;
    }
  }
  try {
    // "Link ao abrir": usa o link escolhido no perfil (pode ser personalizado,
    // p/ clientes de mais de 1 marketplace); se vazio, cai no padrao da pasta.
    const mkt = profileMkt(profile); // "tiktok" se marcado, senao o da pasta
    // O servidor guarda startUrl SEMPRE preenchido (padrao da pasta quando o
    // usuario nao escolheu link). Entao: um link PERSONALIZADO (diferente do
    // padrao da pasta) sempre vence; se for o padrao e a conta for TikTok, abre
    // no login do TikTok; caso contrario, o padrao da pasta.
    const squadStart = squadOf(profileSquad(profile)).startUrl;
    let startUrl = profile.startUrl || squadStart;
    if (mkt === "tiktok" && (!profile.startUrl || profile.startUrl === squadStart)) {
      startUrl = MKT_URL.tiktok;
    }
    // Etapa 2: baixa a sessão (cookies) do servidor pra já abrir logado
    let cookies = [];
    try {
      const data = await api(`/api/profiles/${profileId}/cookies`);
      cookies = data.cookies || [];
    } catch {
      // sem sessão salva ainda: abre pra logar do zero (a 1a vez)
    }
    const result = await window.elevate.openBrowserProfile({ id: profileId, name: profile.name, url: startUrl, cookies, mkt });
    if (!result?.ok) {
      const reason = result?.error === "no-chrome"
        ? "Navegador do app não encontrado."
        : result?.error === "creators-busy"
        ? "Essa conta está sendo usada no painel de creators. Feche o painel de creators antes de abri-la aqui (abrir por cima deslogaria a sessão)."
        : "Não consegui abrir o navegador.";
      toast(reason, "danger");
      await api(`/api/profiles/${profileId}/release`, { method: "POST" }).catch(() => {});
      await loadProfiles().catch(() => {});
      return;
    }
    // Aberto com SUCESSO. Daqui pra frente, um erro passageiro ao recarregar a
    // lista NAO pode cair no catch e liberar o lock (senao o servidor acha o
    // perfil livre com o Chrome aberto). Por isso vai sem await e sem derrubar.
    toast(result.already ? `${profile.name} já esta aberto.` : `Abrindo ${profile.name}...`, "success");
    loadProfiles().catch(() => {});
  } catch (error) {
    toast(friendlyError(error), "danger");
    await api(`/api/profiles/${profileId}/release`, { method: "POST" }).catch(() => {});
    await loadProfiles();
  }
  } finally {
    openingLocal.delete(profileId);
  }
}

async function releaseLock(profileId = state.selectedId) {
  if (!profileId) return;
  try {
    await api(`/api/profiles/${profileId}/release`, { method: "POST" });
    if (state.currentSession?.profileId === profileId) {
      stopBrowserPolling();
      state.currentSession = null;
      resetBrowserFrame();
    }
    await loadProfiles();
    toast(isAdmin() ? "Perfil liberado." : "Acesso fechado.", "success");
  } catch (error) {
    toast(friendlyError(error), "danger");
  }
}

async function refreshBrowserFrame(force = false) {
  const profile = selectedProfile();
  if (!profile || !state.currentSession || state.currentSession.profileId !== profile.id) return;
  if (state.frameLoading && !force) return;
  state.frameLoading = true;
  try {
    const data = await api(`/api/profiles/${profile.id}/session/frame`);
    state.currentSession = data.session || state.currentSession;
    if (data.image) {
      $("browserFrame").src = data.image;
      $("browserFrame").classList.remove("hidden");
      $("screenGrid").classList.add("hidden");
      $("screenCopy").classList.add("hidden");
    }
    renderSessionPane();
  } catch (error) {
    $("activityLog").textContent = friendlyError(error);
  } finally {
    state.frameLoading = false;
  }
}

async function browserCommand(action, body = {}, shouldRefresh = true) {
  const profile = selectedProfile();
  if (!profile || !state.currentSession || !canControl(profile)) return null;
  try {
    const data = await api(`/api/profiles/${profile.id}/session/${action}`, {
      method: "POST",
      body
    });
    state.currentSession = data.session || state.currentSession;
    renderSessionPane();
    if (shouldRefresh) await refreshBrowserFrame(true);
    return data.session;
  } catch (error) {
    toast(friendlyError(error), "danger");
    return null;
  }
}

async function navigateBrowser() {
  const url = $("browserUrl").value.trim();
  await browserCommand("navigate", { url });
}

async function typeBrowserText() {
  const text = $("browserText").value;
  if (!text) return;
  await browserCommand("type", { text });
  $("browserText").value = "";
  $("sessionScreen").focus();
}

async function sendBrowserKey(key) {
  await browserCommand("key", { key });
  $("sessionScreen").focus();
}

function browserCoordinates(event) {
  const rect = $("browserFrame").getBoundingClientRect();
  const viewport = state.currentSession?.viewport || { width: 1365, height: 768 };
  const scale = Math.min(rect.width / viewport.width, rect.height / viewport.height);
  const renderedWidth = viewport.width * scale;
  const renderedHeight = viewport.height * scale;
  const offsetX = (rect.width - renderedWidth) / 2;
  const offsetY = (rect.height - renderedHeight) / 2;
  const x = (event.clientX - rect.left - offsetX) / scale;
  const y = (event.clientY - rect.top - offsetY) / scale;
  if (x < 0 || y < 0 || x > viewport.width || y > viewport.height) return null;
  return { x, y };
}

async function clickBrowserFrame(event) {
  if (event.target !== $("browserFrame")) return;
  const point = browserCoordinates(event);
  if (!point) return;
  $("sessionScreen").focus();
  await browserCommand("click", point);
}

function queueBrowserWheel(event) {
  if (!state.currentSession || $("browserFrame").classList.contains("hidden")) return;
  event.preventDefault();
  state.wheelDeltaX += event.deltaX;
  state.wheelDeltaY += event.deltaY;
  window.clearTimeout(state.wheelTimer);
  state.wheelTimer = window.setTimeout(async () => {
    const deltaX = state.wheelDeltaX;
    const deltaY = state.wheelDeltaY;
    state.wheelDeltaX = 0;
    state.wheelDeltaY = 0;
    await browserCommand("scroll", { deltaX, deltaY }, false);
    await refreshBrowserFrame(true);
  }, 90);
}

function keyFromEvent(event) {
  const aliases = {
    " ": "Space",
    Escape: "Escape",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown"
  };
  const modifiers = [];
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey && event.key.length !== 1) modifiers.push("Shift");
  if (event.metaKey) modifiers.push("Meta");
  const base = aliases[event.key] || (event.key.length === 1 ? event.key.toUpperCase() : event.key);
  return [...modifiers, base].join("+");
}

async function handleBrowserKeydown(event) {
  if (!state.currentSession) return;
  if (["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(event.target.tagName)) return;
  event.preventDefault();
  if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
    await browserCommand("type", { text: event.key });
    return;
  }
  await browserCommand("key", { key: keyFromEvent(event) });
}

async function runImport() {
  if (!isAdmin()) return;
  const text = $("importText").value.trim();
  if (!text) {
    toast("Cole um CSV ou selecione um arquivo.", "warning");
    return;
  }
  try {
    $("importResult").textContent = "Importando...";
    const data = await api("/api/profiles/import", {
      method: "POST",
      body: { csvText: text }
    });
    const result = data.result || {};
    $("importDialog").close();
    await loadProfiles();
    toast(`Importação concluída: ${result.created || 0} novos, ${result.updated || 0} atualizados.`, "success");
  } catch (error) {
    $("importResult").textContent = error.message;
  }
}

function renderAudit() {
  $("auditList").innerHTML = state.audit.length ? state.audit.map((item) => `
    <div class="audit-row">
      <strong>${escapeHtml(item.action)}</strong>
      <span>${escapeHtml(item.userName || "sistema")}</span>
      <span>${formatDate(item.at)}</span>
      <small>${escapeHtml(item.targetId || "-")}</small>
    </div>
  `).join("") : `<div class="empty-state"><strong>Nenhum evento ainda</strong><span>As ações aparecem aqui conforme o time usa o app.</span></div>`;
}

function renderUsers() {
  const canCreate = isAdmin();
  $("userForm").classList.toggle("disabled-panel", !canCreate);
  $("userForm").querySelectorAll("input, select, button").forEach((control) => {
    control.disabled = !canCreate;
  });
  $("userMsg").textContent = canCreate ? "" : "Somente admin pode criar usuários.";
  $("userList").innerHTML = state.users.map((user) => `
    <div class="user-row">
      <div class="avatar">${escapeHtml(String(user.name || "").slice(0, 2).toUpperCase())}</div>
      <div>
        <strong>${escapeHtml(user.name)}</strong>
        <span>${escapeHtml(user.email)}</span>
      </div>
      <span class="badge ${user.role === "admin" ? "ready" : "empty"}">${escapeHtml(user.role === "admin" ? "Admin" : "Operador")}</span>
    </div>
  `).join("");
}

async function createUser(event) {
  event.preventDefault();
  if (!isAdmin()) return;
  try {
    const data = await api("/api/users", {
      method: "POST",
      body: {
        name: $("userName").value.trim(),
        email: $("userEmail").value.trim(),
        role: $("userRole").value,
        password: $("userPassword").value.trim()
      }
    });
    $("userForm").reset();
    $("userMsg").textContent = `Senha inicial: ${data.temporaryPassword}`;
    await loadUsers();
    toast("Usuário criado.", "success");
  } catch (error) {
    $("userMsg").textContent = error.message;
  }
}

function renderSettings() {
  $("settingsApiUrl").textContent = apiBase;
  $("serverUrl").textContent = apiBase.replace(/^https?:\/\//, "");
}

// ---- Caixas de e-mail (Hostinger) para pegar códigos ----
async function loadMailboxes() {
  try {
    const data = await api("/api/mailboxes");
    state.mailboxes = Array.isArray(data.mailboxes) ? data.mailboxes : [];
  } catch {
    state.mailboxes = [];
  }
  renderMailboxes();
}

function mailboxRowHtml(box, i) {
  const pwPlaceholder = box.hasPassword ? "•••••• (guardada)" : "senha da caixa";
  return `
    <div class="mailbox-row" data-idx="${i}">
      <input class="mbx-label" placeholder="Apelido (ex: clientes1)" value="${escapeHtml(box.label || "")}">
      <input class="mbx-email" placeholder="email@dominio.com" value="${escapeHtml(box.email || "")}">
      <input class="mbx-pass" type="password" autocomplete="new-password" placeholder="${escapeHtml(pwPlaceholder)}" value="">
      <input class="mbx-host" placeholder="imap.hostinger.com" value="${escapeHtml(box.host || "imap.hostinger.com")}">
      <input class="mbx-port" placeholder="993" value="${escapeHtml(String(box.port || 993))}" style="max-width:70px">
      <button type="button" class="ghost compact mbx-test" title="Testar acesso">Testar</button>
      <button type="button" class="ghost compact mbx-del" title="Remover">✕</button>
      <span class="mbx-status" data-status></span>
    </div>`;
}

function renderMailboxes() {
  const list = $("mailboxList");
  if (!list) return;
  const boxes = state.mailboxes || [];
  list.innerHTML = boxes.length
    ? boxes.map(mailboxRowHtml).join("")
    : `<p class="mailbox-empty">Nenhuma caixa cadastrada ainda. Clique em “Adicionar caixa”.</p>`;
}

function readMailboxRows() {
  return [...document.querySelectorAll("#mailboxList .mailbox-row")].map((row, i) => {
    const val = (sel) => row.querySelector(sel)?.value.trim() || "";
    const existing = (state.mailboxes || [])[i] || {};
    return {
      id: existing.id,
      label: val(".mbx-label"),
      email: val(".mbx-email").toLowerCase(),
      password: row.querySelector(".mbx-pass")?.value || "", // vazio = manter a atual
      host: val(".mbx-host") || "imap.hostinger.com",
      port: Number(val(".mbx-port")) || 993
    };
  });
}

// Copia o que está digitado nas linhas para o state (preserva id/hasPassword),
// pra adicionar/remover uma linha não apagar o que já foi preenchido nas outras.
function syncMailboxStateFromDom() {
  const rows = readMailboxRows();
  state.mailboxes = rows.map((r, i) => ({
    ...(state.mailboxes || [])[i],
    label: r.label, email: r.email, host: r.host, port: r.port
  }));
}

async function saveMailboxesUI() {
  const mailboxes = readMailboxRows().filter((b) => b.email);
  try {
    const data = await api("/api/mailboxes", { method: "PUT", body: { mailboxes } });
    state.mailboxes = data.mailboxes || [];
    renderMailboxes();
    toast("Caixas salvas com segurança.", "success");
  } catch (error) {
    toast(friendlyError(error), "danger");
  }
}

async function testMailboxRow(rowEl) {
  const idx = Number(rowEl.dataset.idx);
  const statusEl = rowEl.querySelector("[data-status]");
  const rows = readMailboxRows();
  const box = rows[idx];
  if (!box?.email) { toast("Preencha o e-mail da caixa.", "warning"); return; }
  if (!box.password && !box.id) { toast("Digite a senha da caixa para testar.", "warning"); return; }
  statusEl.textContent = "testando…";
  statusEl.className = "mbx-status testing";
  try {
    // se a senha do campo está vazia mas a caixa já existe salva, testa pela id
    const body = box.password ? box : { id: box.id };
    const result = await api("/api/mailboxes/test", { method: "POST", body });
    if (result.ok) { statusEl.textContent = "✓ conectou"; statusEl.className = "mbx-status ok"; }
    else { statusEl.textContent = "✕ " + (result.error || "falhou"); statusEl.className = "mbx-status err"; }
  } catch (error) {
    statusEl.textContent = "✕ " + friendlyError(error);
    statusEl.className = "mbx-status err";
  }
}

// ---- Pegar código de verificação de um cliente ----
// Captura o texto+link da página aberta da conta (pra calibrar o relatório).
async function captureProfilePage(id) {
  if (!window.elevate?.capturePage) { toast("Atualize o app pra usar a captura.", "warning"); return; }
  toast("Capturando a página aberta da conta…", "info");
  try {
    const r = await window.elevate.capturePage({ profileId: id });
    if (r?.ok) {
      toast(`Página salva na Área de Trabalho (${r.chars} caracteres). Me manda o arquivo.`, "success");
    } else if (r?.error === "closed" || r?.error === "nenhuma página aberta") {
      toast("Abra a conta primeiro (botão Abrir) e navegue até a seção, depois clique em Capturar.", "warning");
    } else {
      toast(`Não consegui capturar: ${r?.error || "erro"}.`, "danger");
    }
  } catch (e) {
    toast(friendlyError(e), "danger");
  }
}

async function fetchProfileCode(profile) {
  if (!profile) return;
  const dlg = $("codeDialog");
  $("codeTitle").textContent = `Código — ${profile.name}`;
  $("codeSub").textContent = "Procurando o código nas caixas…";
  $("codeBox").classList.add("hidden");
  $("codeMeta").textContent = "";
  $("codeRetryBtn").disabled = true;
  dlg.dataset.profileId = profile.id;
  if (!dlg.open) dlg.showModal();
  try {
    const data = await api(`/api/profiles/${profile.id}/code`, { method: "POST", body: {} });
    $("codeValue").textContent = data.code;
    $("codeBox").classList.remove("hidden");
    $("codeSub").textContent = "Código encontrado:";
    const when = data.at ? formatDate(data.at) : "";
    $("codeMeta").textContent = `Caixa: ${data.box || "—"} · ${when}${data.subject ? ` · "${data.subject}"` : ""}`;
  } catch (error) {
    $("codeSub").textContent = friendlyError(error);
    $("codeMeta").textContent = "Dica: o código chega em até alguns minutos. Tente “Procurar de novo”.";
  } finally {
    $("codeRetryBtn").disabled = false;
  }
}

// Fase 1 do Relatório de ADS: lê as métricas de 1 loja e mostra (pra conferir com o print).
const adsBrl = (v) => "R$ " + (Number(v) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function renderAdsResults(items) {
  const el = $("adsResults");
  if (!el) return;
  if (!items.length) { el.innerHTML = ""; return; }
  const rows = items.map((it) => `
    <tr>
      <td>${escapeHtml(it.cli)}</td>
      <td>${it.erro ? `<span class="ads-err">${escapeHtml(it.erro)}</span>` : adsBrl(it.custo)}</td>
      <td>${it.erro ? "—" : (it.pedidos || 0)}</td>
      <td>${it.erro ? "—" : adsBrl(it.receita)}</td>
      <td>${it.erro ? "—" : (Number(it.roi) || 0).toFixed(2) + "x"}</td>
    </tr>`).join("");
  el.innerHTML = `<table class="ads-table"><thead><tr><th>Conta</th><th>Custo</th><th>Pedidos</th><th>Receita</th><th>ROI</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function loadPrevAds() { try { return JSON.parse(localStorage.getItem("ctv2.adsLast") || "null"); } catch { return null; } }
function saveCurrentAds(items) { try { localStorage.setItem("ctv2.adsLast", JSON.stringify({ items })); } catch { /* cheio */ } }

async function generateAdsReport() {
  if (!window.elevate?.collectAdsMetrics || !window.elevate?.saveOpenReport) {
    toast("Atualize o app para gerar o relatório de ADS.", "warning"); return;
  }
  const profiles = state.profiles.filter(isTikTokProfile);
  if (!profiles.length) { toast("Nenhuma conta TikTok encontrada.", "warning"); return; }
  const btn = $("genAdsReportBtn");
  const prog = $("adsProgress");
  btn.disabled = true;
  const items = [];
  for (let i = 0; i < profiles.length; i++) {
    const p = profiles[i];
    prog.textContent = `Lendo ${i + 1}/${profiles.length}: ${p.name}…`;
    let cookies = [];
    try { const d = await api(`/api/profiles/${p.id}/cookies`); cookies = d.cookies || []; } catch { /* sem sessão */ }
    let r;
    try { r = await window.elevate.collectAdsMetrics({ id: p.id, name: p.name, cookies }); }
    catch (e) { r = { ok: false, motivo: friendlyError(e) }; }
    const resp = p.responsavel || "";
    if (r?.ok) items.push({ cli: p.name, resp, ...r.metrics, erro: null });
    else items.push({ cli: p.name, resp, custo: 0, pedidos: 0, cpp: 0, receita: 0, roi: 0, erro: r?.motivo || "erro" });
    renderAdsResults(items);
  }
  const erros = items.filter((it) => it.erro).length;
  prog.textContent = `Concluído: ${items.length} contas${erros ? ` (${erros} com erro)` : ""}.`;
  btn.disabled = false;

  const prev = loadPrevAds();
  const html = buildAdsReportHtml(items, prev);
  saveCurrentAds(items);
  try {
    const res = await window.elevate.saveOpenReport(html);
    if (res?.ok) { state.lastAdsReport = res.path; toast("Relatório gerado e aberto.", "success"); }
    else toast("Relatório gerado, mas não consegui abrir sozinho.", "warning");
  } catch (e) { toast(friendlyError(e), "danger"); }
}

const ADS_REPORT_TEMPLATE = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relatório de ADS — __REF__</title><style>
:root{--bg:#0f1419;--card:#1a2027;--card2:#222b34;--line:#2c3742;--txt:#e6edf3;--muted:#8b95a3;--teal:#1fb6a6;--teal2:#16d1c0;--green:#2ecc71;--yellow:#f5c451;--red:#ff6b6b;--blue:#5aa9ff}
*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Segoe UI',Arial,sans-serif;background:var(--bg);color:var(--txt);padding:30px 20px;line-height:1.5}
.wrap{max-width:1280px;margin:0 auto}
header{border-bottom:2px solid var(--teal);padding-bottom:16px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:12px}
h1{font-size:25px}h1 span{color:var(--teal2)}.sub{color:var(--muted);font-size:13px;margin-top:5px}
.btn{background:var(--card2);border:1px solid var(--line);color:var(--txt);padding:9px 15px;border-radius:9px;font-size:13px;cursor:pointer}.btn:hover{border-color:var(--teal)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin-bottom:24px}
.kpi{background:linear-gradient(160deg,var(--card),var(--card2));border:1px solid var(--line);border-radius:14px;padding:16px 18px}
.kpi .l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.5px}.kpi .v{font-size:23px;font-weight:800;margin-top:5px}
.v.y{color:var(--yellow)}.v.g{color:var(--green)}.v.t{color:var(--teal2)}.v.b{color:var(--blue)}
h2{font-size:17px;margin:8px 0 14px;display:flex;align-items:center;gap:8px}h2::before{content:"";width:4px;height:16px;background:var(--teal);border-radius:2px}
.respgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;margin-bottom:26px}
.respc{background:var(--card2);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.respc .nm{font-weight:700;font-size:15px}.respc .s{color:var(--muted);font-size:12px;margin:2px 0 10px}
.rk{display:grid;grid-template-columns:1fr 1fr;gap:8px}.rk div{background:rgba(255,255,255,.02);border:1px solid var(--line);border-radius:8px;padding:7px 9px}
.rk span{color:var(--muted);font-size:10px;text-transform:uppercase;display:block}.rk b{font-size:15px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.c{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:16px}
.c.err{border-left:4px solid var(--red)}.c.top{border-left:4px solid var(--green)}.c.zero{opacity:.75}
.c .h{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.c .cli{font-size:16px;font-weight:700}.c .rsp{font-size:11px;color:var(--blue);background:rgba(90,169,255,.12);padding:2px 7px;border-radius:6px;margin-left:6px}
.roi{font-weight:800;font-size:18px;padding:3px 9px;border-radius:8px}.roi.hi{background:rgba(46,204,113,.15);color:var(--green)}.roi.mid{background:rgba(90,169,255,.15);color:var(--blue)}.roi.low{background:rgba(245,196,81,.15);color:var(--yellow)}.roi.z{background:rgba(139,152,165,.15);color:var(--muted)}
.mt{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.m{background:var(--card2);border-radius:8px;padding:8px 10px}.m .l{color:var(--muted);font-size:10px;text-transform:uppercase}.m .v{font-size:15px;font-weight:700;margin-top:2px}.m .v.g{color:var(--green)}
.alert{margin-top:10px;font-size:12px;padding:7px 9px;border-radius:8px;background:rgba(255,107,107,.13);color:var(--red)}
footer{margin-top:34px;padding-top:16px;border-top:1px solid var(--line);color:var(--muted);font-size:12px;text-align:center}
</style></head><body><div class="wrap">
<header><div><h1>Relatório de <span>ADS</span> — TikTok GMV Max</h1><div class="sub">Referência: __REF__ · valores em BRL</div></div>
<button class="btn" onclick="exportCSV()">Exportar CSV</button></header>
<div class="cards">
<div class="kpi"><div class="l">Investimento</div><div class="v y">__KPI_CUSTO__</div></div>
<div class="kpi"><div class="l">Receita (GMV)</div><div class="v g">__KPI_RECEITA__</div></div>
<div class="kpi"><div class="l">ROI geral</div><div class="v t">__KPI_ROI__</div></div>
<div class="kpi"><div class="l">Pedidos</div><div class="v b">__KPI_PEDIDOS__</div></div>
<div class="kpi"><div class="l">Contas vendendo</div><div class="v">__KPI_VEND__</div></div>
</div>
<h2>Resumo por responsável</h2><div class="respgrid" id="resp"></div>
<h2>Contas</h2><div class="grid" id="grade"></div>
<footer>Gerado pelo ElevateHub · Referência __REF__</footer></div>
<script>
var dados=__DADOS__, resp=__RESP__;
function brl(v){return "R$ "+(Number(v)||0).toLocaleString("pt-BR",{minimumFractionDigits:2,maximumFractionDigits:2});}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}
function roiCls(r){if(r>=8)return"hi";if(r>=4)return"mid";if(r>0)return"low";return"z";}
var rk=Object.keys(resp).sort();
document.getElementById("resp").innerHTML=rk.map(function(nm){var o=resp[nm];var roi=o.c>0?o.r/o.c:0;
return '<div class="respc"><div class="nm">'+esc(nm)+'</div><div class="s">'+o.l+' contas · '+o.v+' vendendo</div><div class="rk"><div><span>Investido</span><b style="color:var(--yellow)">'+brl(o.c)+'</b></div><div><span>Receita</span><b style="color:var(--green)">'+brl(o.r)+'</b></div><div><span>ROI</span><b style="color:var(--teal2)">'+roi.toFixed(2)+'x</b></div><div><span>Pedidos</span><b style="color:var(--blue)">'+(o.p||0)+'</b></div></div></div>';}).join("");
var ord=dados.slice().sort(function(a,b){if(a.erro&&!b.erro)return 1;if(b.erro&&!a.erro)return -1;return (b.receita||0)-(a.receita||0);});
document.getElementById("grade").innerHTML=ord.map(function(d){
if(d.erro){return '<div class="c err"><div class="h"><div class="cli">'+esc(d.cli)+(d.resp?'<span class="rsp">'+esc(d.resp)+'</span>':'')+'</div></div><div class="alert">Não foi possível ler: '+esc(d.erro)+'</div></div>';}
var cls="c";if(d.roi>=8)cls+=" top";if((d.pedidos||0)===0)cls+=" zero";
return '<div class="'+cls+'"><div class="h"><div class="cli">'+esc(d.cli)+(d.resp?'<span class="rsp">'+esc(d.resp)+'</span>':'')+'</div><div class="roi '+roiCls(d.roi)+'">'+(Number(d.roi)||0).toFixed(2)+'x</div></div><div class="mt"><div class="m"><div class="l">Custo</div><div class="v">'+brl(d.custo)+'</div></div><div class="m"><div class="l">Pedidos</div><div class="v">'+(d.pedidos||0)+'</div></div><div class="m"><div class="l">Custo/Ped.</div><div class="v">'+brl(d.cpp)+'</div></div><div class="m"><div class="l">Receita</div><div class="v g">'+brl(d.receita)+'</div></div></div></div>';}).join("");
function exportCSV(){var h=["Conta","Responsavel","Custo","Pedidos","Custo por pedido","Receita","Ticket medio","ROI","Erro"];
var ln=dados.map(function(d){return [d.cli,d.resp||"",(d.custo||0).toFixed(2).replace(".",","),(d.pedidos||0),(d.cpp||0).toFixed(2).replace(".",","),(d.receita||0).toFixed(2).replace(".",","),(d.ticket||0).toFixed(2).replace(".",","),(Number(d.roi)||0).toFixed(2).replace(".",","),d.erro||""];});
function q(c){c=String(c==null?"":c);if(/^[=+\\-@\\t\\r]/.test(c))c="'"+c;return '"'+c.replace(/"/g,'""')+'"';}
var csv=[h].concat(ln).map(function(r){return r.map(q).join(";");}).join("\\r\\n");
var b=new Blob(["\\ufeff"+csv],{type:"text/csv;charset=utf-8;"});var a=document.createElement("a");a.href=URL.createObjectURL(b);a.download="Relatorio_ADS.csv";a.click();}
</script></body></html>`;

function buildAdsReportHtml(items, prev) {
  const ativos = items.filter((it) => !it.erro);
  const tot = (k) => ativos.reduce((s, it) => s + (Number(it[k]) || 0), 0);
  const tC = tot("custo"), tR = tot("receita"), tP = tot("pedidos");
  const roiG = tC > 0 ? tR / tC : 0;
  const vendendo = ativos.filter((it) => it.pedidos > 0).length;
  const ref = new Date().toLocaleDateString("pt-BR");
  // resumo por responsável
  const porResp = {};
  items.forEach((it) => {
    const r = it.resp || "—";
    const o = porResp[r] || (porResp[r] = { c: 0, r: 0, p: 0, l: 0, v: 0 });
    o.c += Number(it.custo) || 0; o.r += Number(it.receita) || 0; o.p += Number(it.pedidos) || 0;
    o.l++; if ((it.pedidos || 0) > 0) o.v++;
  });
  // Escapa "<" no JSON embutido no <script> (evita que um nome com "</script>"
  // quebre o relatório). E usa REPLACER EM FUNÇÃO em tudo, pra um nome com "$&",
  // "$'" etc. nao ser interpretado pelo String.replace (corromperia o HTML).
  const safeJson = (obj) => JSON.stringify(obj).replace(/</g, "\\u003c");
  const put = (tpl, ph, val) => tpl.replace(ph, () => val);
  let html = ADS_REPORT_TEMPLATE.replace(/__REF__/g, () => ref);
  html = put(html, "__KPI_CUSTO__", adsBrl(tC));
  html = put(html, "__KPI_RECEITA__", adsBrl(tR));
  html = put(html, "__KPI_ROI__", roiG.toFixed(2) + "x");
  html = put(html, "__KPI_PEDIDOS__", tP.toLocaleString("pt-BR"));
  html = put(html, "__KPI_VEND__", `${vendendo} / ${ativos.length}`);
  html = put(html, "__RESP__", safeJson(porResp));
  html = put(html, "__DADOS__", safeJson(items));
  return html;
}

async function setView(view) {
  if (!canAccessView(view)) view = "profiles";
  state.view = view;
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  renderSquads();
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("active", section.id === `${view}View`);
  });

  const squad = selectedSquad();
  const titles = {
    profiles: [squad.name, `${squad.label} - ${profilesForSelectedSquad().length} perfis`],
    mailboxes: ["Caixas de e-mail", "Códigos de verificação por e-mail"],
    ads: ["Relatório de ADS", "Métricas de anúncios do TikTok"],
    reports: ["Relatórios Semanais", "Mensagem pronta por cliente — últimos 7 dias"],
    audit: ["Auditoria", "Histórico recente de acessos"],
    team: ["Equipe", "Usuários do aplicativo"],
    settings: ["Configuração", "Servidor e operação"]
  };
  $("viewTitle").textContent = (titles[view] || titles.profiles)[0];
  $("viewSubtitle").textContent = (titles[view] || titles.profiles)[1];

  if (view === "audit") await loadAudit();
  if (view === "team") await loadUsers();
  if (view === "mailboxes") await loadMailboxes();
  if (view === "settings") renderSettings();
  if (view === "reports") loadReportSellers().catch(() => {});
}

async function refreshCurrentView() {
  if (!state.token) return boot();
  if (state.view === "profiles") await loadProfiles();
  if (state.view === "mailboxes") await loadMailboxes();
  if (isAdmin() && state.view === "audit") await loadAudit();
  if (isAdmin() && state.view === "team") await loadUsers();
  if (isAdmin() && state.view === "settings") renderSettings();
}

// Atualização automática: o motor (electron-updater no main) checa e baixa
// sozinho, em segundo plano, so os pedacos que mudaram (delta). Aqui o
// renderer so REAGE aos eventos.
function checkForUpdates() {
  // Sem acao: o main verifica ao abrir e de hora em hora automaticamente.
}

function showUpdateReady(info) {
  if (info) state.updateInfo = info;
  const v = state.updateInfo?.version;
  // Aviso DISCRETO no topo do app (faixa), NUNCA um pop-up no meio da tela.
  const verEl = $("updateBannerVer");
  if (verEl) verEl.textContent = v ? ` (${v})` : "";
  $("updateBanner")?.classList.remove("hidden");
  $("appShell")?.classList.add("has-update-banner"); // empurra o app pra baixo
  $("updateAvailableBtn")?.classList.remove("hidden"); // botão no topbar tb (fallback)
}

function dismissUpdate() {
  // "Agora não": some a faixa; o botão "Atualização disponível" no topo continua.
  $("updateBanner")?.classList.add("hidden");
  $("appShell")?.classList.remove("has-update-banner");
}

async function installUpdate() {
  const btn = $("updateBannerNow");
  if (btn) { btn.disabled = true; btn.textContent = "Reiniciando…"; }
  try {
    if (window.elevate?.installUpdateNow) await window.elevate.installUpdateNow();
  } catch {
    if (btn) { btn.disabled = false; btn.textContent = "Atualizar agora"; }
  }
}

const installScreen = (() => {
  const root = $("installScreen");
  const stage = $("installStage");
  const bar = $("installBar");
  const pctEl = $("installPct");
  const statusEl = $("installStatus");
  const footerEl = $("installFooter");

  function fit() {
    if (!stage) return;
    const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    stage.style.transform = `translate(-50%, -50%) scale(${scale})`;
  }

  function show(footer) {
    if (!root) return;
    if (footer && footerEl) footerEl.textContent = footer;
    root.classList.remove("install-hide");
    root.style.display = "block";
    fit();
  }

  function render(pct, label) {
    const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
    if (bar) bar.style.width = clamped.toFixed(1) + "%";
    if (pctEl) pctEl.textContent = Math.round(clamped) + "%";
    if (label && statusEl) statusEl.textContent = label;
  }

  function hide() {
    if (!root) return;
    root.classList.add("install-hide");
    setTimeout(() => { root.style.display = "none"; }, 650);
  }

  window.addEventListener("resize", fit);
  return { show, render, hide, fit };
})();

let splashTimer = null;
let splashSafety = null;
let splashDone = false;

function startSplash() {
  installScreen.show("Sincronizando seus canais de venda");
  installScreen.render(0, "Iniciando");
  const stages = [
    { to: 30, label: "Conectando" },
    { to: 60, label: "Sincronizando" },
    { to: 88, label: "Otimizando" }
  ];
  let pct = 0;
  let cur = 0;
  clearInterval(splashTimer);
  splashTimer = setInterval(() => {
    const stage = stages[Math.min(cur, stages.length - 1)];
    if (pct < stage.to) {
      pct = Math.min(stage.to, pct + (Math.random() * 2.4 + 0.6));
    } else if (cur < stages.length - 1) {
      cur += 1;
    }
    installScreen.render(pct, stage.label);
  }, 55);
  // Rede lenta nunca deve prender o funcionario no splash.
  splashSafety = setTimeout(finishSplash, 15000);
}

function finishSplash() {
  if (splashDone) return;
  splashDone = true;
  clearTimeout(splashSafety);
  clearInterval(splashTimer);
  let pct = parseFloat(($("installBar")?.style.width || "").replace("%", "")) || 88;
  const closer = setInterval(() => {
    pct = Math.min(100, pct + 3.5);
    installScreen.render(pct, pct >= 100 ? "Pronto para comecar" : "Otimizando");
    if (pct >= 100) {
      clearInterval(closer);
      setTimeout(() => {
        installScreen.hide();
        setTimeout(checkForUpdates, 500);
      }, 520);
    }
  }, 30);
}

async function boot() {
  state.selectedSquad = normalizeSquad(state.selectedSquad);
  $("settingsApiUrl").textContent = apiBase;
  try {
    await api("/api/health");
    setServer("online", true);
  } catch {
    setServer("offline");
  }
  const restored = await restoreSession();
  if (!restored) showLogin();
}

// Versao instalada visivel no rodape da sidebar -> da pra confirmar num relance se
// o app ja atualizou (o updater troca a versao ao fechar/reabrir). Antes a versao
// existia no codigo (appVersion) mas nao era exibida em lugar nenhum.
(() => { const el = $("appVersionLabel"); if (el) el.textContent = "v" + appVersion; })();

$("loginBtn").addEventListener("click", login);
$("password").addEventListener("keydown", (event) => {
  if (event.key === "Enter") login();
});
$("email").addEventListener("keydown", (event) => {
  if (event.key === "Enter") login();
});
$("togglePw")?.addEventListener("click", () => {
  const input = $("password");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("togglePw").textContent = show ? "Ocultar" : "Mostrar";
});
$("search").addEventListener("input", renderProfiles);
$("newProfileBtn").addEventListener("click", () => requireAuth(() => openProfileDialog()));
$("importBtn").addEventListener("click", () => requireAdminAction(() => $("importDialog").showModal()));
$("cancelProfileBtn").addEventListener("click", () => $("profileDialog").close());
$("profileStartUrl")?.addEventListener("change", () => {
  const custom = $("profileStartUrlCustom");
  const isCustom = $("profileStartUrl").value === "__custom__";
  custom.classList.toggle("hidden", !isCustom);
  if (isCustom) custom.focus();
});
$("deleteProfileBtn").addEventListener("click", deleteProfile);
$("cancelImportBtn").addEventListener("click", () => $("importDialog").close());
$("cancelUpdateBtn")?.addEventListener("click", dismissUpdate);
$("installUpdateBtn")?.addEventListener("click", installUpdate);
$("updateBannerNow")?.addEventListener("click", installUpdate);
$("updateBannerLater")?.addEventListener("click", dismissUpdate);
$("updateAvailableBtn")?.addEventListener("click", () => showUpdateReady());
$("profileDialog").addEventListener("submit", saveProfile);
$("runImportBtn").addEventListener("click", runImport);
$("importFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (file) $("importText").value = await file.text();
});

document.querySelectorAll(".nav-item").forEach((button) => {
  // Botoes de acao (ex: abrir o painel de creators) nao tem data-view -> ignora aqui.
  if (!button.dataset.view) return;
  button.addEventListener("click", () => requireAuth(() => setView(button.dataset.view)));
});

// Botao "Adicionar creators": abre o painel (motor Afiliador) EMBUTIDO no ElevateHub
// (uma webview na propria janela), reaproveitando as contas TikTok e os logins do
// app (sem relogar). Se a webview nao carregar, o sidecar tem fallback (janela).
$("creatorsBtn")?.addEventListener("click", () => requireAuth(async () => {
  if (!window.elevate?.openCreatorsPanel) {
    toast("Atualize o app para usar o painel de creators.", "warning");
    return;
  }
  // SO as contas MARCADAS (checkbox) — a lista de creators do dia. E TikTok.
  const accounts = state.profiles
    .filter((p) => state.creatorsSelection.has(p.id) && isTikTokProfile(p))
    .map((p) => ({ id: p.id, name: p.name }));
  if (!accounts.length) {
    toast("Marque as contas na lista (o quadradinho ao lado do nome) antes de abrir os creators.", "warning");
    return;
  }
  const view = $("creatorsView");
  const status = $("creatorsStatus");
  if (status) status.textContent = "abrindo painel…";
  if (view) view.removeAttribute("hidden");   // mostra o overlay embutido ja
  try {
    const r = await window.elevate.openCreatorsPanel({ accounts, token: state.token });
    if (r?.error === "no-sidecar") {
      if (view) view.setAttribute("hidden", "");
      toast("O componente de creators não está instalado nesta versão.", "warning");
    } else if (r?.error === "busy") {
      // Conta(s) marcada(s) ainda abertas no ElevateHub -> abrir o painel sobre o
      // mesmo perfil deslogaria/corromperia a sessao. Peca pra fechar antes.
      if (view) view.setAttribute("hidden", "");
      const nomes = (r.busy || []).join(", ");
      toast(`Feche primeiro: ${nomes}. Essa(s) conta(s) está(ão) aberta(s) no app — abrir os creators por cima deslogaria a sessão.`, "warning");
    }
    // Sucesso: o endereco chega via onCreatorsPanelReady e carrega a webview.
    // "already": o painel ja estava aberto -> a webview ja tem o conteudo, so mostra.
  } catch (e) {
    if (view) view.setAttribute("hidden", "");
    toast(friendlyError(e), "danger");
  }
}));

// O painel publicou seu endereco local -> carrega na webview embutida. Se veio com
// erro (o sidecar nao publicou a tempo / morreu), esconde o overlay e avisa (senao
// ficaria preso em "abrindo...").
window.elevate?.onCreatorsPanelReady?.((data) => {
  const frame = $("creatorsFrame");
  const view = $("creatorsView");
  const status = $("creatorsStatus");
  if (data?.error) {
    if (view) view.setAttribute("hidden", "");
    toast("Não consegui abrir o painel de creators. Tente de novo.", "danger");
    return;
  }
  const url = data?.url;
  if (!frame || !url) return;
  if (view) view.removeAttribute("hidden");
  if (status) status.textContent = "";
  frame.src = url;
});

// "Voltar": esconde o painel embutido. NAO descarrega a webview -> o painel segue
// vivo (leve) em segundo plano e reabrir e instantaneo; encerra sozinho no fim do app.
$("creatorsBack")?.addEventListener("click", () => {
  const view = $("creatorsView");
  if (view) view.setAttribute("hidden", "");
});

// Se a webview NAO carregar (CSP/erro de rede), esconde o overlay: o sidecar, sem
// receber ping, abre a janela propria (fallback) -> nunca fica um overlay vazio.
$("creatorsFrame")?.addEventListener("did-fail-load", (e) => {
  if (e && !e.isMainFrame) return;                                            // sub-recurso falhando != o painel caiu
  if (e && (e.validatedURL === "about:blank" || e.errorCode === -3)) return;  // navegacao proposital/abortada
  const view = $("creatorsView");
  if (view) view.setAttribute("hidden", "");
  toast("Abrindo o painel de creators em janela…", "info");
});

// Botao "Verificar sessoes" (admin): varre o servidor e diz quantas contas estao
// logadas DE VERDADE (tem sessao principal) e quais precisam de re-login. So-leitura.
$("healthBtn")?.addEventListener("click", () => requireAuth(async () => {
  const btn = $("healthBtn");
  const prev = btn.textContent;
  btn.disabled = true; btn.textContent = "Verificando...";
  try {
    const h = await api("/api/profiles/health");
    const need = Array.isArray(h.needRelogin) ? h.needRelogin : [];
    toast(`${h.loggedIn} de ${h.total} contas logadas.`, need.length ? "info" : "success");
    if (need.length) {
      const nomes = need.map((x) => x.name).slice(0, 12).join(", ");
      const resto = need.length > 12 ? ` (+${need.length - 12})` : "";
      toast(`${need.length} precisam re-login: ${nomes}${resto}`, "warning");
    }
  } catch (e) {
    toast(friendlyError(e), "danger");
  } finally {
    btn.disabled = false; btn.textContent = prev;
  }
}));
$("squadNav").addEventListener("click", (event) => {
  const toggle = event.target.closest("button[data-hub-toggle]");
  if (toggle) { toggleHub(toggle.dataset.hubToggle); return; }
  const button = event.target.closest("button[data-squad]");
  if (!button) return;
  requireAuth(() => {
    state.selectedSquad = normalizeSquad(button.dataset.squad);
    localStorage.setItem("ctv2.squad", state.selectedSquad);
    const currentProfiles = profilesForSelectedSquad();
    state.selectedId = currentProfiles[0]?.id || null;
    stopBrowserPolling();
    state.currentSession = null;
    resetBrowserFrame();
    setView("profiles");
    renderMetrics();
    renderProfiles();
  });
});
$("filterBtn").addEventListener("click", (event) => {
  event.stopPropagation();
  $("filterPop").classList.toggle("hidden");
});
document.addEventListener("click", (event) => {
  if (!$("filterPop").classList.contains("hidden") && !event.target.closest(".filter-wrap")) {
    $("filterPop").classList.add("hidden");
  }
});
$("filterPop").querySelectorAll("[data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    $("filterPop").querySelectorAll("[data-filter]").forEach((item) => item.classList.toggle("active", item === button));
    $("filterBtnLabel").textContent = button.textContent;
    $("filterPop").classList.add("hidden");
    renderProfiles();
  });
});
$("filterPop").querySelectorAll("[data-sort]").forEach((button) => {
  button.addEventListener("click", () => {
    state.sort = button.dataset.sort;
    $("filterPop").querySelectorAll("[data-sort]").forEach((item) => item.classList.toggle("active", item === button));
    renderProfiles();
  });
});

// Le a selecao salva (localStorage) -> sobrevive a reinicios/F5 do app.
function loadCreatorsSelection() {
  try { return new Set(JSON.parse(localStorage.getItem("ctv2.creatorsSel") || "[]")); }
  catch { return new Set(); }
}
// Grava a selecao atual. Chamado em toda mudanca (marcar/desmarcar/limpar/excluir).
function saveCreatorsSelection() {
  try { localStorage.setItem("ctv2.creatorsSel", JSON.stringify([...state.creatorsSelection])); }
  catch { /* storage cheio -> segue so em memoria */ }
}
// Alterna a marcacao da conta pro painel de creators (o quadradinho na lista).
function toggleCreatorsSelection(id) {
  if (!id) return;
  if (state.creatorsSelection.has(id)) state.creatorsSelection.delete(id);
  else state.creatorsSelection.add(id);
  saveCreatorsSelection();
  renderProfiles();          // reflete o check na linha
  updateCreatorsButton();    // atualiza o contador no botao da sidebar
}
// Mostra no botao "Adicionar creators" quantas contas estao marcadas. Conta SO as
// que realmente serao enviadas (existem em state.profiles e sao TikTok) — senao o
// badge mostrava N (incluindo ids de contas ja excluidas) e o painel recebia N-1.
function updateCreatorsButton() {
  const el = $("creatorsCount");
  if (!el) return;
  const n = [...state.creatorsSelection].filter((id) => {
    const p = state.profiles.find((x) => x.id === id);
    return p && isTikTokProfile(p);
  }).length;
  el.textContent = n ? String(n) : "";
  el.title = n ? "Clique aqui pra LIMPAR a seleção" : "";
  el.classList.toggle("hidden", !n);
}
// Clicar no NUMERO (badge) limpa a selecao do dia — sem abrir o painel. Util pra
// zerar as ~50 marcadas de ontem sem desmarcar uma a uma.
$("creatorsCount")?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!state.creatorsSelection.size) return;
  state.creatorsSelection.clear();
  saveCreatorsSelection();
  renderProfiles();
  updateCreatorsButton();
  toast("Seleção de creators limpa.", "info");
});

$("profileList").addEventListener("click", (event) => {
  // Checkbox de creators: alterna e para (nao seleciona a linha nem abre nada).
  const check = event.target.closest("[data-action='cr-select']");
  if (check) { event.stopPropagation(); toggleCreatorsSelection(check.dataset.id); return; }
  const button = event.target.closest("button[data-action]");
  const row = event.target.closest(".profile-row");
  const id = button?.dataset.id || row?.dataset.profileId;
  if (!id) return;
  state.selectedId = id;
  const profile = selectedProfile();
  if (!state.currentSession || state.currentSession.profileId !== id) {
    stopBrowserPolling();
    state.currentSession = null;
    resetBrowserFrame();
  }
  if (button?.dataset.action === "open") openLocalBrowser(id);
  else if (button?.dataset.action === "edit") requireAuth(() => openProfileDialog(profile));
  else if (button?.dataset.action === "code") requireAuth(() => fetchProfileCode(profile));
  else if (button?.dataset.action === "capture") requireAuth(() => captureProfilePage(id));
  else if (button?.dataset.action === "release") releaseLock(id);
  else renderProfiles();
});

// Caixas de e-mail (Configuração, admin)
$("addMailboxBtn")?.addEventListener("click", () => {
  syncMailboxStateFromDom();
  state.mailboxes.push({ label: "", email: "", host: "imap.hostinger.com", port: 993, hasPassword: false });
  renderMailboxes();
});
$("saveMailboxesBtn")?.addEventListener("click", saveMailboxesUI);
$("genAdsReportBtn")?.addEventListener("click", generateAdsReport);

// ===== Relatórios Semanais (ferramenta do hub) =====
let reportMsgs = {};   // i -> mensagem crua (pra copiar do jeitinho do WhatsApp)
function reportBRL(cents) {
  return "R$ " + ((Number(cents) || 0) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function reportNum(n, casas = 2) {
  return (Number(n) || 0).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
}
// Preview da mensagem: escapa, aplica *negrito* do WhatsApp e mantem as quebras.
function fmtReportMsg(msg) {
  return escapeHtml(msg || "").replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>");
}
function reportStat(label, value) {
  return `<div class="rstat"><span class="rstat-l">${label}</span><span class="rstat-v">${value}</span></div>`;
}
function renderReportCard(c, i) {
  reportMsgs[i] = c.mensagem || "";
  const m = c.metrics || {};
  const av = profileAvatar(c.nome);
  const per = `${(c.inicio || "").slice(8, 10)}/${(c.inicio || "").slice(5, 7)} a ${(c.fim || "").slice(8, 10)}/${(c.fim || "").slice(5, 7)}`;
  const stats = [reportStat("GMV", reportBRL(m.gmv_cents)), reportStat("Pedidos", Number(m.pedidos || 0).toLocaleString("pt-BR"))];
  if (m.ads_custo_cents > 0) stats.push(reportStat("ROI", reportNum(m.roi)));
  if (m.conversao != null) stats.push(reportStat("Conversão", reportNum(m.conversao) + "%"));
  if (m.videos != null) stats.push(reportStat("Vídeos", Number(m.videos).toLocaleString("pt-BR")));
  return `<article class="report-card">
      <header class="report-head">
        <span class="report-av" style="background:${av.col}22;color:${av.col}">${escapeHtml(av.ini)}</span>
        <div class="report-head-txt">
          <strong>${escapeHtml(c.nome)}</strong>
          <span class="report-sub">${per}</span>
        </div>
        <button type="button" class="report-copy" data-copy="${i}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>Copiar</button>
      </header>
      <div class="report-stats">${stats.join("")}</div>
      <div class="report-preview">${fmtReportMsg(c.mensagem)}</div>
    </article>`;
}
// Lista as contas (com dados na semana) e monta os checkboxes do seletor.
async function loadReportSellers() {
  const box = $("reportsSellers");
  if (!box) return;
  box.innerHTML = `<div class="report-seller" style="color:var(--muted)">carregando contas…</div>`;
  try {
    const data = await api("/api/reports/sellers");
    if (!data?.ok) {
      state.reportSellers = [];
      box.innerHTML = `<div class="report-seller" style="color:var(--muted)">${data?.error === "not-configured"
        ? "Servidor sem acesso ao ELEVATOK configurado." : "Não consegui listar as contas."}</div>`;
    } else {
      state.reportSellers = data.sellers || [];
      renderReportSellers();
    }
  } catch (e) {
    state.reportSellers = [];
    box.innerHTML = `<div class="report-seller" style="color:var(--muted)">${escapeHtml(friendlyError(e))}</div>`;
  }
  updateReportSelCount();
}
function renderReportSellers() {
  const box = $("reportsSellers");
  if (!box) return;
  const q = ($("reportsSearch")?.value || "").trim().toLowerCase();
  box.innerHTML = (state.reportSellers || []).map((s) => {
    const hide = q && !s.nome.toLowerCase().includes(q) ? " hidden" : "";
    const av = profileAvatar(s.nome);
    return `<label class="report-seller${hide}">
      <input type="checkbox" class="rsel" value="${escapeHtml(s.id)}">
      <span class="report-seller-av" style="background:${av.col}22;color:${av.col}">${escapeHtml(av.ini)}</span>
      <span class="report-seller-nm">${escapeHtml(s.nome)}</span>
    </label>`;
  }).join("") || `<div class="report-empty">Nenhuma conta com dados nesta semana.</div>`;
  updateReportSelCount();
}
function reportSelectedIds() {
  return [...document.querySelectorAll("#reportsSellers .rsel:checked")].map((c) => c.value);
}
function updateReportSelCount() {
  const el = $("reportsSelCount");
  const total = (state.reportSellers || []).length;
  if (el) el.textContent = total ? `${reportSelectedIds().length} de ${total} selecionada(s)` : "";
}
// Gera os relatorios: sellerIds vazio = todos.
async function generateReports(sellerIds) {
  const prog = $("reportsProgress"), box = $("reportsResults");
  const btns = [$("genReportsSelBtn"), $("genReportsAllBtn")];
  btns.forEach((b) => { if (b) b.disabled = true; });
  prog.textContent = "gerando… (pode levar alguns segundos)"; box.innerHTML = "";
  try {
    const qs = (sellerIds && sellerIds.length) ? "?sellers=" + sellerIds.map(encodeURIComponent).join(",") : "";
    const data = await api("/api/reports/weekly" + qs);
    if (!data?.ok) {
      prog.textContent = "";
      box.innerHTML = `<p class="mailbox-hint">${data?.error === "not-configured"
        ? "O servidor ainda não está com o acesso ao ELEVATOK configurado." : "Não consegui gerar os relatórios agora."}</p>`;
      return;
    }
    prog.textContent = `${data.total} cliente(s) · gerado ${new Date(data.geradoEm).toLocaleString("pt-BR")}`;
    reportMsgs = {};
    box.innerHTML = (data.clientes || []).map((c, i) => renderReportCard(c, i)).join("")
      || `<p class="mailbox-hint">Nenhum cliente com dados.</p>`;
  } catch (e) {
    prog.textContent = "";
    box.innerHTML = `<p class="mailbox-hint">${escapeHtml(friendlyError(e))}</p>`;
  } finally { btns.forEach((b) => { if (b) b.disabled = false; }); }
}
$("reportsSearch")?.addEventListener("input", renderReportSellers);
$("reportsSellers")?.addEventListener("change", updateReportSelCount);
$("reportsSelAll")?.addEventListener("change", (e) => {
  document.querySelectorAll("#reportsSellers .report-seller:not(.hidden) .rsel").forEach((c) => { c.checked = e.target.checked; });
  updateReportSelCount();
});
$("genReportsSelBtn")?.addEventListener("click", () => requireAuth(() => {
  const ids = reportSelectedIds();
  if (!ids.length) { toast("Marque pelo menos uma conta — ou use 'Gerar todos'.", "warning"); return; }
  generateReports(ids);
}));
$("genReportsAllBtn")?.addEventListener("click", () => requireAuth(() => generateReports([])));
// Copiar a mensagem crua (com os * do WhatsApp) + feedback "Copiado ✓" no botao.
$("reportsResults")?.addEventListener("click", (e) => {
  const b = e.target.closest("[data-copy]");
  if (!b) return;
  const raw = reportMsgs[b.dataset.copy];
  if (raw == null) return;
  const orig = b.innerHTML;
  const done = () => {
    b.classList.add("done"); b.innerHTML = "Copiado ✓";
    setTimeout(() => { b.classList.remove("done"); b.innerHTML = orig; }, 1500);
  };
  const fallback = () => {
    const t = document.createElement("textarea"); t.value = raw; document.body.appendChild(t); t.select();
    try { document.execCommand("copy"); } catch { /* ok */ } t.remove(); done();
  };
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(raw).then(done).catch(fallback);
  else fallback();
});

// ===== Auto-refresh da lista de contas (tempo real) =====
// Conta nova criada em outro PC / mudanca de status aparece sozinha, sem precisar
// fechar e reabrir. Roda SO quando faz sentido: logado, na aba de contas, e sem
// dialogo aberto (pra nao atrapalhar quem esta editando). Rede instavel nao incomoda.
let profilesRefreshing = false;
async function autoRefreshProfiles() {
  if (profilesRefreshing) return;
  if (!state.token || state.view !== "profiles") return;
  if ($("profileDialog")?.open || $("codeDialog")?.open || $("confirmDialog")?.open) return;
  profilesRefreshing = true;
  try { await loadProfiles(); } catch { /* silencioso */ }
  finally { profilesRefreshing = false; }
}
setInterval(autoRefreshProfiles, 15000);                 // a cada 15s
window.addEventListener("focus", () => { autoRefreshProfiles(); }); // e ao voltar pro app
$("openLastAdsBtn")?.addEventListener("click", async () => {
  try {
    const r = await window.elevate?.openLastReport?.();
    if (!r?.ok) toast("Nenhum relatório gerado ainda.", "info");
  } catch { toast("Não consegui abrir o relatório.", "danger"); }
});
$("mailboxList")?.addEventListener("click", (event) => {
  const row = event.target.closest(".mailbox-row");
  if (!row) return;
  if (event.target.closest(".mbx-test")) testMailboxRow(row);
  else if (event.target.closest(".mbx-del")) {
    const idx = Number(row.dataset.idx);
    syncMailboxStateFromDom();
    state.mailboxes.splice(idx, 1);
    renderMailboxes();
  }
});

// Diálogo "Pegar código"
$("codeCloseBtn")?.addEventListener("click", () => $("codeDialog").close());
$("codeRetryBtn")?.addEventListener("click", () => {
  const id = $("codeDialog").dataset.profileId;
  const profile = (state.profiles || []).find((p) => p.id === id);
  if (profile) fetchProfileCode(profile);
});
$("codeCopyBtn")?.addEventListener("click", async () => {
  const code = $("codeValue").textContent.trim();
  try {
    await navigator.clipboard.writeText(code);
    $("codeCopyBtn").textContent = "Copiado!";
    setTimeout(() => { $("codeCopyBtn").textContent = "Copiar"; }, 1500);
  } catch {
    toast("Não consegui copiar. Anote: " + code, "warning");
  }
});

$("openRemoteBtn").addEventListener("click", () => {
  const profile = selectedProfile();
  if (profile) openRemote(profile.id);
});
$("releaseBtn").addEventListener("click", () => releaseLock());
$("browserBackToList")?.addEventListener("click", () => {
  state.browserHidden = true;
  syncBrowserOverlay();
});
$("browserRefreshBtn").addEventListener("click", () => browserCommand("reload"));
$("browserBackBtn").addEventListener("click", () => browserCommand("back"));
$("browserForwardBtn").addEventListener("click", () => browserCommand("forward"));
$("browserGoBtn").addEventListener("click", navigateBrowser);
$("browserTypeBtn").addEventListener("click", typeBrowserText);
$("browserEnterBtn").addEventListener("click", () => sendBrowserKey("Enter"));
$("browserTabBtn").addEventListener("click", () => sendBrowserKey("Tab"));
$("browserEscBtn").addEventListener("click", () => sendBrowserKey("Escape"));
$("browserUrl").addEventListener("keydown", (event) => {
  if (event.key === "Enter") navigateBrowser();
});
$("browserText").addEventListener("keydown", (event) => {
  if (event.key === "Enter") typeBrowserText();
});
$("sessionScreen").addEventListener("click", clickBrowserFrame);
$("sessionScreen").addEventListener("wheel", queueBrowserWheel, { passive: false });
$("sessionScreen").addEventListener("keydown", handleBrowserKeydown);
$("auditRefreshBtn").addEventListener("click", loadAudit);
$("userForm").addEventListener("submit", createUser);

let updateToastShown = false;
if (window.elevate?.onUpdateAvailable) {
  window.elevate.onUpdateAvailable(() => {
    if (!updateToastShown) {
      updateToastShown = true;
      toast("Baixando atualização em segundo plano...", "info");
    }
  });
}
if (window.elevate?.onUpdateDownloaded) {
  window.elevate.onUpdateDownloaded((info) => showUpdateReady(info));
}
// Alem de reagir ao evento (que dispara UMA vez, e podia passar despercebido ou ser
// dispensado com "Agora nao"), pergunta ao main NO ARRANQUE se ja ha versao baixada e
// pendente -> a faixa REAPARECE a cada abertura ate o app reiniciar de fato. Esse era
// o buraco do "alguns PCs nao atualizam": baixava, mas o unico aviso sumia e ninguem
// mais era lembrado de reiniciar.
if (window.elevate?.getUpdateStatus) {
  window.elevate.getUpdateStatus()
    .then((s) => { if (s?.ready) showUpdateReady({ version: s.version }); })
    .catch(() => {});
}

if (window.elevate?.onBrowserProfileClosed) {
  window.elevate.onBrowserProfileClosed(async ({ id }) => {
    try {
      await api(`/api/profiles/${id}/release`, { method: "POST" });
    } catch {
      // Se a liberacao falhar, o próximo refresh/abertura resolve.
    }
    await loadProfiles().catch(() => {});
  });
}

if (window.elevate?.onBrowserProfileCookies) {
  window.elevate.onBrowserProfileCookies(async ({ id, cookies }) => {
    // Etapa 2: sobe a sessão (cookies) pro servidor -> aparece pros outros PCs
    try {
      await api(`/api/profiles/${id}/cookies`, { method: "PUT", body: { cookies } });
    } catch {
      // proxima sincronização (a cada ~8s) tenta de novo
    }
  });
}

startSplash();
boot().finally(finishSplash);
