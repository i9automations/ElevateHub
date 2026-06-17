"""
CONTAS TIKTOK — gerenciador de perfis (estilo Dolphin), UI caprichada em
tkinter puro (sem instalar nada): avatares redondos, botoes arredondados, busca.
Cada conta = um PERFIL DO CHROME proprio. Cria -> Iniciar -> loga 1x -> fica
logado. SEM proxy/anti-deteccao (veja LEIA-ME.txt).
"""

import os
import re
import json
import shutil
import subprocess
import tkinter as tk
from tkinter import ttk, simpledialog, messagebox

PASTA = os.path.dirname(os.path.abspath(__file__))
CHROME_UDD = os.path.join(PASTA, "navegadores")
REG = os.path.join(PASTA, "contas.json")
LOGIN_URL = "https://seller-br.tiktok.com/account/login"

# ---- paleta ----
BG     = "#0e1217"
HEADER = "#141b24"
CARD   = "#1a212b"
CARDH  = "#212a36"
CHIP   = "#283442"
INPUT  = "#0b0f14"
TEAL   = "#16c79a"
TEALH  = "#1ee0af"
GREEN  = "#1db877"
GREENH = "#26d992"
FG     = "#eaeef4"
MUTED  = "#828d9c"
REDX   = "#e5564e"
FONT   = "Segoe UI"

CORES = ["#a78bfa", "#34d399", "#60a5fa", "#fbbf24", "#fb7185",
         "#22d3ee", "#f472b6", "#4ade80", "#818cf8", "#f0883e"]


def achar_chrome():
    cands = [
        os.path.join(os.environ.get("PROGRAMFILES", ""),
                     r"Google\Chrome\Application\chrome.exe"),
        os.path.join(os.environ.get("PROGRAMFILES(X86)", ""),
                     r"Google\Chrome\Application\chrome.exe"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""),
                     r"Google\Chrome\Application\chrome.exe"),
    ]
    for c in cands:
        if c and os.path.exists(c):
            return c
    return shutil.which("chrome") or shutil.which("chrome.exe")


def _slug(nome):
    return re.sub(r'[\\/:*?"<>|]', "", nome).strip() or "conta"


def _round_rect(cv, x1, y1, x2, y2, r, **kw):
    pts = [x1 + r, y1, x2 - r, y1, x2, y1, x2, y1 + r, x2, y2 - r, x2, y2,
           x2 - r, y2, x1 + r, y2, x1, y2, x1, y2 - r, x1, y1 + r, x1, y1]
    return cv.create_polygon(pts, smooth=True, **kw)


class RoundBtn(tk.Canvas):
    """Botao arredondado desenhado (com hover)."""

    def __init__(self, parent, text, command, w=124, h=38, r=10,
                 fill=GREEN, hover=GREENH, fg="#06231f", pbg=CARD,
                 size=12, bold=True):
        super().__init__(parent, width=w, height=h, bg=pbg,
                         highlightthickness=0, cursor="hand2")
        self._fill, self._hover, self._cmd = fill, hover, command
        self._r = _round_rect(self, 1, 1, w - 1, h - 1, r, fill=fill,
                              outline="")
        self.create_text(w // 2, h // 2, text=text, fill=fg,
                         font=(FONT, size, "bold" if bold else "normal"))
        self.bind("<Button-1>", lambda e: self._cmd())
        self.bind("<Enter>", lambda e: self.itemconfig(self._r, fill=hover))
        self.bind("<Leave>", lambda e: self.itemconfig(self._r, fill=fill))


def _avatar(parent, inicial, cor, bg, size=46):
    c = tk.Canvas(parent, width=size, height=size, bg=bg,
                  highlightthickness=0)
    c.create_oval(2, 2, size - 2, size - 2, fill=cor, outline="")
    c.create_text(size // 2, size // 2, text=inicial, fill="#0c0d11",
                  font=(FONT, 17, "bold"))
    return c


class App:
    def __init__(self, root):
        self.root = root
        self.chrome = achar_chrome()
        os.makedirs(CHROME_UDD, exist_ok=True)
        self.contas = self._carregar()
        root.title("Contas TikTok")
        root.configure(bg=BG)

        # ===== cabecalho =====
        top = tk.Frame(root, bg=HEADER, height=74)
        top.pack(fill="x")
        top.pack_propagate(False)

        logo = tk.Canvas(top, width=40, height=40, bg=HEADER,
                         highlightthickness=0)
        logo.create_oval(3, 3, 37, 37, fill=TEAL, outline="")
        logo.create_text(20, 20, text="🐬", font=(FONT, 15))
        logo.pack(side="left", padx=(20, 12))
        cab = tk.Frame(top, bg=HEADER)
        cab.pack(side="left")
        tk.Label(cab, text="Contas TikTok", fg=FG, bg=HEADER,
                 font=(FONT, 17, "bold")).pack(anchor="w")
        self.var_info = tk.StringVar()
        tk.Label(cab, textvariable=self.var_info, fg=MUTED, bg=HEADER,
                 font=(FONT, 10)).pack(anchor="w")

        RoundBtn(top, "+  Criar perfil", self.nova, w=148, h=42, r=11,
                 fill=TEAL, hover=TEALH, fg="#06231f", pbg=HEADER,
                 size=12).pack(side="right", padx=20)

        # busca
        cx = tk.Canvas(top, width=210, height=40, bg=HEADER,
                       highlightthickness=0)
        _round_rect(cx, 1, 1, 209, 39, 10, fill=INPUT, outline="")
        cx.pack(side="right", padx=8)
        self.var_busca = tk.StringVar()
        ent = tk.Entry(cx, textvariable=self.var_busca, bg=INPUT, fg=FG,
                       insertbackground=FG, relief="flat", font=(FONT, 11))
        cx.create_window(105, 20, window=ent, width=180, height=24)
        ent.insert(0, "")
        self.var_busca.trace_add("write", lambda *a: self._montar_lista())

        # ===== lista rolavel =====
        cont = tk.Frame(root, bg=BG)
        cont.pack(fill="both", expand=True, padx=16, pady=14)
        self.canvas = tk.Canvas(cont, bg=BG, highlightthickness=0)
        sb = ttk.Scrollbar(cont, orient="vertical", command=self.canvas.yview)
        self.lista = tk.Frame(self.canvas, bg=BG)
        self._win = self.canvas.create_window((0, 0), window=self.lista,
                                              anchor="nw")
        self.lista.bind("<Configure>", lambda e: self.canvas.configure(
            scrollregion=self.canvas.bbox("all")))
        self.canvas.bind("<Configure>", lambda e: self.canvas.itemconfig(
            self._win, width=e.width))
        self.canvas.configure(yscrollcommand=sb.set)
        self.canvas.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        self.canvas.bind_all("<MouseWheel>", lambda e: self.canvas.yview_scroll(
            int(-e.delta / 120), "units"))

        if not self.chrome:
            messagebox.showwarning(
                "Chrome nao encontrado",
                "Instale o Google Chrome (google.com/chrome) e abra de novo.")
        self._montar_lista()

    # ---------- dados ----------
    def _carregar(self):
        try:
            with open(REG, encoding="utf-8") as f:
                return json.load(f).get("contas", [])
        except Exception:
            return []

    def _salvar(self):
        try:
            with open(REG, "w", encoding="utf-8") as f:
                json.dump({"contas": self.contas}, f, ensure_ascii=False,
                          indent=2)
        except Exception:
            pass

    def _montar_lista(self):
        for w in self.lista.winfo_children():
            w.destroy()
        filtro = self.var_busca.get().strip().lower()
        self.var_info.set(f"{len(self.contas)} perfil(is)")
        visiveis = [n for n in self.contas if filtro in n.lower()]
        if not self.contas:
            self._placeholder("Nenhum perfil ainda.  Clique em "
                              "“+ Criar perfil”.")
            return
        if not visiveis:
            self._placeholder("Nenhum perfil com esse nome.")
            return
        for i, nome in enumerate(self.contas):
            if nome in visiveis:
                self._linha(i, nome)

    def _placeholder(self, txt):
        tk.Label(self.lista, text=txt, fg=MUTED, bg=BG,
                 font=(FONT, 12)).pack(pady=40)

    def _linha(self, i, nome):
        cor = CORES[i % len(CORES)]
        card = tk.Frame(self.lista, bg=CARD, height=70)
        card.pack(fill="x", pady=(0, 8))
        card.pack_propagate(False)

        _avatar(card, nome[:1].upper(), cor, CARD).pack(side="left",
                                                        padx=(14, 14))
        tk.Label(card, text=nome, fg=FG, bg=CARD,
                 font=(FONT, 14, "bold")).pack(side="left")

        RoundBtn(card, "🗑", lambda: self._remover(nome), w=42, h=36, r=9,
                 fill=CHIP, hover="#3a2630", fg=MUTED, pbg=CARD,
                 size=12).pack(side="right", padx=(4, 14))
        RoundBtn(card, "▶  Iniciar", lambda: self._abrir(nome), w=124, h=40,
                 r=11, fill=GREEN, hover=GREENH, fg="#06231f", pbg=CARD,
                 size=12).pack(side="right", padx=4)
        tk.Label(card, text="  tiktok  ", fg=MUTED, bg=CHIP,
                 font=(FONT, 9)).pack(side="right", padx=10, ipady=3)

    # ---------- acoes ----------
    def nova(self):
        nome = simpledialog.askstring(
            "Novo perfil", "Nome do cliente (ex: Loja da Ana):",
            parent=self.root)
        if not nome:
            return
        nome = nome.strip()
        if not nome:
            return
        if nome in self.contas:
            messagebox.showinfo("Ja existe", "Ja tem um perfil com esse nome.")
            return
        self.contas.append(nome)
        self._salvar()
        self._semear_perfil(nome)
        self._montar_lista()

    def _perfil_dir(self, nome):
        return os.path.join(CHROME_UDD, _slug(nome))

    def _semear_perfil(self, nome):
        d = self._perfil_dir(nome)
        os.makedirs(d, exist_ok=True)
        prefs = os.path.join(d, "Preferences")
        if not os.path.exists(prefs):
            try:
                with open(prefs, "w", encoding="utf-8") as f:
                    json.dump({"profile": {"name": nome}}, f)
            except Exception:
                pass

    def _abrir(self, nome):
        if not self.chrome:
            messagebox.showerror("Chrome nao encontrado",
                                 "Nao achei o Google Chrome instalado.")
            return
        self._semear_perfil(nome)
        try:
            subprocess.Popen([
                self.chrome,
                f"--user-data-dir={CHROME_UDD}",
                f"--profile-directory={_slug(nome)}",
                "--no-first-run",
                "--no-default-browser-check",
                LOGIN_URL,
            ])
        except Exception as e:
            messagebox.showerror("Erro ao abrir", str(e))

    def _remover(self, nome):
        if not messagebox.askyesno(
                "Remover perfil",
                f"Remover '{nome}'?\n\nIsso APAGA o login salvo dele (vai "
                "precisar logar de novo).\nFeche o navegador desse perfil antes."):
            return
        if nome in self.contas:
            self.contas.remove(nome)
            self._salvar()
        try:
            shutil.rmtree(self._perfil_dir(nome), ignore_errors=True)
        except Exception:
            pass
        self._montar_lista()


def _corrigir_dpi():
    try:
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def main():
    _corrigir_dpi()
    root = tk.Tk()
    try:
        dpi = root.winfo_fpixels("1i")
        root.tk.call("tk", "scaling", dpi / 72.0)
        f = dpi / 96.0
        root.geometry(f"{int(740 * f)}x{int(620 * f)}")
        root.minsize(int(600 * f), int(440 * f))
    except Exception:
        pass
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
