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
ICONE = os.path.join(PASTA, "app.ico")
LOGIN_URL = "https://seller-br.tiktok.com/account/login"

# ---- paleta (estilo Dolphin: navy escuro) ----
SIDE   = "#0d1219"
BG     = "#121821"
BAR    = "#0f151d"
ROW    = "#19212c"
ROWH   = "#202a37"
LINE   = "#2a3543"
CHIP   = "#1c2631"
FG     = "#e9eef5"
MUTED  = "#7e8a99"
TEAL   = "#19c39a"
TEALH  = "#21d8ac"
GREEN  = "#2ec27e"
GREENH = "#39d491"
TT_CY  = "#25f4ee"   # ciano do TikTok
TT_PK  = "#fe2c55"   # rosa do TikTok
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


class Dialogo(tk.Toplevel):
    """Dialogo ESCURO no tema (substitui os popups brancos do tkinter).
    modo: 'input' (texto), 'confirma' (Sim/Cancelar), 'info' (OK)."""

    def __init__(self, parent, titulo, msg, modo="input"):
        super().__init__(parent)
        self.modo = modo
        self.resultado = None
        self.var = tk.StringVar()
        self.title(titulo)
        self.configure(bg=ROW)
        try:
            if os.path.exists(ICONE):
                self.iconbitmap(ICONE)
        except Exception:
            pass
        self.transient(parent)
        self.resizable(False, False)

        tk.Label(self, text=titulo, bg=ROW, fg=FG,
                 font=(FONT, 14, "bold")).pack(anchor="w", padx=24, pady=(20, 4))
        tk.Label(self, text=msg, bg=ROW, fg=MUTED, font=(FONT, 10),
                 justify="left", wraplength=360).pack(anchor="w", padx=24)

        if modo == "input":
            cx = tk.Canvas(self, width=362, height=40, bg=ROW,
                           highlightthickness=0)
            _round_rect(cx, 1, 1, 361, 39, 9, fill=BAR, outline=LINE)
            cx.pack(padx=24, pady=(14, 2))
            ent = tk.Entry(cx, textvariable=self.var, bg=BAR, fg=FG,
                           insertbackground=FG, relief="flat", font=(FONT, 12))
            cx.create_window(182, 20, window=ent, width=332, height=24)
            ent.focus_set()
            ent.bind("<Return>", lambda e: self._ok())

        bar = tk.Frame(self, bg=ROW)
        bar.pack(fill="x", padx=24, pady=(16, 20))
        ok_txt = "OK" if modo != "confirma" else "Sim"
        RoundBtn(bar, ok_txt, self._ok, w=96, h=36, fill=TEAL, hover=TEALH,
                 fg="#06231f", pbg=ROW).pack(side="right", padx=(8, 0))
        if modo != "info":
            RoundBtn(bar, "Cancelar", self._cancel, w=104, h=36, fill=CHIP,
                     hover=ROWH, fg=FG, pbg=ROW).pack(side="right")

        self.bind("<Escape>", lambda e: self._cancel())
        self.protocol("WM_DELETE_WINDOW", self._cancel)
        self.update_idletasks()
        try:
            w, h = self.winfo_reqwidth(), self.winfo_reqheight()
            x = parent.winfo_rootx() + (parent.winfo_width() - w) // 2
            y = parent.winfo_rooty() + (parent.winfo_height() - h) // 3
            self.geometry(f"+{max(x, 0)}+{max(y, 0)}")
        except Exception:
            pass
        self.grab_set()
        self.wait_window()

    def _ok(self):
        self.resultado = self.var.get().strip() if self.modo == "input" else True
        self.destroy()

    def _cancel(self):
        self.resultado = None if self.modo == "input" else False
        self.destroy()


def pedir_texto(parent, titulo, msg):
    return Dialogo(parent, titulo, msg, "input").resultado


def confirmar(parent, titulo, msg):
    return bool(Dialogo(parent, titulo, msg, "confirma").resultado)


def avisar(parent, titulo, msg):
    Dialogo(parent, titulo, msg, "info")


class App:
    def __init__(self, root):
        self.root = root
        self.chrome = achar_chrome()
        os.makedirs(CHROME_UDD, exist_ok=True)
        self.contas = self._carregar()
        root.title("Contas TikTok")
        root.configure(bg=BG)
        self._estilo()

        # ===================== BARRA LATERAL =====================
        side = tk.Frame(root, bg=SIDE, width=212)
        side.pack(side="left", fill="y")
        side.pack_propagate(False)

        logo = tk.Frame(side, bg=SIDE)
        logo.pack(fill="x", pady=(20, 24), padx=18)
        lc = tk.Canvas(logo, width=36, height=36, bg=SIDE, highlightthickness=0)
        lc.create_oval(1, 1, 35, 35, fill="#0c0d11", outline="")
        # nota do TikTok com efeito glitch (ciano + rosa + branco)
        lc.create_text(20, 18, text="♪", fill=TT_CY, font=(FONT, 17, "bold"))
        lc.create_text(16, 18, text="♪", fill=TT_PK, font=(FONT, 17, "bold"))
        lc.create_text(18, 18, text="♪", fill="#ffffff", font=(FONT, 17, "bold"))
        lc.pack(side="left")
        tk.Label(logo, text="TikTok", fg=FG, bg=SIDE,
                 font=(FONT, 14, "bold")).pack(side="left", padx=8)

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
        cx = tk.Canvas(top, width=200, height=38, bg=BG, highlightthickness=0)
        _round_rect(cx, 1, 1, 199, 37, 9, fill=BAR, outline=LINE)
        cx.pack(side="right", padx=10)
        self.var_busca = tk.StringVar()
        ent = tk.Entry(cx, textvariable=self.var_busca, bg=BAR, fg=FG,
                       insertbackground=FG, relief="flat", font=(FONT, 11))
        cx.create_window(102, 19, window=ent, width=168, height=22)
        self.var_busca.trace_add("write", lambda *a: self._montar_lista())

        hd = tk.Frame(main, bg=BAR, height=34)
        hd.pack(fill="x", padx=22)
        hd.pack_propagate(False)
        tk.Label(hd, text="PERFIL", fg=MUTED, bg=BAR,
                 font=(FONT, 9, "bold")).pack(side="left", padx=(16, 0))
        tk.Label(hd, text="AÇÕES", fg=MUTED, bg=BAR,
                 font=(FONT, 9, "bold")).pack(side="right", padx=(0, 20))

        cont = tk.Frame(main, bg=BG)
        cont.pack(fill="both", expand=True, padx=22, pady=(0, 16))
        self.canvas = tk.Canvas(cont, bg=BG, highlightthickness=0)
        sb = ttk.Scrollbar(cont, orient="vertical", style="Dark.Vertical.TScrollbar",
                           command=self.canvas.yview)
        self.lista = tk.Frame(self.canvas, bg=BG)
        self._win = self.canvas.create_window((0, 0), window=self.lista,
                                              anchor="nw")
        self.lista.bind("<Configure>", self._on_lista_config)
        self.canvas.bind("<Configure>", self._on_canvas_config)
        self.canvas.configure(yscrollcommand=sb.set)
        self.canvas.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        self.canvas.bind_all("<MouseWheel>", lambda e: self.canvas.yview_scroll(
            int(-e.delta / 120), "units"))

        if not self.chrome:
            self.root.after(400, lambda: avisar(
                self.root, "Chrome não encontrado",
                "Instale o Google Chrome (google.com/chrome) e abra de novo."))
        self._montar_lista()

    def _estilo(self):
        s = ttk.Style(self.root)
        try:
            s.theme_use("clam")
        except Exception:
            pass
        # barra de rolagem ESCURA (sem o clam fica branca no Windows)
        s.configure("Dark.Vertical.TScrollbar", troughcolor=BG,
                    background=LINE, bordercolor=BG, arrowcolor=MUTED,
                    relief="flat", borderwidth=0)
        s.map("Dark.Vertical.TScrollbar",
              background=[("active", ROWH), ("pressed", ROWH)])

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
        elif not visiveis:
            self._placeholder("Nenhum perfil com esse nome.")
        else:
            for i, nome in enumerate(self.contas):
                if nome in visiveis:
                    self._linha(i, nome)
        # mantem a lista no TOPO (corrige o scroll ficar preso embaixo)
        self.root.after_idle(self._sync_scroll)

    def _on_canvas_config(self, e):
        self.canvas.itemconfig(self._win, width=e.width)
        self._fit()

    def _on_lista_config(self, e):
        self.canvas.configure(scrollregion=self.canvas.bbox("all"))
        self._fit()

    def _fit(self):
        # se o conteudo cabe na area visivel, GRUDA no topo (sem scroll fantasma)
        try:
            box = self.canvas.bbox("all")
            if not box:
                return
            alt_conteudo = box[3] - box[1]
            if alt_conteudo <= self.canvas.winfo_height():
                self.canvas.yview_moveto(0)
        except Exception:
            pass

    def _sync_scroll(self):
        try:
            self.canvas.configure(scrollregion=self.canvas.bbox("all"))
            self.canvas.yview_moveto(0)
            self._fit()
        except Exception:
            pass

    def _placeholder(self, txt):
        box = tk.Frame(self.lista, bg=BG)
        box.pack(pady=(90, 0))
        tk.Label(box, text="🗂️", fg=FG, bg=BG,
                 font=(FONT, 44)).pack()
        tk.Label(box, text=txt, fg=MUTED, bg=BG,
                 font=(FONT, 12)).pack(pady=(6, 0))

    def _linha(self, i, nome):
        cor = CORES[i % len(CORES)]
        card = tk.Frame(self.lista, bg=ROW, height=60)
        card.pack(fill="x", pady=(0, 1))
        card.pack_propagate(False)

        tk.Label(card, text="⊞", fg="#5b9bd5", bg=ROW,
                 font=(FONT, 13)).pack(side="left", padx=(16, 2))
        tk.Label(card, text="🌐", fg=MUTED, bg=ROW,
                 font=(FONT, 11)).pack(side="left", padx=(0, 12))
        _avatar(card, nome[:1].upper(), cor, ROW).pack(side="left",
                                                       padx=(0, 10))
        tk.Label(card, text=nome, fg=FG, bg=ROW,
                 font=(FONT, 13, "bold")).pack(side="left")

        RoundBtn(card, "🗑", lambda: self._remover(nome), w=40, h=32, r=8,
                 fill=CHIP, hover="#3a2630", fg=MUTED, pbg=ROW,
                 size=11).pack(side="right", padx=(4, 16))
        RoundBtn(card, "▶  START", lambda: self._abrir(nome), w=116, h=36,
                 r=9, fill=GREEN, hover=GREENH, fg="#06231f", pbg=ROW,
                 size=11).pack(side="right", padx=4)
        tag = tk.Canvas(card, width=84, height=24, bg=ROW,
                        highlightthickness=0)
        _round_rect(tag, 1, 1, 83, 23, 7, fill=CHIP, outline="")
        tag.create_text(42, 12, text="TikTok Shop", fill="#8fb7ff",
                        font=(FONT, 8, "bold"))
        tag.pack(side="right", padx=10)

    # ---------- acoes ----------
    def nova(self):
        nome = pedir_texto(self.root, "Novo perfil",
                           "Nome do cliente (ex: Loja da Ana):")
        if not nome:
            return
        if nome in self.contas:
            avisar(self.root, "Já existe", "Já tem um perfil com esse nome.")
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
            avisar(self.root, "Chrome não encontrado",
                   "Não achei o Google Chrome instalado.")
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
            avisar(self.root, "Erro ao abrir", str(e))

    def _remover(self, nome):
        if not confirmar(
                self.root, "Remover perfil",
                f"Remover '{nome}'? Isso APAGA o login salvo dele (vai precisar "
                "logar de novo). Feche o navegador desse perfil antes."):
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
    try:                                  # icone proprio (tira a pena do Python)
        if os.path.exists(ICONE):
            root.iconbitmap(ICONE)
    except Exception:
        pass
    try:
        dpi = root.winfo_fpixels("1i")
        root.tk.call("tk", "scaling", dpi / 72.0)
        f = dpi / 96.0
        root.geometry(f"{int(940 * f)}x{int(620 * f)}")
        root.minsize(int(780 * f), int(460 * f))
    except Exception:
        pass
    try:
        root.state("zoomed")          # abre maximizado (tela cheia)
    except Exception:
        pass
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
