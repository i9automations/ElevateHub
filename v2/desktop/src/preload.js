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
  installUpdateNow: () => ipcRenderer.invoke("install-update-now"),
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
