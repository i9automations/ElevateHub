const { contextBridge, ipcRenderer } = require("electron");

const apiArg = process.argv.find((arg) => arg.startsWith("--api-url="));
const apiBase = apiArg ? apiArg.slice("--api-url=".length) : "https://contas-v2.elevateecom.com.br";
const versionArg = process.argv.find((arg) => arg.startsWith("--app-version="));
const appVersion = versionArg ? versionArg.slice("--app-version=".length) : "0.0.0";

contextBridge.exposeInMainWorld("elevate", {
  apiBase,
  appName: "elevatehub",
  appVersion,
  downloadUpdate: (info) => ipcRenderer.invoke("download-update", info),
  openExternal: (url) => ipcRenderer.invoke("open-external", url)
});
