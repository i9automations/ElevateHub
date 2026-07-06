const state = {
  token: localStorage.getItem("ctv2.token") || sessionStorage.getItem("ctv2.token") || "",
  user: null,
  profiles: [],
  users: [],
  audit: [],
  selectedId: null,
  selectedSquad: localStorage.getItem("ctv2.squad") || "fox",
  currentSession: null,
  browserPoll: null,
  view: "profiles",
  filter: "all",
  editProfileId: null,
  frameLoading: false,
  wheelTimer: null,
  wheelDeltaX: 0,
  wheelDeltaY: 0,
  updateInfo: null
};

const $ = (id) => document.getElementById(id);

function storeToken(token, remember) {
  try {
    if (remember) {
      localStorage.setItem("ctv2.token", token);
      sessionStorage.removeItem("ctv2.token");
    } else {
      sessionStorage.setItem("ctv2.token", token);
      localStorage.removeItem("ctv2.token");
    }
  } catch {
    // Armazenamento indisponivel não deve impedir o login na sessão atual.
  }
}

function clearToken() {
  try {
    localStorage.removeItem("ctv2.token");
    sessionStorage.removeItem("ctv2.token");
  } catch {
    // Ignorar falha ao limpar; a sessão já foi encerrada em memoria.
  }
}
const apiBase = window.elevate?.apiBase || "https://contas-v2.elevateecom.com.br";
const appVersion = window.elevate?.appVersion || "0.0.0";
const updateReleaseUrl = "https://api.github.com/repos/i9automations/ElevateHub/releases/tags/app-v2";
const squads = [
  { key: "fox", name: "Fox", label: "TikTok Seller", startUrl: "https://seller-br.tiktok.com/account/login" },
  { key: "crown", name: "Crown", label: "Mercado Livre", startUrl: "https://www.mercadolivre.com.br/" },
  { key: "jaguar", name: "Jaguar", label: "Shopee Seller", startUrl: "https://seller.shopee.com.br/" },
  { key: "monkey", name: "Monkey", label: "Mercado Livre", startUrl: "https://www.mercadolivre.com.br/" },
  { key: "sphynx", name: "Sphynx", label: "Amazon Seller", startUrl: "https://sellercentral.amazon.com.br/" }
];

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
  return view === "profiles" || isAdmin();
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
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Não foi possível concluir agora.");
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
  const squadMk = {
    fox: { icon: "tiktok.svg", bg: "linear-gradient(150deg,#232323,#050505)", sz: 15 },
    crown: { icon: "mercadolivre.svg", bg: "linear-gradient(150deg,#ffffff,#f1f4f8)", sz: 20 },
    jaguar: { icon: "shopee.svg", bg: "linear-gradient(150deg,#ff6a3d,#ee4d2d)", sz: 15 },
    monkey: { icon: "mercadolivre.svg", bg: "linear-gradient(150deg,#ffffff,#f1f4f8)", sz: 20 },
    sphynx: { icon: "amazon.jpg", bg: "linear-gradient(150deg,#ffffff,#f1f4f8)", sz: 20 }
  };
  $("squadNav").innerHTML = squads.map((squad) => {
    const mk = squadMk[squad.key] || squadMk.fox;
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
}

function selectedProfile() {
  return state.profiles.find((profile) => profile.id === state.selectedId) || null;
}

function canControl(profile) {
  if (!profile) return false;
  return !profile.lockedBy || profile.lockedBy === state.user?.id || state.user?.role === "admin";
}

function profileStatus(profile) {
  if (profile.lockedBy) return { text: "em uso", cls: "busy" };
  if (profile.sessionState === "ready") return { text: "logada", cls: "ready" };
  if (profile.sessionState === "queued") return { text: "abrindo", cls: "queued" };
  return { text: "disponível", cls: "empty" };
}

function profileMatchesFilter(profile) {
  if (state.filter === "free") return !profile.lockedBy;
  if (state.filter === "ready") return profile.sessionState === "ready";
  if (state.filter === "busy") return !!profile.lockedBy;
  return true;
}

function renderMetrics() {
  const profiles = profilesForSelectedSquad();
  const total = profiles.length;
  const ready = profiles.filter((profile) => profile.sessionState === "ready").length;
  const busy = profiles.filter((profile) => profile.lockedBy).length;
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

  $("emptyProfiles").classList.toggle("hidden", visible.length > 0);
  $("profileList").innerHTML = visible.map((profile) => {
    const status = profileStatus(profile);
    const selected = profile.id === state.selectedId ? " selected" : "";
    const owner = profile.responsavel || profile.lockedByName || "—";
    const control = canControl(profile);
    const canRelease = !!profile.lockedBy && control;
    const editButton = `<button class="ghost compact" type="button" data-action="edit" data-id="${profile.id}" title="Editar">Editar</button>`;
    const releaseButton = canRelease
      ? `<button class="ghost compact" type="button" data-action="release" data-id="${profile.id}">${isAdmin() ? "Liberar" : "Fechar"}</button>`
      : "";
    const openBtn = control
      ? `<button class="run" type="button" data-action="open" data-id="${profile.id}"><svg width="9" height="10" viewBox="0 0 9 10"><path d="M1 1l7 4-7 4z" fill="currentColor"/></svg>Abrir</button>`
      : `<button class="run" type="button" disabled>Em uso</button>`;
    const av = profileAvatar(profile.name);
    return `
      <div class="profile-row${selected} st-row-${status.cls}" data-profile-id="${profile.id}">
        <div class="c-name">
          <span class="avatar" style="background:${av.col}1f;color:${av.col}">${av.ini}</span>
          <span class="ntxt">
            <span class="nm" title="${escapeHtml(profile.name)}">${escapeHtml(profile.name)}</span>
            <span class="em" title="${escapeHtml(profile.tiktokEmail || "")}">${escapeHtml(profile.tiktokEmail || "—")}</span>
          </span>
        </div>
        <div class="pr-status"><span class="st st-${status.cls}"><i></i>${status.text}</span></div>
        <div class="pr-resp">${escapeHtml(owner)}</div>
        <div class="pr-last">${formatDate(profile.lastOpenedAt)}</div>
        <div class="pr-act">${editButton}${releaseButton}${openBtn}</div>
      </div>`;
  }).join("");

  renderSessionPane();
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
    state.user = data.user;
    storeToken(state.token, $("remember")?.checked !== false);
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
  if (!state.token) return false;
  try {
    const data = await api("/api/me");
    state.user = data.user;
    setServer("conectado", true);
    showApp();
    await loadProfiles();
    checkForUpdates();
    return true;
  } catch {
    clearToken();
    state.token = "";
    state.user = null;
    return false;
  }
}

function openProfileDialog(profile = null) {
  const squad = profile ? squads.find((item) => item.key === profileSquad(profile)) || selectedSquad() : selectedSquad();
  state.editProfileId = profile?.id || null;
  $("profileDialogTitle").textContent = profile ? "Editar perfil" : "Novo perfil";
  $("profileSquadName").textContent = `${squad.name} - ${squad.label}`;
  $("profileName").value = profile?.name || "";
  $("profileEmail").value = profile?.tiktokEmail || "";
  $("profileResp").value = profile?.responsavel || "";
  $("profileMailbox").value = profile?.mailboxEmail || "";
  $("profileTags").value = (profile?.tags || []).join(", ");
  $("profileNotes").value = profile?.notes || "";
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
    squad: state.editProfileId ? profileSquad(selectedProfile()) : state.selectedSquad
  };
  if (isAdmin()) {
    body.mailboxEmail = $("profileMailbox").value.trim();
    body.tags = $("profileTags").value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  if (!body.name) {
    toast("Informe o nome do cliente.", "warning");
    return;
  }
  const editing = !!state.editProfileId;
  const path = editing ? `/api/profiles/${state.editProfileId}` : "/api/profiles";
  const data = await api(path, { method: editing ? "PATCH" : "POST", body });
  state.selectedId = data.profile.id;
  $("profileDialog").close();
  await loadProfiles();
  toast(editing ? "Perfil atualizado." : "Perfil criado.", "success");
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

// Modelo Dolphin: abre o Chrome PROPRIO do app, no PC, com pasta isolada por conta.
async function openLocalBrowser(profileId) {
  state.selectedId = profileId;
  const profile = selectedProfile();
  if (!profile || !canControl(profile)) return;
  if (!window.elevate?.openBrowserProfile) {
    toast("Esta versão do app ainda não abre o navegador local. Atualize o app.", "warning");
    return;
  }
  try {
    await api(`/api/profiles/${profileId}/lock`, { method: "POST" });
  } catch {
    toast("Esta conta já está em uso por outra pessoa.", "warning");
    return;
  }
  try {
    const startUrl = selectedSquad().startUrl || profile.startUrl;
    // Etapa 2: baixa a sessão (cookies) do servidor pra já abrir logado
    let cookies = [];
    try {
      const data = await api(`/api/profiles/${profileId}/cookies`);
      cookies = data.cookies || [];
    } catch {
      // sem sessão salva ainda: abre pra logar do zero (a 1a vez)
    }
    const result = await window.elevate.openBrowserProfile({ id: profileId, name: profile.name, url: startUrl, cookies });
    if (!result?.ok) {
      const reason = result?.error === "no-chrome"
        ? "Navegador do app não encontrado."
        : "Não consegui abrir o navegador.";
      toast(reason, "danger");
      await api(`/api/profiles/${profileId}/release`, { method: "POST" }).catch(() => {});
      await loadProfiles();
      return;
    }
    await loadProfiles();
    toast(result.already ? `${profile.name} já esta aberto.` : `Abrindo ${profile.name}...`, "success");
  } catch (error) {
    toast(friendlyError(error), "danger");
    await api(`/api/profiles/${profileId}/release`, { method: "POST" }).catch(() => {});
    await loadProfiles();
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
      <div class="avatar">${escapeHtml(user.name.slice(0, 2).toUpperCase())}</div>
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
    audit: ["Auditoria", "Histórico recente de acessos"],
    team: ["Equipe", "Usuários do aplicativo"],
    settings: ["Configuração", "Servidor e operação"]
  };
  $("viewTitle").textContent = titles[view][0];
  $("viewSubtitle").textContent = titles[view][1];

  if (view === "audit") await loadAudit();
  if (view === "team") await loadUsers();
  if (view === "settings") renderSettings();
}

async function refreshCurrentView() {
  if (!state.token) return boot();
  if (state.view === "profiles") await loadProfiles();
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
  state.updateInfo = info || {};
  $("updateCopy").textContent = "Uma nova versão do ElevateHub esta disponível e pronta. Deseja atualizar agora? (leva poucos segundos)";
  $("updateMeta").textContent = info?.version ? `Nova versão: ${info.version}` : "";
  $("installUpdateBtn").textContent = "Atualizar agora";
  $("cancelUpdateBtn").textContent = "Agora não";
  if (!$("updateDialog").open) $("updateDialog").showModal();
}

function dismissUpdate() {
  // "Depois": a atualização já esta baixada e sera aplicada quando fechar o app.
  $("updateDialog").close();
}

async function installUpdate() {
  $("installUpdateBtn").disabled = true;
  $("installUpdateBtn").textContent = "Reiniciando...";
  try {
    if (window.elevate?.installUpdateNow) await window.elevate.installUpdateNow();
  } catch {
    $("installUpdateBtn").disabled = false;
    $("installUpdateBtn").textContent = "Reiniciar agora";
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
$("refreshBtn").addEventListener("click", refreshCurrentView);
$("search").addEventListener("input", renderProfiles);
$("newProfileBtn").addEventListener("click", () => requireAuth(() => openProfileDialog()));
$("importBtn").addEventListener("click", () => requireAdminAction(() => $("importDialog").showModal()));
$("cancelProfileBtn").addEventListener("click", () => $("profileDialog").close());
$("deleteProfileBtn").addEventListener("click", deleteProfile);
$("cancelImportBtn").addEventListener("click", () => $("importDialog").close());
$("cancelUpdateBtn").addEventListener("click", dismissUpdate);
$("installUpdateBtn").addEventListener("click", installUpdate);
$("profileDialog").addEventListener("submit", saveProfile);
$("runImportBtn").addEventListener("click", runImport);
$("importFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (file) $("importText").value = await file.text();
});

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => requireAuth(() => setView(button.dataset.view)));
});
$("squadNav").addEventListener("click", (event) => {
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
document.querySelectorAll(".filter-tab").forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll(".filter-tab").forEach((item) => item.classList.toggle("active", item === button));
    renderProfiles();
  });
});

$("profileList").addEventListener("click", (event) => {
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
  else if (button?.dataset.action === "release") releaseLock(id);
  else renderProfiles();
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
      // proxima sincronização (a cada ~20s) tenta de novo
    }
  });
}

startSplash();
boot().finally(finishSplash);
