const { app, BrowserWindow, ipcMain, shell, Menu } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");

const API_URL = process.env.ELEVATE_API_URL || "https://contas-v2.elevateecom.com.br";
const APP_NAME = "elevatehub";
const UPDATE_HOSTS = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);

function installerFileName(name, url) {
  const fromName = path.basename(String(name || ""));
  const fromUrl = path.basename(new URL(String(url)).pathname);
  const candidate = fromName || fromUrl || "elevatehub.Setup.exe";
  const clean = candidate.replace(/[^a-z0-9._ -]/gi, "_");
  if (/\.exe$/i.test(clean)) return clean;
  return "elevatehub.Setup.exe";
}

async function downloadInstaller(url, name) {
  const parsed = new URL(String(url));
  if (parsed.protocol !== "https:" || !UPDATE_HOSTS.has(parsed.hostname)) {
    throw new Error("Link de atualizacao invalido.");
  }

  const response = await fetch(parsed.toString(), {
    headers: { "User-Agent": `${APP_NAME}/${app.getVersion()}` }
  });
  if (!response.ok) throw new Error("Nao foi possivel baixar a atualizacao.");

  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:" || !UPDATE_HOSTS.has(finalUrl.hostname)) {
    throw new Error("Origem da atualizacao invalida.");
  }

  const updatesDir = path.join(app.getPath("temp"), "elevatehub-updates");
  const filePath = path.join(updatesDir, installerFileName(name, url));
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.mkdir(updatesDir, { recursive: true });
  await fs.writeFile(filePath, buffer);
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

  ipcMain.handle("download-update", async (_event, info) => {
    const filePath = await downloadInstaller(info?.url, info?.name);
    const error = await shell.openPath(filePath);
    if (error) throw new Error(error);
    setTimeout(() => app.quit(), 900);
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
