const { contextBridge } = require("electron");

const apiArg = process.argv.find((arg) => arg.startsWith("--api-url="));
const apiBase = apiArg ? apiArg.slice("--api-url=".length) : "https://contas-v2.elevateecom.com.br";

contextBridge.exposeInMainWorld("elevate", {
  apiBase,
  appName: "Contas TikTok V2"
});
