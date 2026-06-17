"""
CONTAS TIKTOK — gerenciador de perfis no LAYOUT do Dolphin (barra lateral +
tabela de perfis). tkinter puro (sem instalar nada). Cada conta = um PERFIL do
Chrome. Criar -> START -> loga 1x -> fica logado. SEM proxy (veja LEIA-ME.txt).
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

# ---- paleta (estilo Dolphin: navy escuro) ----
SIDE   = "#0d1219"   # barra lateral
BG     = "#121821"   # fundo principal
BAR    = "#0f151d"   # topo / cabecalho tabela
ROW    = "#19212c"   # linha
ROWH   = "#202a37"   # linha hover
LINE   = "#232d3a"   # divisorias
CHIP   = "#1c2631"   # chip/tag bg
FG     = "#e9eef5"
MUTED  = "#7e8a99"
TEAL   = "#19c39a"   # acento (criar perfil / ativo)
TEALH  = "#21d8ac"
GREEN  = "#2ec27e"   # START (contorno)
BLUE   = "#3b82f6"
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
    """Botao arredondado (preenchido ou contornado), com hover."""

    def __init__(self, parent, text, command, w=110, h=34, r=9,
                 fill=TEAL, hover=TEALH, fg="#06231f", pbg=ROW, size=11,
                 contorno=None):
        super().__init__(parent, width=w, height=h, bg=pbg,
                         highlightthickness=0, cursor="hand2")
        self._cmd = command
        if contorno:
            self._r = _round_rect(self, 2, 2, w - 2, h - 2, r, fill=pbg,
                                  outline=contorno, width=2)
            self._t = self.create_text(w // 2, h // 2, text=text,
                                       fill=contorno,
                                       font=(FONT, size, "bold"))
            self.bind("<Enter>", lambda e: (
                self.itemconfig(self._r, fill=contorno),
                self.itemconfig(self._t, fill="#06231f")))
            self.bind("<Leave>", lambda e: (
                self.itemconfig(self._r, fill=pbg),
                self.itemconfig(self._t, fill=contorno)))
        else:
            self._r = _round_rect(self, 1, 1, w - 1, h - 1, r, fill=fill,
                                  outline="")
            self.create_text(w // 2, h // 2, text=text, fill=fg,
                             font=(FONT, size, "bold"))
            self.bind("<Enter>", lambda e: self.itemconfig(self._r, fill=hover))
            self.bind("<Leave>", lambda e: self.itemconfig(self._r, fill=fill))
        self.bind("<Button-1>", lambda e: self._cmd())


def _avatar(parent, inicial, cor, bg, size=34):
    c = tk.Canvas(parent, width=size, height=size, bg=bg,
                  highlightthickness=0)
    c.create_oval(1, 1, size - 1, size - 1, fill=cor, outline="")
    c.create_text(size // 2, size // 2, text=inicial, fill="#0c0d11",
                  font=(FONT, 13, "bold"))
    return c


class App:
    def __init__(self, root):
        self.root = root
        self.chrome = achar_chrome()
        os.makedirs(CHROME_UDD, exist_ok=True)
        self.contas = self._carregar()
        root.title("Contas TikTok")
        root.configure(bg=BG)

        # ===================== BARRA LATERAL =====================
        side = tk.Frame(root, bg=SIDE, width=210)
        side.pack(side="left", fill="y")
        side.pack_propagate(False)

        logo = tk.Frame(side, bg=SIDE)
        logo.pack(fill="x", pady=(20, 24), padx=18)
        lc = tk.Canvas(logo, width=34, height=34, bg=SIDE, highlightthickness=0)
        lc.create_oval(2, 2, 32, 32, fill=TEAL, outline="")
        lc.create_text(17, 17, text="🐬", font=(FONT, 13))
        lc.pack(side="left")
        tk.Label(logo, text="Contas", fg=FG, bg=SIDE,
                 font=(FONT, 14, "bold")).pack(side="left", padx=8)

        # item ativo "Todos os perfis" (com barra teal a esquerda)
        item = tk.Frame(side, bg=ROW)
        item.pack(fill="x", padx=10)
        tk.Frame(item, bg=TEAL, width=3).pack(side="left", fill="y")
        tk.Label(item, text="  📁  Todos os perfis", fg=FG, bg=ROW,
                 font=(FONT, 11, "bold"), anchor="w").pack(side="left",
                                                           fill="x", pady=10)
        self.var_cont = tk.StringVar()
        tk.Label(side, textvariable=self.var_cont, fg=MUTED, bg=SIDE,
                 font=(FONT, 10), anchor="w").pack(fill="x", padx=24,
                                                   pady=(14, 0))

        # rodape da sidebar
        tk.Label(side, text="sem proxy · sem anti-deteccao", fg=MUTED, bg=SIDE,
                 font=(FONT, 8), wraplength=170, justify="left").pack(
            side="bottom", anchor="w", padx=18, pady=16)

        # ===================== AREA PRINCIPAL =====================
        main = tk.Frame(root, bg=BG)
        main.pack(side="left", fill="both", expand=True)

        top = tk.Frame(main, bg=BG, height=70)
        top.pack(fill="x", padx=22, pady=(18, 8))
        top.pack_propagate(False)
        tk.Label(top, text="Todos os perfis", fg=FG, bg=BG,
                 font=(FONT, 18, "bold")).pack(side="left")

        RoundBtn(top, "+  Criar perfil", self.nova, w=150, h=40, r=10,
                 fill=TEAL, hover=TEALH, fg="#06231f", pbg=BG,
                 size=12).pack(side="right")
        # busca
        cx = tk.Canvas(top, width=200, height=38, bg=BG, highlightthickness=0)
        _round_rect(cx, 1, 1, 199, 37, 9, fill=BAR, outline=LINE)
        cx.pack(side="right", padx=10)
        self.var_busca = tk.StringVar()
        ent = tk.Entry(cx, textvariable=self.var_busca, bg=BAR, fg=FG,
                       insertbackground=FG, relief="flat", font=(FONT, 11))
        cx.create_window(102, 19, window=ent, width=168, height=22)
        self.var_busca.trace_add("write", lambda *a: self._montar_lista())

        # cabecalho da tabela
        hd = tk.Frame(main, bg=BAR, height=34)
        hd.pack(fill="x", padx=22)
        hd.pack_propagate(False)
        tk.Label(hd, text="PERFIL", fg=MUTED, bg=BAR,
                 font=(FONT, 9, "bold")).pack(side="left", padx=(16, 0))
        tk.Label(hd, text="AÇÕES", fg=MUTED, bg=BAR,
                 font=(FONT, 9, "bold")).pack(side="right", padx=(0, 20))
        tk.Label(hd, text="TAGS", fg=MUTED, bg=BAR,
                 font=(FONT, 9, "bold")).pack(side="right", padx=(0, 150))

        # lista rolavel
        cont = tk.Frame(main, bg=BG)
        cont.pack(fill="both", expand=True, padx=22, pady=(0, 16))
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
        self.var_cont.set(f"{len(self.contas)} perfil(is)")
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
        card = tk.Frame(self.lista, bg=ROW, height=60)
        card.pack(fill="x", pady=(0, 1))
        card.pack_propagate(False)

        # icones tipo Dolphin (windows + globo)
        tk.Label(card, text="⊞", fg="#5b9bd5", bg=ROW,
                 font=(FONT, 13)).pack(side="left", padx=(16, 2))
        tk.Label(card, text="🌐", fg=MUTED, bg=ROW,
                 font=(FONT, 11)).pack(side="left", padx=(0, 12))
        _avatar(card, nome[:1].upper(), cor, ROW).pack(side="left",
                                                       padx=(0, 10))
        tk.Label(card, text=nome, fg=FG, bg=ROW,
                 font=(FONT, 13, "bold")).pack(side="left")

        # acoes (direita)
        RoundBtn(card, "🗑", lambda: self._remover(nome), w=40, h=32, r=8,
                 fill=CHIP, hover="#3a2630", fg=MUTED, pbg=ROW,
                 size=11).pack(side="right", padx=(4, 16))
        RoundBtn(card, "▷  START", lambda: self._abrir(nome), w=110, h=34,
                 r=9, pbg=ROW, contorno=GREEN, size=11).pack(side="right",
                                                             padx=4)
        # tag estilo Dolphin
        tag = tk.Canvas(card, width=84, height=24, bg=ROW,
                        highlightthickness=0)
        _round_rect(tag, 1, 1, 83, 23, 7, fill=CHIP, outline="")
        tag.create_text(42, 12, text="TikTok Shop", fill="#8fb7ff",
                        font=(FONT, 8, "bold"))
        tag.pack(side="right", padx=10)

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
        root.geometry(f"{int(940 * f)}x{int(620 * f)}")
        root.minsize(int(780 * f), int(460 * f))
    except Exception:
        pass
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
