const { app, BrowserWindow, ipcMain, shell, Menu } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");

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

  ipcMain.handle("download-update", async (event, info) => {
    const send = (data) => {
      if (!event.sender.isDestroyed()) event.sender.send("update-progress", data);
    };
    const filePath = await downloadInstaller(info, send);
    const error = await shell.openPath(filePath);
    if (error) throw new Error(error);
    setTimeout(() => app.quit(), 1600);
    return true;
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
