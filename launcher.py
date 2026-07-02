"""
LAUNCHER do CONTAS TIKTOK — auto-atualizavel.
Toda vez que abre, baixa a versao mais NOVA do app (navegador.py) do GitHub e
roda. Assim, o que voce atualizar no repositorio aparece no app na proxima
abertura. Sem internet, usa a ultima versao baixada (cache local).

Repo: https://github.com/i9automations/contas-tiktok
"""

import os
import sys
import time
import urllib.request

# IMPORTANTE: o navegador.py e baixado em tempo de execucao, entao o PyInstaller
# nao ve os imports dele. Importamos aqui tudo que ele usa pra GARANTIR que o
# .exe empacote esses modulos (senao da "No module named 'json'" etc).
import json            # noqa: F401
import re              # noqa: F401
import shutil          # noqa: F401
import subprocess      # noqa: F401
import threading       # noqa: F401
import http.server     # noqa: F401
import socketserver    # noqa: F401
import urllib.parse    # noqa: F401
import webbrowser      # noqa: F401
import base64          # noqa: F401
import ctypes          # noqa: F401
import imaplib         # noqa: F401
import email           # noqa: F401
import email.policy    # noqa: F401

# A API do GitHub reflete a versao mais nova NA HORA. O raw.githubusercontent
# tem um cache (CDN) que ignora ?t= e servia versao velha -> por isso usamos a
# API primeiro, com o raw so de reserva.
API_URL = ("https://api.github.com/repos/i9automations/contas-tiktok/"
           "contents/navegador.py?ref=main")
RAW_URL = ("https://raw.githubusercontent.com/i9automations/"
           "contas-tiktok/main/navegador.py")


def _tem_dados_app(pasta):
    return any(os.path.exists(os.path.join(pasta, nome))
               for nome in ("contas.json", "navegadores", "contas", "backups"))


def _parece_app_antigo(pasta):
    if not os.path.isdir(pasta) or not _tem_dados_app(pasta):
        return False
    sinais = ("Contas TikTok.exe", "launcher.py", "navegador.py",
              "ABRIR.bat", "LEIA-ME.txt")
    return any(os.path.exists(os.path.join(pasta, nome)) for nome in sinais)


def _desktop_dirs():
    cands = [
        os.path.join(os.environ.get("USERPROFILE", ""), "Desktop"),
        os.path.join(os.environ.get("OneDrive", ""), "Desktop"),
        os.path.join(os.environ.get("OneDriveConsumer", ""), "Desktop"),
        os.path.join(os.environ.get("OneDriveCommercial", ""), "Desktop"),
    ]
    vistos, out = set(), []
    for p in cands:
        if not p:
            continue
        ap = os.path.abspath(p)
        if ap.lower() not in vistos and os.path.isdir(ap):
            vistos.add(ap.lower())
            out.append(ap)
    return out


def _origens_migracao(exe_dir, base):
    vistos, origens = set(), []

    def add(pasta):
        ap = os.path.abspath(pasta)
        if ap.lower() in vistos or ap.lower() == os.path.abspath(base).lower():
            return
        vistos.add(ap.lower())
        if _parece_app_antigo(ap):
            origens.append(ap)

    add(exe_dir)  # caso ideal: exe novo rodado dentro da pasta antiga
    for desk in _desktop_dirs():
        add(desk)  # caso alguem usasse o app direto na Area de Trabalho
        try:
            for nome in os.listdir(desk):
                p = os.path.join(desk, nome)
                if os.path.isdir(p):
                    add(p)
        except Exception:
            pass
    return origens


def _migrar_dados_antigos(base):
    # Nao sobrescreve instalacao que ja tem dados no AppData.
    if _tem_dados_app(base):
        return
    exe_dir = os.path.dirname(os.path.abspath(sys.executable))
    for origem in _origens_migracao(exe_dir, base):
        migrou = False
        for nome in ("contas.json", "navegadores", "contas", "backups"):
            orig = os.path.join(origem, nome)
            if not os.path.exists(orig):
                continue
            dest = os.path.join(base, nome)
            try:
                if os.path.isdir(orig):
                    shutil.copytree(orig, dest, dirs_exist_ok=True)
                else:
                    shutil.copy2(orig, dest)
                migrou = True
            except Exception:
                pass
        if migrou:
            break


def _base_dir():
    # Dados SEMPRE em %LOCALAPPDATA%\Contas TikTok, nao ao lado do .exe. Assim a
    # pessoa pode rodar o .exe de QUALQUER lugar (Downloads, Desktop) sem criar
    # pasta e sem sujar a area de trabalho.
    if not getattr(sys, "frozen", False):
        # rodando como script (dev) -> pasta do script
        return os.path.dirname(os.path.abspath(__file__))
    import shutil
    base = os.path.join(os.environ.get("LOCALAPPDATA")
                        or os.path.expanduser("~"), "Contas TikTok")
    try:
        os.makedirs(base, exist_ok=True)
    except Exception:
        pass
    _migrar_dados_antigos(base)
    return base


BASE = _base_dir()
CACHE = os.path.join(BASE, "_cache_app.py")   # ultima versao baixada (fallback)


def _baixar():
    tentativas = [
        # 1) API do GitHub (sempre fresca) — Accept raw devolve o arquivo cru
        (API_URL, {"Accept": "application/vnd.github.raw",
                   "User-Agent": "ContasTikTok-Launcher",
                   "Cache-Control": "no-cache"}),
        # 2) reserva: raw + timestamp
        (RAW_URL + "?t=" + str(int(time.time())),
         {"User-Agent": "ContasTikTok-Launcher", "Cache-Control": "no-cache"}),
    ]
    for url, hdr in tentativas:
        try:
            req = urllib.request.Request(url, headers=hdr)
            with urllib.request.urlopen(req, timeout=15) as r:
                txt = r.read().decode("utf-8")
            if txt.strip():
                return txt
        except Exception:
            continue
    raise RuntimeError("download falhou")


def _criar_atalhos(exe):
    # cria "Contas TikTok" na Area de Trabalho e no Menu Iniciar apontando pro exe.
    # usa GetFolderPath (resolve Desktop redirecionado pro OneDrive).
    exe = os.path.abspath(exe)
    wd = os.path.dirname(exe)
    pexe = exe.replace("'", "''")
    pwd = wd.replace("'", "''")
    ps = ("$s=New-Object -ComObject WScript.Shell;"
          "foreach($p in @([Environment]::GetFolderPath('Desktop'),"
          "[Environment]::GetFolderPath('Programs'))){"
          "$l=$s.CreateShortcut((Join-Path $p 'Contas TikTok.lnk'));"
          f"$l.TargetPath='{pexe}';"
          f"$l.WorkingDirectory='{pwd}';"
          f"$l.IconLocation='{pexe},0';"
          "$l.Save()}")
    try:
        subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy",
                        "Bypass", "-Command", ps],
                       creationflags=0x08000000, timeout=25)
    except Exception:
        pass


def _instalar_e_atalho():
    # Copia o .exe pro %LOCALAPPDATA%\Contas TikTok e cria/atualiza os atalhos,
    # pra virar um app de verdade (nao precisa mais achar/guardar o .exe).
    if not getattr(sys, "frozen", False):
        return
    destino = os.path.join(BASE, "Contas TikTok.exe")
    atual = os.path.abspath(sys.executable)
    if os.path.abspath(destino) != atual:
        try:
            shutil.copy2(atual, destino)        # instala/atualiza o exe
        except Exception:
            if not os.path.exists(destino):
                destino = atual                 # fallback: ainda cria atalho pro exe atual
    _criar_atalhos(destino)


def main():
    _instalar_e_atalho()
    codigo = None
    try:
        codigo = _baixar()                      # tenta sempre a versao mais nova
        try:
            with open(CACHE, "w", encoding="utf-8") as f:
                f.write(codigo)
        except Exception:
            pass
    except Exception:
        if os.path.exists(CACHE):               # offline -> usa o cache
            with open(CACHE, encoding="utf-8") as f:
                codigo = f.read()
    if not codigo:
        try:
            import tkinter as tk
            from tkinter import messagebox
            tk.Tk().withdraw()
            messagebox.showerror(
                "Sem internet",
                "Preciso de internet na PRIMEIRA vez pra baixar o app.\n"
                "Conecte a internet e abra de novo.")
        except Exception:
            pass
        return
    # roda o app baixado (o navegador.py). __file__ = CACHE -> a pasta de dados
    # (navegadores/, contas.json) fica ao lado do exe.
    g = {"__name__": "__main__", "__file__": CACHE}
    exec(compile(codigo, CACHE, "exec"), g)


if __name__ == "__main__":
    main()
