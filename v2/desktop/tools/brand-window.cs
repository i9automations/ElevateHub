// brand-window.exe — ajudante nativo do ElevateHub.
// Injeta um icone (.ico) na janela de um processo (por PID) via WM_SETICON.
// Uso: brand-window.exe <PID> <caminho-do-ico>
//
// Por que existe: o Chrome define o proprio icone em tempo de execucao e IGNORA o
// icone gravado no chrome.exe. A UNICA forma de o navegador aberto aparecer com a
// logo do ElevateHub (azul) na barra de tarefas/janela e mandar WM_SETICON na janela
// depois que ela existe. E "melhor-esforco": se falhar, o navegador abre normal.
using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Diagnostics;

class BrandWindow {
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr LoadImage(IntPtr hinst, string name, uint type, int cx, int cy, uint load);
  [DllImport("user32.dll")]
  static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")]
  static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")]
  static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")]
  static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]
  static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
  delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  const int WM_SETICON = 0x0080;
  const uint IMAGE_ICON = 1;
  const uint LR_LOADFROMFILE = 0x0010;
  const uint LR_DEFAULTSIZE = 0x0040;
  const uint GW_OWNER = 4;

  static uint targetPid;
  static IntPtr iconSmall, iconBig;
  static bool any;

  static void Main(string[] args) {
    try {
      if (args.Length < 2) return;
      if (!uint.TryParse(args[0], out targetPid)) return;
      string ico = args[1];
      iconSmall = LoadImage(IntPtr.Zero, ico, IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE);
      iconBig   = LoadImage(IntPtr.Zero, ico, IMAGE_ICON, 256, 256, LR_LOADFROMFILE);
      if (iconSmall == IntPtr.Zero && iconBig == IntPtr.Zero) return;
      // A janela pode surgir um instante depois da abertura -> tenta por ~12s.
      bool setOnce = false;
      for (int i = 0; i < 60; i++) {
        any = false;
        EnumWindows(Callback, IntPtr.Zero);
        if (any) setOnce = true;
        if (any && i > 2) break;   // achou e ja passou o inicio -> pega a janela final
        Thread.Sleep(200);
      }
      // IMPORTANTE: o HICON criado aqui morre quando ESTE processo sai -> a janela
      // perderia o icone. Entao ficamos vivos enquanto o navegador estiver aberto
      // (segurando o icone) e saimos junto com ele. Consumo minimo, e auto-limpa.
      if (setOnce) {
        try { Process.GetProcessById((int)targetPid).WaitForExit(); } catch { /* ja saiu */ }
      }
    } catch { /* melhor-esforco: nunca falha de forma que atrapalhe o navegador */ }
  }

  static bool Callback(IntPtr hWnd, IntPtr l) {
    uint pid;
    GetWindowThreadProcessId(hWnd, out pid);
    // janela de topo (sem dono), visivel, do processo alvo
    if (pid == targetPid && IsWindowVisible(hWnd) && GetWindow(hWnd, GW_OWNER) == IntPtr.Zero) {
      if (iconSmall != IntPtr.Zero) SendMessage(hWnd, WM_SETICON, (IntPtr)0, iconSmall);
      if (iconBig   != IntPtr.Zero) SendMessage(hWnd, WM_SETICON, (IntPtr)1, iconBig);
      any = true;
    }
    return true;
  }
}
