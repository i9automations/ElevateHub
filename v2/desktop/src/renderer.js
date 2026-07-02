const state = {
  token: "",
  user: null,
  profiles: [],
  selectedId: null
};

const $ = (id) => document.getElementById(id);
const apiBase = window.elevate?.apiBase || "http://127.0.0.1:8787";

function setServer(text, ok = false) {
  $("serverState").textContent = text;
  $("serverState").style.color = ok ? "var(--success)" : "var(--warning)";
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
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Falha na API");
  return data;
}

function showApp() {
  $("loginView").classList.add("hidden");
  $("dashboardView").classList.remove("hidden");
}

function profileStatus(profile) {
  if (profile.lockedBy) return { text: "em uso", cls: "busy" };
  if (profile.sessionState === "ready") return { text: "logada", cls: "ready" };
  return { text: "sem sessao", cls: "empty" };
}

function selectedProfile() {
  return state.profiles.find((profile) => profile.id === state.selectedId) || null;
}

function renderMetrics() {
  const total = state.profiles.length;
  const ready = state.profiles.filter((profile) => profile.sessionState === "ready").length;
  const busy = state.profiles.filter((profile) => profile.lockedBy).length;
  const queue = state.profiles.filter((profile) => profile.sessionState === "queued").length;
  $("metricTotal").textContent = total;
  $("metricReady").textContent = ready;
  $("metricBusy").textContent = busy;
  $("metricQueue").textContent = queue;
  $("subtitle").textContent = `${total} perfis cadastrados`;
}

function renderProfiles() {
  const term = $("search").value.trim().toLowerCase();
  const visible = state.profiles.filter((profile) => {
    const haystack = `${profile.name} ${profile.tiktokEmail || ""} ${(profile.tags || []).join(" ")} ${profile.lockedByName || ""}`.toLowerCase();
    return haystack.includes(term);
  });

  $("profileList").innerHTML = visible.map((profile) => {
    const status = profileStatus(profile);
    const selected = profile.id === state.selectedId ? " selected" : "";
    const owner = profile.lockedByName || "livre";
    return `
      <div class="profile-row${selected}" data-profile-id="${profile.id}">
        <div class="profile-title">
          <strong>${escapeHtml(profile.name)}</strong>
          <span>${escapeHtml(profile.tiktokEmail || "sem e-mail vinculado")}</span>
        </div>
        <span class="badge ${status.cls}">${status.text}</span>
        <span>${escapeHtml(owner)}</span>
        <div class="row-actions">
          <button class="secondary" type="button" data-action="select" data-id="${profile.id}">Detalhes</button>
          <button class="primary" type="button" data-action="open" data-id="${profile.id}">Abrir</button>
        </div>
      </div>`;
  }).join("");
  renderSessionPane();
}

function renderSessionPane() {
  const profile = selectedProfile();
  $("selectedName").textContent = profile ? profile.name : "Nenhum perfil";
  $("openRemoteBtn").disabled = !profile;
  $("releaseBtn").disabled = !profile || !profile.lockedBy;
  if (!profile) {
    $("activityLog").textContent = "Selecione um perfil para abrir uma sessao remota.";
    return;
  }
  const lockText = profile.lockedBy ? `Travado por ${profile.lockedByName}.` : "Perfil livre para uso.";
  const sessionText = profile.sessionState === "ready"
    ? "Sessao salva no servidor. O proximo usuario abre ja logado."
    : "Sessao ainda nao inicializada no servidor.";
  $("activityLog").textContent = `${lockText} ${sessionText}`;
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

async function loadProfiles() {
  const data = await api("/api/profiles");
  state.profiles = data.profiles || [];
  if (!state.selectedId && state.profiles[0]) state.selectedId = state.profiles[0].id;
  renderMetrics();
  renderProfiles();
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
    setServer("conectado", true);
    showApp();
    await loadProfiles();
  } catch (error) {
    $("loginMsg").textContent = error.message;
    setServer("erro de login");
  }
}

async function createProfile(event) {
  event.preventDefault();
  const name = $("profileName").value.trim();
  if (!name) return;
  const tags = $("profileTags").value.split(",").map((item) => item.trim()).filter(Boolean);
  const data = await api("/api/profiles", {
    method: "POST",
    body: {
      name,
      tiktokEmail: $("profileEmail").value.trim(),
      tags
    }
  });
  state.selectedId = data.profile.id;
  $("profileDialog").close();
  $("profileName").value = "";
  $("profileEmail").value = "";
  $("profileTags").value = "";
  await loadProfiles();
}

async function openRemote(profileId) {
  state.selectedId = profileId;
  const profile = selectedProfile();
  $("activityLog").textContent = profile ? `Abrindo sessao remota de ${profile.name}...` : "Abrindo sessao...";
  await api(`/api/profiles/${profileId}/session/start`, { method: "POST" });
  await loadProfiles();
}

async function releaseLock() {
  const profile = selectedProfile();
  if (!profile) return;
  await api(`/api/profiles/${profile.id}/release`, { method: "POST" });
  await loadProfiles();
}

async function boot() {
  try {
    await api("/api/health");
    setServer("online", true);
  } catch {
    setServer("offline");
  }
}

$("loginBtn").addEventListener("click", login);
$("password").addEventListener("keydown", (event) => {
  if (event.key === "Enter") login();
});
$("refreshBtn").addEventListener("click", loadProfiles);
$("search").addEventListener("input", renderProfiles);
$("newProfileBtn").addEventListener("click", () => $("profileDialog").showModal());
$("cancelProfileBtn").addEventListener("click", () => $("profileDialog").close());
$("profileDialog").addEventListener("submit", createProfile);
$("openRemoteBtn").addEventListener("click", () => {
  const profile = selectedProfile();
  if (profile) openRemote(profile.id);
});
$("releaseBtn").addEventListener("click", releaseLock);
$("profileList").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  const row = event.target.closest(".profile-row");
  const id = button?.dataset.id || row?.dataset.profileId;
  if (!id) return;
  state.selectedId = id;
  if (button?.dataset.action === "open") openRemote(id);
  else renderProfiles();
});

boot();
