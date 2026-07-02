const state = {
  token: localStorage.getItem("ctv2.token") || "",
  user: null,
  profiles: [],
  users: [],
  audit: [],
  selectedId: null,
  currentSession: null,
  browserPoll: null,
  view: "profiles",
  filter: "all",
  editProfileId: null,
  frameLoading: false,
  wheelTimer: null,
  wheelDeltaX: 0,
  wheelDeltaY: 0
};

const $ = (id) => document.getElementById(id);
const apiBase = window.elevate?.apiBase || "https://contas-v2.elevateecom.com.br";

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
  if (!res.ok) throw new Error(data.error || "Falha na API");
  return data;
}

function showApp() {
  $("loginView").classList.add("hidden");
  $("dashboardView").classList.remove("hidden");
  $("appUserName").textContent = state.user?.name || "Equipe";
  $("appUserRole").textContent = state.user?.role || "operador";
  renderSettings();
}

function showLogin() {
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
  if (profile.sessionState === "queued") return { text: "fila", cls: "queued" };
  return { text: "sem sessao", cls: "empty" };
}

function profileMatchesFilter(profile) {
  if (state.filter === "free") return !profile.lockedBy;
  if (state.filter === "ready") return profile.sessionState === "ready";
  if (state.filter === "busy") return !!profile.lockedBy;
  return true;
}

function renderMetrics() {
  const total = state.profiles.length;
  const ready = state.profiles.filter((profile) => profile.sessionState === "ready").length;
  const busy = state.profiles.filter((profile) => profile.lockedBy).length;
  $("metricTotal").textContent = total;
  $("metricReady").textContent = ready;
  $("metricBusy").textContent = busy;
  $("metricFree").textContent = Math.max(total - busy, 0);
  $("viewSubtitle").textContent = `${total} perfis cadastrados`;
}

function renderProfiles() {
  const term = $("search").value.trim().toLowerCase();
  const visible = state.profiles.filter((profile) => {
    const haystack = [
      profile.name,
      profile.tiktokEmail,
      profile.mailboxEmail,
      profile.lockedByName,
      profile.notes,
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
    const releaseDisabled = profile.lockedBy && canControl(profile) ? "" : " disabled";
    return `
      <div class="profile-row${selected}" data-profile-id="${profile.id}">
        <div class="profile-title">
          <strong>${escapeHtml(profile.name)}</strong>
          <small>${escapeHtml(profile.tiktokEmail || "sem e-mail TikTok")}</small>
          <div class="tag-row">${tags}</div>
        </div>
        <span class="badge ${status.cls}">${status.text}</span>
        <span class="muted-text">${escapeHtml(owner)}</span>
        <span class="muted-text">${formatDate(profile.lastOpenedAt)}</span>
        <div class="row-actions">
          <button class="secondary compact" type="button" data-action="edit" data-id="${profile.id}">Editar</button>
          <button class="secondary compact" type="button" data-action="release" data-id="${profile.id}"${releaseDisabled}>Liberar</button>
          <button class="primary compact" type="button" data-action="open" data-id="${profile.id}"${openDisabled}>Abrir</button>
        </div>
      </div>`;
  }).join("");

  renderSessionPane();
}

function renderSessionPane() {
  const profile = selectedProfile();
  const status = profile ? profileStatus(profile) : { text: "sem sessao", cls: "empty" };
  const hasSession = !!state.currentSession && state.currentSession.profileId === state.selectedId;
  const profileCanControl = canControl(profile);
  const canRelease = !!profile?.lockedBy && profileCanControl;

  $("selectedName").textContent = profile ? profile.name : "Nenhum perfil";
  $("selectedEmail").textContent = profile
    ? `${profile.tiktokEmail || "sem e-mail"}${profile.mailboxEmail ? ` | caixa ${profile.mailboxEmail}` : ""}`
    : "Selecione um cliente para abrir o browser.";

  $("selectedStatusPill").className = `badge ${status.cls}`;
  $("selectedStatusPill").textContent = status.text;
  $("lockLine").textContent = profile?.lockedBy
    ? `Travado por ${profile.lockedByName || "outro usuario"}.`
    : "Perfil livre para uso.";

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
    $("activityLog").textContent = "Selecione um perfil para abrir uma sessao remota.";
    return;
  }

  const savedText = profile.sessionState === "ready"
    ? "Sessao persistida no servidor."
    : "Sessao ainda nao inicializada.";
  const remoteText = hasSession
    ? `Browser ${state.currentSession.mode}: ${state.currentSession.message || state.currentSession.state}.`
    : "Browser fechado neste computador.";
  $("activityLog").textContent = `${savedText} ${remoteText}`;
}

async function loadProfiles() {
  const data = await api("/api/profiles");
  state.profiles = data.profiles || [];
  if (!state.profiles.some((profile) => profile.id === state.selectedId)) {
    state.selectedId = state.profiles[0]?.id || null;
  }
  renderMetrics();
  renderProfiles();
}

async function loadAudit() {
  const data = await api("/api/audit");
  state.audit = data.audit || [];
  renderAudit();
}

async function loadUsers() {
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
    toast("Login realizado.", "success");
  } catch (error) {
    $("loginMsg").textContent = error.message;
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
    return true;
  } catch {
    localStorage.removeItem("ctv2.token");
    state.token = "";
    state.user = null;
    return false;
  }
}

function openProfileDialog(profile = null) {
  state.editProfileId = profile?.id || null;
  $("profileDialogTitle").textContent = profile ? "Editar perfil" : "Novo perfil";
  $("profileName").value = profile?.name || "";
  $("profileEmail").value = profile?.tiktokEmail || "";
  $("profileMailbox").value = profile?.mailboxEmail || "";
  $("profileTags").value = (profile?.tags || []).join(", ");
  $("profileNotes").value = profile?.notes || "";
  $("profileDialog").showModal();
}

async function saveProfile(event) {
  event.preventDefault();
  const body = {
    name: $("profileName").value.trim(),
    tiktokEmail: $("profileEmail").value.trim(),
    mailboxEmail: $("profileMailbox").value.trim(),
    tags: $("profileTags").value.split(",").map((item) => item.trim()).filter(Boolean),
    notes: $("profileNotes").value.trim()
  };
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
  $("activityLog").textContent = `Abrindo browser de ${profile.name}...`;
  try {
    const data = await api(`/api/profiles/${profileId}/session/start`, { method: "POST" });
    state.currentSession = data.session || null;
    startBrowserPolling();
    await loadProfiles();
    await refreshBrowserFrame(true);
    $("sessionScreen").focus();
  } catch (error) {
    toast(error.message, "danger");
    $("activityLog").textContent = error.message;
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
    toast("Perfil liberado.", "success");
  } catch (error) {
    toast(error.message, "danger");
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
    $("activityLog").textContent = error.message;
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
    toast(error.message, "danger");
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
  const canCreate = state.user?.role === "admin";
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
      <span class="badge ${user.role === "admin" ? "ready" : "empty"}">${escapeHtml(user.role)}</span>
    </div>
  `).join("");
}

async function createUser(event) {
  event.preventDefault();
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
  state.view = view;
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("active", section.id === `${view}View`);
  });

  const titles = {
    profiles: ["Perfis compartilhados", `${state.profiles.length} perfis cadastrados`],
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
  if (state.view === "audit") await loadAudit();
  if (state.view === "team") await loadUsers();
  if (state.view === "settings") renderSettings();
}

async function boot() {
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
$("refreshBtn").addEventListener("click", refreshCurrentView);
$("search").addEventListener("input", renderProfiles);
$("newProfileBtn").addEventListener("click", () => requireAuth(() => openProfileDialog()));
$("importBtn").addEventListener("click", () => requireAuth(() => $("importDialog").showModal()));
$("cancelProfileBtn").addEventListener("click", () => $("profileDialog").close());
$("cancelImportBtn").addEventListener("click", () => $("importDialog").close());
$("profileDialog").addEventListener("submit", saveProfile);
$("runImportBtn").addEventListener("click", runImport);
$("importFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (file) $("importText").value = await file.text();
});

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => requireAuth(() => setView(button.dataset.view)));
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
  else if (button?.dataset.action === "edit") openProfileDialog(profile);
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
