const { contextBridge, ipcRenderer } = require("electron");

const apiArg = process.argv.find((arg) => arg.startsWith("--api-url="));
const apiBase = apiArg ? apiArg.slice("--api-url=".length) : "https://contas-v2.elevateecom.com.br";
const versionArg = process.argv.find((arg) => arg.startsWith("--app-version="));
const appVersion = versionArg ? versionArg.slice("--app-version=".length) : "0.0.0";

contextBridge.exposeInMainWorld("elevate", {
  apiBase,
  appName: "ElevateHub",
  appVersion,
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  openBrowserProfile: (info) => ipcRenderer.invoke("open-browser-profile", info),
  collectAdsMetrics: (info) => ipcRenderer.invoke("collect-ads-metrics", info),
  openCreatorsPanel: (info) => ipcRenderer.invoke("open-creators-panel", info),
  saveOpenReport: (html) => ipcRenderer.invoke("save-open-report", html),
  openLastReport: () => ipcRenderer.invoke("open-last-report"),
  onBrowserProfileClosed: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("browser-profile-closed", handler);
    return () => ipcRenderer.removeListener("browser-profile-closed", handler);
  },
  onBrowserProfileCookies: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("browser-profile-cookies", handler);
    return () => ipcRenderer.removeListener("browser-profile-cookies", handler);
  },
  // Avisa o renderer quando o painel de creators publicou seu endereco local
  // (127.0.0.1:porta) -> o renderer carrega numa <webview> embutida.
  onCreatorsPanelReady: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("creators-panel-ready", handler);
    return () => ipcRenderer.removeListener("creators-panel-ready", handler);
  },
  installUpdateNow: () => ipcRenderer.invoke("install-update-now"),
  getUpdateStatus: () => ipcRenderer.invoke("get-update-status"),
  onUpdateAvailable: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("update-available", handler);
    return () => ipcRenderer.removeListener("update-available", handler);
  },
  onUpdateDownloaded: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("update-downloaded", handler);
    return () => ipcRenderer.removeListener("update-downloaded", handler);
  },
  onUpdateProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("update-progress", handler);
    return () => ipcRenderer.removeListener("update-progress", handler);
  }
});
