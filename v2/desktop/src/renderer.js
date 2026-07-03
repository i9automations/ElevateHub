const state = {
  token: localStorage.getItem("ctv2.token") || "",
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
const apiBase = window.elevate?.apiBase || "https://contas-v2.elevateecom.com.br";
const appVersion = window.elevate?.appVersion || "0.0.0";
const updateReleaseUrl = "https://api.github.com/repos/i9automations/contas-tiktok/releases/tags/app-v2";
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
  const message = error?.message || "Nao foi possivel concluir agora.";
  if (isAdmin()) return message;
  if (/sess|remot|servidor|api|playwright|chrome|driver|vps|limite/i.test(message)) {
    return "Nao foi possivel abrir essa conta agora. Tente novamente em instantes.";
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
  if (!res.ok) throw new Error(data.error || "Nao foi possivel concluir agora.");
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
  $("squadNav").innerHTML = squads.map((squad) => `
    <button class="squad-item ${state.selectedSquad === squad.key ? "active" : ""}" type="button" data-squad="${squad.key}">
      <strong>${escapeHtml(squad.name)}</strong>
      <span>${escapeHtml(squad.label)} - ${counts[squad.key] || 0}</span>
    </button>
  `).join("");
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
  return { text: "disponivel", cls: "empty" };
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

function renderProfiles() {
  const term = $("search").value.trim().toLowerCase();
  const visible = profilesForSelectedSquad().filter((profile) => {
    const haystack = [
      profile.name,
      profile.tiktokEmail,
      profile.mailboxEmail,
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
    const owner = profile.lockedByName || "livre";
    const tags = (profile.tags || []).slice(0, 3).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("");
    const openDisabled = canControl(profile) ? "" : " disabled";
    const canRelease = !!profile.lockedBy && canControl(profile);
    const editButton = isAdmin()
      ? `<button class="secondary compact" type="button" data-action="edit" data-id="${profile.id}">Editar</button>`
      : "";
    const releaseButton = canRelease
      ? `<button class="secondary compact" type="button" data-action="release" data-id="${profile.id}">${isAdmin() ? "Liberar" : "Fechar"}</button>`
      : "";
    return `
      <div class="profile-row${selected}" data-profile-id="${profile.id}">
        <div class="profile-title">
          <strong>${escapeHtml(profile.name)}</strong>
          <small>${escapeHtml(profile.tiktokEmail || selectedSquad().label)}</small>
          <div class="tag-row">${tags}</div>
        </div>
        <span class="badge ${status.cls}">${status.text}</span>
        <span class="muted-text">${escapeHtml(owner)}</span>
        <span class="muted-text">${formatDate(profile.lastOpenedAt)}</span>
        <div class="row-actions">
          ${editButton}
          ${releaseButton}
          <button class="primary compact" type="button" data-action="open" data-id="${profile.id}"${openDisabled}>Abrir</button>
        </div>
      </div>`;
  }).join("");

  renderSessionPane();
}

function renderSessionPane() {
  const profile = selectedProfile();
  const status = profile ? profileStatus(profile) : { text: "nenhum", cls: "empty" };
  const hasSession = !!state.currentSession && state.currentSession.profileId === state.selectedId;
  const profileCanControl = canControl(profile);
  const canRelease = !!profile?.lockedBy && profileCanControl;

  $("selectedName").textContent = profile ? profile.name : "Nenhum perfil";
  $("selectedEmail").textContent = profile
    ? `${profile.tiktokEmail || "sem e-mail"}${isAdmin() && profile.mailboxEmail ? ` | caixa ${profile.mailboxEmail}` : ""}`
    : "Selecione um cliente para abrir a conta.";

  $("selectedStatusPill").className = `badge ${status.cls}`;
  $("selectedStatusPill").textContent = status.text;
  $("lockLine").textContent = profile?.lockedBy
    ? `Em uso por ${profile.lockedByName || "outro usuario"}.`
    : "Perfil disponivel.";

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
    : "Conta ainda nao aberta neste app.";
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
    localStorage.setItem("ctv2.token", state.token);
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
    localStorage.removeItem("ctv2.token");
    state.token = "";
    state.user = null;
    return false;
  }
}

function openProfileDialog(profile = null) {
  if (profile && !isAdmin()) {
    toast("Acesso exclusivo do admin.", "warning");
    return;
  }
  const squad = profile ? squads.find((item) => item.key === profileSquad(profile)) || selectedSquad() : selectedSquad();
  state.editProfileId = profile?.id || null;
  $("profileDialogTitle").textContent = profile ? "Editar perfil" : "Novo perfil";
  $("profileSquadName").textContent = `${squad.name} - ${squad.label}`;
  $("profileName").value = profile?.name || "";
  $("profileEmail").value = profile?.tiktokEmail || "";
  $("profileMailbox").value = profile?.mailboxEmail || "";
  $("profileTags").value = (profile?.tags || []).join(", ");
  $("profileNotes").value = profile?.notes || "";
  $("profileDialog").showModal();
}

async function saveProfile(event) {
  event.preventDefault();
  if (state.editProfileId && !isAdmin()) return;
  const body = {
    name: $("profileName").value.trim(),
    tiktokEmail: $("profileEmail").value.trim(),
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
    toast(`Importacao concluida: ${result.created || 0} novos, ${result.updated || 0} atualizados.`, "success");
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
  `).join("") : `<div class="empty-state"><strong>Nenhum evento ainda</strong><span>As acoes aparecem aqui conforme o time usa o app.</span></div>`;
}

function renderUsers() {
  const canCreate = isAdmin();
  $("userForm").classList.toggle("disabled-panel", !canCreate);
  $("userForm").querySelectorAll("input, select, button").forEach((control) => {
    control.disabled = !canCreate;
  });
  $("userMsg").textContent = canCreate ? "" : "Somente admin pode criar usuarios.";
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
    toast("Usuario criado.", "success");
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
    audit: ["Auditoria", "Historico recente de acessos"],
    team: ["Equipe", "Usuarios do aplicativo"],
    settings: ["Configuracao", "Servidor e operacao"]
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

function installerFromAsset(asset) {
  const assetName = String(asset.name || "");
  const match = assetName.match(/(?:elevatehub|Elevate(?:\.| )Hub|Contas(?:\.| )TikTok(?:\.| )V2)(?:\.| )Setup(?:\.| )(\d+\.\d+\.\d+)\.exe$/i);
  if (!match) return null;
  return {
    version: match[1],
    url: asset.browser_download_url,
    name: asset.name,
    priority: /^elevatehub/i.test(assetName) ? 0 : 1
  };
}

function latestInstaller(assets = []) {
  return assets
    .map(installerFromAsset)
    .filter(Boolean)
    .sort((left, right) => compareVersions(right.version, left.version) || left.priority - right.priority)[0] || null;
}

function showUpdateDialog(info) {
  state.updateInfo = info;
  $("updateCopy").textContent = "Existe uma versao mais nova do elevatehub. Voce pode atualizar agora ou continuar usando por enquanto.";
  $("updateMeta").textContent = `Instalada: ${appVersion} | Disponivel: ${info.version}`;
  if (!$("updateDialog").open) $("updateDialog").showModal();
}

async function checkForUpdates() {
  try {
    const response = await fetch(updateReleaseUrl, {
      headers: { Accept: "application/vnd.github+json" }
    });
    if (!response.ok) return;
    const release = await response.json();
    const latest = latestInstaller(release.assets || []);
    if (!latest || compareVersions(latest.version, appVersion) <= 0) return;
    if (localStorage.getItem("ctv2.dismissedUpdate") === latest.version) return;
    showUpdateDialog(latest);
  } catch {
    // Atualizacao nao deve atrapalhar o uso do app.
  }
}

function dismissUpdate() {
  if (state.updateInfo?.version) {
    localStorage.setItem("ctv2.dismissedUpdate", state.updateInfo.version);
  }
  $("updateDialog").close();
}

async function installUpdate() {
  const url = state.updateInfo?.url;
  const name = state.updateInfo?.name || `elevatehub.Setup.${state.updateInfo?.version || "latest"}.exe`;
  if (!url) return;
  $("installUpdateBtn").disabled = true;
  $("installUpdateBtn").textContent = "Baixando...";
  try {
    if (window.elevate?.downloadUpdate) {
      await window.elevate.downloadUpdate({ url, name });
      $("updateDialog").close();
      toast("Atualizador aberto. O app vai fechar para concluir.", "success");
    } else if (window.elevate?.openExternal) {
      await window.elevate.openExternal(url);
      $("updateDialog").close();
      toast("Instalador aberto. Rode por cima da versao atual.", "success");
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
      $("updateDialog").close();
      toast("Instalador aberto. Rode por cima da versao atual.", "success");
    }
  } catch {
    toast("Nao consegui abrir a atualizacao agora.", "danger");
  } finally {
    $("installUpdateBtn").disabled = false;
    $("installUpdateBtn").textContent = "Atualizar";
  }
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
  checkForUpdates();
}

$("loginBtn").addEventListener("click", login);
$("password").addEventListener("keydown", (event) => {
  if (event.key === "Enter") login();
});
$("refreshBtn").addEventListener("click", refreshCurrentView);
$("search").addEventListener("input", renderProfiles);
$("newProfileBtn").addEventListener("click", () => requireAuth(() => openProfileDialog()));
$("importBtn").addEventListener("click", () => requireAdminAction(() => $("importDialog").showModal()));
$("cancelProfileBtn").addEventListener("click", () => $("profileDialog").close());
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
  if (button?.dataset.action === "open") openRemote(id);
  else if (button?.dataset.action === "edit") requireAdminAction(() => openProfileDialog(profile));
  else if (button?.dataset.action === "release") releaseLock(id);
  else renderProfiles();
});

$("openRemoteBtn").addEventListener("click", () => {
  const profile = selectedProfile();
  if (profile) openRemote(profile.id);
});
$("releaseBtn").addEventListener("click", () => releaseLock());
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

boot();
