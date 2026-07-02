const { contextBridge } = require("electron");

const apiArg = process.argv.find((arg) => arg.startsWith("--api-url="));
const apiBase = apiArg ? apiArg.slice("--api-url=".length) : "http://127.0.0.1:8787";

contextBridge.exposeInMainWorld("elevate", {
  apiBase,
  appName: "Contas TikTok V2"
});
