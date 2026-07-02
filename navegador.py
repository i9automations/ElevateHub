"""
CONTAS TIKTOK — gerenciador de perfis (estilo Dolphin), UI em HTML/CSS.
Backend: Python PURO (http.server da biblioteca padrao, sem instalar nada).
Frontend: pagina HTML/CSS/JS, aberta numa janela do Chrome em modo APP.
Cada conta = um PERFIL do Chrome. Criar -> Iniciar -> loga 1x -> fica logado.
SEM proxy/anti-deteccao (veja LEIA-ME.txt).
"""

import os
import re
import json
import shutil
import threading
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PASTA = os.path.dirname(os.path.abspath(__file__))
CHROME_UDD = os.path.join(PASTA, "navegadores")      # LEGADO: layout antigo (1 pasta p/ TODAS as contas)
CONTAS_DIR = os.path.join(PASTA, "contas")           # NOVO: cada conta tem a PROPRIA pasta isolada
UI_UDD = os.path.join(PASTA, "_ui_profile")          # perfil da janela do app
BACKUPS_DIR = os.path.join(PASTA, "backups")         # zips de backup das contas
# Chrome TRAVADO (Chrome for Testing) embutido no app, se existir. Ele NAO se
# atualiza sozinho -> nao re-encripta os cookies -> nao desloga as contas.
CHROME_FIXO = os.path.join(PASTA, "chrome", "chrome.exe")
REG = os.path.join(PASTA, "contas.json")
LOGIN_URL = "https://seller-br.tiktok.com/account/login"


def _chrome_sistema():
    """Chrome do Google instalado (usado SO pra janela do app; se atualiza)."""
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


def achar_chrome():
    # navegador da JANELA do app (nao guarda login de conta) — tanto faz qual.
    if os.path.exists(CHROME_FIXO):
        return CHROME_FIXO
    return _chrome_sistema()


CHROME = achar_chrome()

# contas abertas agora: nome -> processo do navegador (pra saber quais estao 'aberta')
_abertos = {}


def _slug(nome):
    return re.sub(r'[\\/:*?"<>|]', "", nome).strip() or "conta"


def carregar():
    """Devolve lista de {nome, tags}. Migra o formato antigo (lista de nomes)."""
    try:
        with open(REG, encoding="utf-8") as f:
            dados = json.load(f).get("contas", [])
    except Exception:
        return []
    out = []
    for c in dados:
        if isinstance(c, str):
            out.append({"nome": c, "tags": []})
        elif isinstance(c, dict) and c.get("nome"):
            out.append({"nome": c["nome"], "tags": list(c.get("tags") or [])})
    return out


def salvar(contas):
    try:
        with open(REG, "w", encoding="utf-8") as f:
            json.dump({"contas": contas}, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def _idx(contas, nome):
    for k, c in enumerate(contas):
        if c["nome"] == nome:
            return k
    return -1


def _todas_tags(contas):
    t = []
    for c in contas:
        for tg in c.get("tags", []):
            if tg not in t:
                t.append(tg)
    return sorted(t)


def _perfil_dir(nome):
    """Pasta ISOLADA da conta (cada conta = 1 user-data-dir proprio = 1 chave
    de cripto propria). Assim, se algo quebrar, cai SO essa conta, nunca todas."""
    return os.path.join(CONTAS_DIR, _slug(nome))


def _copia_tolerante(src, dst):
    """Copia uma arvore de arquivos pulando os que estiverem travados (ex: Chrome
    aberto) em vez de abortar tudo."""
    os.makedirs(dst, exist_ok=True)
    for raiz, _dirs, arqs in os.walk(src):
        rel = os.path.relpath(raiz, src)
        alvo = dst if rel == "." else os.path.join(dst, rel)
        os.makedirs(alvo, exist_ok=True)
        for a in arqs:
            try:
                shutil.copy2(os.path.join(raiz, a), os.path.join(alvo, a))
            except Exception:
                pass


def _migrar_se_preciso(nome):
    """Migra do layout ANTIGO (navegadores/<slug> = sub-perfil que dividia UMA
    chave com todas as contas) para o NOVO (contas/<slug> = pasta isolada).
    NAO destrutivo: copia e DEIXA o antigo intacto como backup."""
    novo = _perfil_dir(nome)
    if os.path.exists(novo):
        return                       # ja migrado/criado
    antigo = os.path.join(CHROME_UDD, _slug(nome))
    if not os.path.isdir(antigo):
        return                       # conta nova -> nada a migrar
    # o sub-perfil antigo vira o "Default" do novo user-data-dir isolado
    _copia_tolerante(antigo, os.path.join(novo, "Default"))
    # a CHAVE de cripto morava no Local State compartilhado -> leva junto,
    # senao os cookies (encriptados com ela) nao abrem na pasta nova.
    ls = os.path.join(CHROME_UDD, "Local State")
    if os.path.exists(ls):
        try:
            shutil.copy2(ls, os.path.join(novo, "Local State"))
        except Exception:
            pass


# paleta de cores por cliente (mesma vibe da UI) — diferencia as janelas
_PALETA = [0xA78BFA, 0x34D399, 0x60A5FA, 0xFBBF24, 0xFB7185,
           0x22D3EE, 0xF472B6, 0x4ADE80, 0x818CF8, 0xF0883E]


def _marcar_perfil(nome):
    """Identidade visual da conta (estilo Dolphin): nome do cliente + cor + avatar
    proprios, pra diferenciar as janelas na barra de tarefas. Mescla no
    Preferences (nao apaga login — cookies ficam em arquivo separado)."""
    prefs_path = os.path.join(_perfil_dir(nome), "Default", "Preferences")
    try:
        with open(prefs_path, encoding="utf-8") as f:
            p = json.load(f)
    except Exception:
        p = {}
    h = sum(ord(c) for c in nome)
    rgb = _PALETA[h % len(_PALETA)]
    prof = p.setdefault("profile", {})
    prof["name"] = nome
    prof["avatar_index"] = h % 56
    prof["using_default_avatar"] = False
    prof["using_default_name"] = False
    theme = p.setdefault("browser", {}).setdefault("theme", {})
    theme["user_color"] = (0xFF << 24) | rgb          # cor do tema (ARGB)
    theme["is_grayscale"] = False
    try:
        os.makedirs(os.path.dirname(prefs_path), exist_ok=True)
        with open(prefs_path, "w", encoding="utf-8") as f:
            json.dump(p, f)
    except Exception:
        pass


def semear(nome):
    _migrar_se_preciso(nome)
    os.makedirs(os.path.join(_perfil_dir(nome), "Default"), exist_ok=True)
    _marcar_perfil(nome)          # nome + cor + avatar do cliente


def abrir_perfil(nome):
    semear(nome)
    # DOLPHIN: as contas SEMPRE abrem no navegador PROPRIO (que NAO se atualiza).
    # E isso que impede de deslogar. So cai no Chrome do sistema se ainda nao
    # deu pra ter o proprio (ex: sem internet) — e a UI avisa.
    if os.path.exists(CHROME_FIXO):
        exe = CHROME_FIXO
    elif _chrome_status.get("baixando"):
        return "preparando"          # navegador proprio ainda baixando
    else:
        exe = _chrome_sistema()
        if not exe:
            return "sem_navegador"
    _abertos[nome] = subprocess.Popen([
        exe,
        f"--user-data-dir={_perfil_dir(nome)}",   # pasta ISOLADA (chave propria)
        "--no-first-run", "--no-default-browser-check",
        # esconde os avisos amarelos (automacao / "Chrome for Testing") pra
        # ninguem clicar por engano em "Baixe o Chrome".
        "--test-type", "--disable-infobars",
        LOGIN_URL,
    ])
    return "ok" if exe == CHROME_FIXO else "ok_sistema"


# cookies de SESSAO do TikTok Seller (presenca = logado; validade = nao expirou)
_COOKIES_SELLER = ("sessionid_tiktokseller", "sid_guard_tiktokseller",
                   "sessionid_ss_tiktokseller", "sid_tt_tiktokseller")


def _status_conta(nome):
    """aberta (rodando agora) / logada / expirada / deslogada — lido do disco."""
    proc = _abertos.get(nome)
    if proc is not None and proc.poll() is None:
        return "aberta"
    src = os.path.join(_perfil_dir(nome), "Default", "Network", "Cookies")
    if not os.path.exists(src):
        alt = os.path.join(_perfil_dir(nome), "Default", "Cookies")
        src = alt if os.path.exists(alt) else src
    if not os.path.exists(src):
        return "deslogada"
    import sqlite3
    import datetime
    import tempfile
    fd, tmp = tempfile.mkstemp(suffix="_ck.db")
    os.close(fd)
    try:
        shutil.copy2(src, tmp)          # copia (o original pode estar em uso)
        db = sqlite3.connect(tmp)
        marcas = ",".join("'%s'" % n for n in _COOKIES_SELLER)
        rows = db.execute(
            "select expires_utc from cookies where name in (%s)" % marcas
        ).fetchall()
        db.close()
    except Exception:
        return "?"
    finally:
        try:
            os.remove(tmp)
        except Exception:
            pass
    if not rows:
        return "deslogada"
    epoca = datetime.datetime(1601, 1, 1, tzinfo=datetime.timezone.utc)
    agora = (datetime.datetime.now(datetime.timezone.utc)
             - epoca).total_seconds() * 1_000_000
    validos = [e for (e,) in rows if e == 0 or e > agora]
    return "logada" if validos else "expirada"


# pastas de cache que NAO precisam ir pro backup (so incham o zip)
_SKIP_CACHE = {"Cache", "Code Cache", "GPUCache", "ShaderCache", "GrShaderCache",
               "DawnGraphiteCache", "DawnWebGPUCache", "component_crx_cache",
               "extensions_crx_cache", "Crashpad"}


def fazer_backup():
    """Zipa TODAS as contas (contas/) + contas.json num arquivo datado em backups/."""
    import datetime
    import zipfile
    os.makedirs(BACKUPS_DIR, exist_ok=True)
    carimbo = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    destino = os.path.join(BACKUPS_DIR, f"backup_{carimbo}.zip")
    try:
        with zipfile.ZipFile(destino, "w", zipfile.ZIP_DEFLATED) as z:
            if os.path.exists(REG):
                z.write(REG, "contas.json")
            for raiz, dirs, arqs in os.walk(CONTAS_DIR):
                dirs[:] = [d for d in dirs if d not in _SKIP_CACHE]
                for a in arqs:
                    fp = os.path.join(raiz, a)
                    try:
                        z.write(fp, os.path.relpath(fp, PASTA))
                    except Exception:
                        pass            # arquivo travado -> pula
        return {"ok": True, "arquivo": os.path.basename(destino)}
    except Exception as e:
        return {"ok": False, "erro": str(e)}


def restaurar_ultimo():
    """Restaura o backup mais recente (precisa fechar os navegadores antes)."""
    import zipfile
    try:
        zips = sorted(f for f in os.listdir(BACKUPS_DIR)
                      if f.endswith(".zip")) if os.path.isdir(BACKUPS_DIR) else []
        if not zips:
            return {"ok": False, "erro": "Nenhum backup encontrado."}
        with zipfile.ZipFile(os.path.join(BACKUPS_DIR, zips[-1])) as z:
            z.extractall(PASTA)
        return {"ok": True, "arquivo": zips[-1]}
    except Exception as e:
        return {"ok": False, "erro": str(e)}


def importar_antigas():
    """Acha os perfis logados na PASTA ANTIGA (navegadores/) do mesmo PC e importa
    pro layout novo, preservando o login (mesma maquina). Traz de volta ate contas
    que sumiram da lista mas ainda estao no disco."""
    if not os.path.isdir(CHROME_UDD):
        return {"ok": True, "importadas": 0, "logadas": 0}
    contas = carregar()
    tem = {_slug(c["nome"]) for c in contas}
    novas, logadas = 0, 0
    for d in sorted(os.listdir(CHROME_UDD)):
        pdir = os.path.join(CHROME_UDD, d)
        # e um PERFIL de verdade? (tem Preferences). Descarta pastas de
        # componente do Chrome (GPUCache, BrowserMetrics, etc.).
        if not os.path.isdir(pdir) or not os.path.exists(
                os.path.join(pdir, "Preferences")):
            continue
        nome = d
        try:
            with open(os.path.join(pdir, "Preferences"), encoding="utf-8") as f:
                nm = (json.load(f).get("profile") or {}).get("name")
            if nm and _slug(nm) == d:
                nome = nm
        except Exception:
            pass
        _migrar_se_preciso(nome)          # copia p/ contas/<slug> com a chave
        _marcar_perfil(nome)              # nome + cor + avatar
        if _status_conta(nome) in ("logada", "aberta"):
            logadas += 1
        if _slug(nome) not in tem:
            contas.append({"nome": nome, "tags": []})
            tem.add(_slug(nome))
            novas += 1
    salvar(contas)
    return {"ok": True, "importadas": novas, "logadas": logadas}


# estado do download do navegador proprio (consultado pela UI)
_chrome_status = {"baixando": False, "msg": "", "ok": None, "pct": 0}


def baixar_chrome_travado():
    """Baixa o Chrome for Testing (nao se atualiza) pra PASTA/chrome/."""
    import urllib.request
    import zipfile
    import io
    if os.path.exists(CHROME_FIXO):
        _chrome_status.update(baixando=False, ok=True, pct=100)
        return
    _chrome_status.update(baixando=True, ok=None, pct=0,
                          msg="Preparando o navegador...")
    try:
        idx = ("https://googlechromelabs.github.io/chrome-for-testing/"
               "last-known-good-versions-with-downloads.json")
        with urllib.request.urlopen(idx, timeout=30) as r:
            data = json.loads(r.read().decode("utf-8"))
        dls = data["channels"]["Stable"]["downloads"]["chrome"]
        url = next(d["url"] for d in dls if d["platform"] == "win64")
        with urllib.request.urlopen(url, timeout=600) as r:
            total = int(r.headers.get("Content-Length", 0) or 0)
            lido = 0
            partes = []
            while True:
                pedaco = r.read(262144)
                if not pedaco:
                    break
                partes.append(pedaco)
                lido += len(pedaco)
                pct = int(lido * 100 / total) if total else 0
                _chrome_status.update(pct=pct, msg=f"Baixando: {pct}%")
        buf = io.BytesIO(b"".join(partes))
        _chrome_status.update(msg="Instalando...", pct=100)
        tmp = os.path.join(PASTA, "_chrome_tmp")
        shutil.rmtree(tmp, ignore_errors=True)
        with zipfile.ZipFile(buf) as z:
            z.extractall(tmp)
        # o zip vem como chrome-win64/chrome.exe -> acha e move pra PASTA/chrome
        origem = None
        for raiz, _d, arqs in os.walk(tmp):
            if "chrome.exe" in arqs:
                origem = raiz
                break
        if not origem:
            raise RuntimeError("chrome.exe nao encontrado no download")
        destino = os.path.join(PASTA, "chrome")
        shutil.rmtree(destino, ignore_errors=True)
        shutil.move(origem, destino)
        shutil.rmtree(tmp, ignore_errors=True)
        _chrome_status.update(baixando=False, ok=True, pct=100,
                              msg="Navegador pronto!")
    except Exception as e:
        _chrome_status.update(baixando=False, ok=False,
                              msg="Falhou: " + str(e))


HTML = r"""<!doctype html>
<html lang="pt-br"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Contas TikTok</title><link rel="icon" type="image/png" href="data:image/png;base64,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">
<style>
:root{
  --bg:#0c0f14; --side:#080a0e; --card:#151a21; --card2:#1b222b; --chip:#1e252f;
  --fg:#f0f3f7; --muted:#8b95a3; --line:rgba(255,255,255,.07);
  --pk:#fe2c55; --pkd:#e01f46; --cy:#25f4ee; --cyd:#16dcd6;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{font-family:'Segoe UI Variable Text','Segoe UI',system-ui,-apple-system,sans-serif;
  color:var(--fg);display:flex;overflow:hidden;background:var(--bg)}
::-webkit-scrollbar{width:11px}
::-webkit-scrollbar-thumb{background:#252e3a;border-radius:9px;border:3px solid transparent;background-clip:padding-box}
::-webkit-scrollbar-thumb:hover{background:#333d4b;background-clip:padding-box}
::-webkit-scrollbar-track{background:transparent}

.side{width:238px;height:100vh;flex-shrink:0;padding:24px 16px;display:flex;
  flex-direction:column;background:var(--side);border-right:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:11px;margin-bottom:28px;padding:0 6px}
.logo{width:42px;height:42px;border-radius:50%;overflow:hidden;background:#000;flex-shrink:0}
.logo img{width:100%;height:100%;object-fit:cover;transform:scale(1.06);display:block}
.brand h1{font-size:16px;font-weight:700;letter-spacing:.2px}
.btn-criar{width:100%;border:0;border-radius:10px;cursor:pointer;color:#fff;
  background:var(--pk);font-weight:700;font-size:14px;padding:13px;transition:.13s}
.btn-criar:hover{background:var(--pkd)}
.navit{display:flex;align-items:center;gap:10px;padding:11px 14px;margin-top:20px;
  border-radius:10px;font-weight:600;font-size:13px;color:var(--muted);cursor:pointer;transition:.12s}
.navit:hover{background:rgba(255,255,255,.04);color:var(--fg)}
.navit.on{background:rgba(254,44,85,.12);color:#fff}
.tagnav{display:flex;flex-direction:column;gap:2px;margin-top:4px;overflow-y:auto}
.tagit{display:flex;align-items:center;gap:9px;padding:9px 14px;border-radius:9px;
  font-size:12.5px;color:var(--muted);cursor:pointer;transition:.12s}
.tagit:hover{background:rgba(255,255,255,.04);color:var(--fg)}
.tagit.on{background:rgba(254,44,85,.12);color:#fff}
.tagit .dt{width:7px;height:7px;border-radius:50%;background:var(--cy);flex-shrink:0}
.count{color:var(--muted);font-size:12px;margin-top:14px;padding-left:8px}
.foot{margin-top:auto;color:#5a6573;font-size:11px;letter-spacing:.3px;padding:0 8px;font-weight:600}

.main{flex:1;height:100vh;display:flex;flex-direction:column;overflow:hidden}
.top{display:flex;align-items:center;gap:14px;padding:26px 30px 14px}
.top h2{font-size:23px;font-weight:800;flex:1;letter-spacing:-.3px}
.search{border:1px solid var(--line);border-radius:10px;color:var(--fg);
  padding:11px 14px 11px 38px;width:248px;font-size:13px;outline:none;transition:.13s;
  background:var(--card) url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" stroke="%238b95a3" stroke-width="2" stroke-linecap="round"><circle cx="7" cy="7" r="5.2"/><path d="M15 15l-4-4"/></svg>') no-repeat 13px center}
.search::placeholder{color:var(--muted)}
.search:focus{border-color:#39434f}
.thead{display:flex;justify-content:space-between;color:var(--muted);font-size:11px;
  font-weight:700;letter-spacing:1px;padding:8px 34px;border-bottom:1px solid var(--line)}
.list{flex:1;overflow-y:auto;padding:16px 26px 26px}

.card{display:flex;align-items:center;gap:15px;border-radius:14px;padding:13px 18px;
  margin-bottom:10px;border:1px solid var(--line);background:var(--card);transition:.13s}
.card:hover{background:var(--card2);border-color:rgba(255,255,255,.13)}
.ava{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;
  font-weight:800;color:#08130f;font-size:18px;flex-shrink:0}
.nome{font-size:15px;font-weight:700;flex:1;letter-spacing:.1px}
.tag{background:rgba(37,244,238,.10);color:var(--cy);font-size:11px;font-weight:700;
  padding:5px 11px;border-radius:7px;border:1px solid rgba(37,244,238,.18)}
.start{border:0;border-radius:9px;cursor:pointer;color:#04211f;font-weight:800;
  font-size:13px;padding:11px 20px;transition:.13s;display:flex;align-items:center;gap:8px;
  background:var(--cy)}
.start:hover{background:var(--cyd)}
.del{background:none;border:0;color:var(--muted);cursor:pointer;display:grid;
  place-items:center;width:38px;height:38px;border-radius:9px;transition:.13s}
.del:hover{color:var(--pk);background:rgba(254,44,85,.12)}
.edit{background:none;border:0;color:var(--muted);cursor:pointer;display:grid;
  place-items:center;width:36px;height:36px;border-radius:9px;transition:.13s}
.edit:hover{color:var(--cy);background:rgba(37,244,238,.10)}
.cardtags{display:flex;gap:5px;flex-wrap:wrap;margin-top:5px}
.t2{background:var(--chip);color:#9fb3c9;font-size:10.5px;font-weight:700;
  padding:3px 9px;border-radius:20px;border:1px solid var(--line)}
.modal label{display:block;font-size:12px;color:var(--muted);margin:14px 0 6px;font-weight:600}

.vazio{text-align:center;color:var(--muted);margin-top:90px}
.vazio .ic{opacity:.5}
.vazio h3{color:var(--fg);font-size:18px;margin:14px 0 4px;font-weight:700}

.ov{position:fixed;inset:0;background:rgba(5,7,10,.62);backdrop-filter:blur(3px);
  display:none;place-items:center;z-index:9}
.ov.on{display:grid}
.modal{background:var(--card2);border-radius:16px;padding:26px;width:400px;
  border:1px solid var(--line);box-shadow:0 20px 50px rgba(0,0,0,.55)}
.modal h3{font-size:18px;margin-bottom:6px;font-weight:700}
.modal p{color:var(--muted);font-size:13px;margin-bottom:16px}
.modal input{width:100%;background:#0a0d12;border:1px solid var(--line);border-radius:10px;
  color:var(--fg);padding:13px;font-size:14px;outline:none;transition:.13s}
.modal input:focus{border-color:#39434f}
.macts{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
.bsec{background:var(--chip);color:var(--fg);border:0;border-radius:9px;
  padding:11px 18px;font-weight:600;cursor:pointer;transition:.13s}
.bsec:hover{background:#2a323d}
.bok{background:var(--pk);color:#fff;border:0;border-radius:9px;
  padding:11px 20px;font-weight:700;cursor:pointer;transition:.13s}
.bok:hover{background:var(--pkd)}
.tools{margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,.08);
  display:flex;flex-direction:column;gap:6px}
.btool{width:100%;text-align:left;background:transparent;color:#aeb2bd;
  border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:9px 11px;
  font-size:12.5px;cursor:pointer;transition:.13s}
.btool:hover{background:rgba(255,255,255,.05);color:#fff}
.tstatus{font-size:11.5px;color:#8a8f99;min-height:14px;padding:2px 2px 0}
.stbadge{display:inline-flex;align-items:center;gap:5px;font-size:11px;
  color:var(--muted);margin-top:3px;font-weight:600}
.stbadge::before{content:"";width:8px;height:8px;border-radius:50%;
  background:#5a6472;flex:none}
.stbadge.aberta{color:#22d3ee}.stbadge.aberta::before{background:#22d3ee;
  box-shadow:0 0 0 3px rgba(34,211,238,.18)}
.stbadge.logada{color:#34d399}.stbadge.logada::before{background:#34d399}
.stbadge.expirada{color:#fbbf24}.stbadge.expirada::before{background:#fbbf24}
.stbadge.deslogada{color:#8b95a3}
</style></head>
<body>
  <aside class="side">
    <div class="brand">
      <div class="logo"><img src="data:image/png;base64,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" alt=""></div>
      <h1>Contas TikTok</h1>
    </div>
    <button class="btn-criar" onclick="novo()">+ &nbsp;Criar perfil</button>
    <div class="navit on" id="navtodos" onclick="filtrar('')">Todos os perfis</div>
    <div class="tagnav" id="tagnav"></div>
    <div class="count" id="count">0 perfis</div>
    <div class="tools">
      <button class="btool" onclick="importar()">Importar contas antigas</button>
      <button class="btool" onclick="backup()">Backup das contas</button>
      <button class="btool" onclick="restaurar()">Restaurar último backup</button>
      <div class="tstatus" id="tstatus"></div>
    </div>
    <div class="foot">By Avant IA</div>
  </aside>

  <main class="main">
    <div class="top">
      <h2>Todos os perfis</h2>
      <input class="search" id="busca" placeholder="Buscar perfil..."
             oninput="render()">
    </div>
    <div id="prep" style="display:none;margin:0 0 12px;padding:11px 15px;border:1px solid var(--cy);border-radius:10px;background:rgba(37,244,238,.07);color:var(--fg);font-size:13px"></div>
    <div class="thead"><span>PERFIL</span><span>AÇÕES</span></div>
    <div class="list" id="list"></div>
  </main>

  <div class="ov" id="ov">
    <div class="modal">
      <h3 id="mtit">Novo perfil</h3>
      <label>Nome do cliente</label>
      <input id="mNome" autocomplete="off" placeholder="ex: Loja da Ana">
      <label>Tags / pastas (separe por vírgula)</label>
      <input id="mTags" autocomplete="off" placeholder="ex: Consultoria, Moda">
      <div class="macts">
        <button class="bsec" onclick="fecharModal()">Cancelar</button>
        <button class="bok" id="mok">Salvar</button>
      </div>
    </div>
  </div>

  <div class="ov" id="ov2">
    <div class="modal">
      <h3 id="d2tit"></h3>
      <p id="d2msg" style="margin-bottom:0"></p>
      <div class="macts">
        <button class="bsec" id="d2cancel" onclick="d2fechar()">Cancelar</button>
        <button class="bok" id="d2ok">OK</button>
      </div>
    </div>
  </div>

<script>
const CORES=["#a78bfa","#34d399","#60a5fa","#fbbf24","#fb7185","#22d3ee","#f472b6","#4ade80","#818cf8","#f0883e"];
let CONTAS=[], ALLTAGS=[], FILTRO='';
const $=id=>document.getElementById(id);
function esc(s){return(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function api(p,body){const o={method:body?'POST':'GET'};if(body){o.headers={'Content-Type':'application/json'};o.body=JSON.stringify(body)}const r=await fetch(p,o);try{return await r.json()}catch(e){return{}}}
async function load(){const d=await api('/api/list');CONTAS=d.contas||[];ALLTAGS=d.tags||[];render();}
function importar(){dlgConfirma('Procurar contas já logadas na versão antiga do app (neste PC) e importar? O login é mantido. FECHE os navegadores abertos antes.',async()=>{$('tstatus').textContent='Importando...';const r=await api('/api/importar',{});if(r.ok){$('tstatus').textContent=r.importadas+' importada(s), '+r.logadas+' já logada(s).';load();}else{$('tstatus').textContent='Falhou: '+(r.erro||'');}},'Importar contas antigas','Importar');}
async function backup(){$('tstatus').textContent='Fazendo backup...';const r=await api('/api/backup',{});$('tstatus').textContent=r.ok?('Backup salvo: '+r.arquivo):('Falhou: '+(r.erro||''));}
function restaurar(){dlgConfirma('Restaurar o último backup? FECHE todos os navegadores antes. Isso sobrescreve as contas atuais.',async()=>{$('tstatus').textContent='Restaurando...';const r=await api('/api/restaurar',{});$('tstatus').textContent=r.ok?('Restaurado: '+r.arquivo):('Falhou: '+(r.erro||''));if(r.ok)load();},'Restaurar backup','Restaurar');}
async function pollPrep(){try{const s=await api('/api/chrome_status');const p=$('prep');
  if(s.pronto){p.style.display='none';}
  else if(s.baixando){p.style.display='block';p.textContent='Preparando o navegador próprio (só na primeira vez) — '+(s.msg||'...')+'. As contas abrem sozinhas assim que terminar.';}
  else if(s.ok===false){p.style.display='block';p.textContent='Não consegui baixar o navegador próprio ('+(s.msg||'')+'). Por enquanto as contas abrem no Chrome do sistema. Verifique a internet.';}
  else{p.style.display='block';p.textContent='Preparando o navegador próprio (só na primeira vez)...';}
}catch(e){}setTimeout(pollPrep,1500);}
let STATUS={};
const _STXT={aberta:'aberta agora',logada:'logada',expirada:'sessão expirada',deslogada:'não logada','?':''};
async function pollStatus(){try{const d=await api('/api/status');STATUS=d.status||{};pintarStatus();}catch(e){}setTimeout(pollStatus,5000);}
function pintarStatus(){CONTAS.forEach((c,i)=>{const el=$('st'+i);if(!el)return;const s=STATUS[c.nome]||'';el.className='stbadge '+s;el.textContent=_STXT[s]||'';});}
function setFiltro(t){FILTRO=(FILTRO===t?'':t);render();}
function setFiltroIdx(i){setFiltro(ALLTAGS[i]);}
function render(){
  $('navtodos').classList.toggle('on',FILTRO==='');
  $('tagnav').innerHTML=ALLTAGS.map((t,i)=>`<div class="tagit ${FILTRO===t?'on':''}" onclick="setFiltroIdx(${i})"><span class="dt"></span>${esc(t)}</div>`).join('');
  const f=($('busca').value||'').toLowerCase();
  let vis=CONTAS.filter(c=>c.nome.toLowerCase().includes(f));
  if(FILTRO)vis=vis.filter(c=>(c.tags||[]).includes(FILTRO));
  $('count').textContent=CONTAS.length+' perfis';
  const L=$('list');
  if(!CONTAS.length){L.innerHTML=`<div class="vazio"><div class="ic"><svg width="58" height="58" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></div><h3>Nenhum perfil ainda</h3><div>Clique em "+ Criar perfil".</div></div>`;return;}
  if(!vis.length){L.innerHTML=`<div class="vazio"><h3>Nada encontrado</h3></div>`;return;}
  L.innerHTML=vis.map((c,vi)=>{
    const i=CONTAS.indexOf(c),cor=CORES[i%CORES.length],ini=(c.nome.trim()[0]||'?').toUpperCase();
    const chips=(c.tags||[]).map(t=>`<span class="t2">${esc(t)}</span>`).join('');
    return `<div class="card" style="animation-delay:${(vi%14)*45}ms">
      <div class="ava" style="background:linear-gradient(135deg,${cor},color-mix(in srgb,${cor},#000 38%))">${ini}</div>
      <div style="flex:1;min-width:0"><div class="nome">${esc(c.nome)}</div><span class="stbadge" id="st${i}"></span>${chips?`<div class="cardtags">${chips}</div>`:''}</div>
      <button class="edit" title="Editar / renomear" onclick="editar(${i})"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>
      <button class="start" onclick="abrir(${i})"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>START</button>
      <button class="del" title="Remover" onclick="remover(${i})"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg></button>
    </div>`;}).join('');
  pintarStatus();
}
async function abrir(i){const r=await api('/api/open',{nome:CONTAS[i].nome});
  if(r.status==='preparando'){dlgAviso('O navegador próprio ainda está baixando (só na primeira vez). Espere a barra azul terminar e clique de novo.');}
  else if(r.status==='sem_navegador'){dlgAviso('Não achei um navegador pra abrir. Conecte a internet (pra baixar o navegador próprio) ou instale o Google Chrome.');}}
function remover(i){const n=CONTAS[i].nome;dlgConfirma("Remover '"+n+"'? Isso apaga o login salvo dele (vai precisar logar de novo).",()=>api('/api/delete',{nome:n}).then(load),'Remover perfil','Remover');}
function novo(){abrirModal('Novo perfil','',[],async(nome,tags)=>{const r=await api('/api/create',{nome,tags});if(r.erro){dlgAviso(r.erro);return;}load();});}
function editar(i){const c=CONTAS[i];abrirModal('Editar perfil',c.nome,c.tags||[],async(nome,tags)=>{if(nome!==c.nome){const r=await api('/api/rename',{nome:c.nome,novo:nome});if(r.erro){dlgAviso(r.erro);return;}}await api('/api/tags',{nome,tags});load();});}
let _cb=null;
function abrirModal(tit,nome,tags,cb){$('mtit').textContent=tit;$('mNome').value=nome||'';$('mTags').value=(tags||[]).join(', ');$('ov').classList.add('on');_cb=cb;setTimeout(()=>$('mNome').focus(),50);}
function fecharModal(){$('ov').classList.remove('on');_cb=null;}
function salvarModal(){const nome=$('mNome').value.trim();const tags=$('mTags').value.split(',').map(s=>s.trim()).filter(Boolean);if(!nome)return;const cb=_cb;fecharModal();if(cb)cb(nome,tags);}
$('mok').onclick=salvarModal;
['mNome','mTags'].forEach(id=>$(id).addEventListener('keydown',e=>{if(e.key==='Enter')salvarModal();}));
let _d2cb=null;
function dlg(tit,msg,okTxt,cb){$('d2tit').textContent=tit;$('d2msg').textContent=msg;$('d2ok').textContent=okTxt||'OK';$('d2cancel').style.display=cb?'':'none';$('ov2').classList.add('on');_d2cb=cb||null;}
function d2fechar(){$('ov2').classList.remove('on');_d2cb=null;}
$('d2ok').onclick=()=>{const cb=_d2cb;d2fechar();if(cb)cb();};
function dlgAviso(msg,tit){dlg(tit||'Aviso',msg,'OK',null);}
function dlgConfirma(msg,cb,tit,ok){dlg(tit||'Confirmar',msg,ok||'Sim',cb);}
document.addEventListener('keydown',e=>{if(e.key==='Escape'){fecharModal();d2fechar();}else if(e.key==='Enter'&&$('ov2').classList.contains('on'))$('d2ok').click();});
load();
pollPrep();
pollStatus();
</script>
</body></html>"""


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        data = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/" or self.path.startswith("/index"):
            self._send(200, HTML, "text/html")
        elif self.path == "/api/list":
            contas = carregar()
            self._send(200, json.dumps(
                {"contas": contas, "tags": _todas_tags(contas),
                 "chrome_travado": os.path.exists(CHROME_FIXO)}))
        elif self.path == "/api/chrome_status":
            self._send(200, json.dumps(
                {**_chrome_status, "pronto": os.path.exists(CHROME_FIXO)}))
        elif self.path == "/api/status":
            st = {c["nome"]: _status_conta(c["nome"]) for c in carregar()}
            self._send(200, json.dumps({"status": st}))
        else:
            self._send(404, "{}")

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        try:
            dados = json.loads(self.rfile.read(n) or "{}")
        except Exception:
            dados = {}
        nome = (dados.get("nome") or "").strip()
        tags = [t.strip() for t in (dados.get("tags") or []) if t.strip()]
        contas = carregar()
        if self.path == "/api/create":
            if not nome:
                return self._send(200, json.dumps({"erro": "Nome vazio"}))
            if _idx(contas, nome) >= 0:
                return self._send(200, json.dumps(
                    {"erro": "Ja existe um perfil com esse nome."}))
            contas.append({"nome": nome, "tags": tags})
            salvar(contas)
            semear(nome)
            self._send(200, json.dumps({"ok": True}))
        elif self.path == "/api/open":
            self._send(200, json.dumps({"status": abrir_perfil(nome)}))
        elif self.path == "/api/delete":
            k = _idx(contas, nome)
            if k >= 0:
                contas.pop(k)
                salvar(contas)
            shutil.rmtree(_perfil_dir(nome), ignore_errors=True)          # novo
            shutil.rmtree(os.path.join(CHROME_UDD, _slug(nome)),          # antigo
                          ignore_errors=True)
            self._send(200, json.dumps({"ok": True}))
        elif self.path == "/api/tags":
            k = _idx(contas, nome)
            if k >= 0:
                contas[k]["tags"] = tags
                salvar(contas)
            self._send(200, json.dumps({"ok": True}))
        elif self.path == "/api/rename":
            novo = (dados.get("novo") or "").strip()
            k = _idx(contas, nome)
            if not novo:
                return self._send(200, json.dumps({"erro": "Nome vazio"}))
            if novo != nome and _idx(contas, novo) >= 0:
                return self._send(200, json.dumps(
                    {"erro": "Ja existe um perfil com esse nome."}))
            if k >= 0:
                # migra primeiro (caso ainda esteja no layout antigo), depois
                # renomeia a pasta isolada -> preserva o login.
                _migrar_se_preciso(nome)
                old_d = _perfil_dir(nome)
                new_d = _perfil_dir(novo)
                if (_slug(nome) != _slug(novo) and os.path.isdir(old_d)
                        and not os.path.exists(new_d)):
                    try:
                        os.rename(old_d, new_d)
                    except Exception:
                        pass
                contas[k]["nome"] = novo
                salvar(contas)
            self._send(200, json.dumps({"ok": True}))
        elif self.path == "/api/backup":
            self._send(200, json.dumps(fazer_backup()))
        elif self.path == "/api/restaurar":
            self._send(200, json.dumps(restaurar_ultimo()))
        elif self.path == "/api/importar":
            self._send(200, json.dumps(importar_antigas()))
        elif self.path == "/api/travar_chrome":
            if not _chrome_status["baixando"]:
                threading.Thread(target=baixar_chrome_travado,
                                 daemon=True).start()
            self._send(200, json.dumps({"ok": True}))
        else:
            self._send(404, "{}")


def main():
    os.makedirs(CONTAS_DIR, exist_ok=True)
    # DOLPHIN: na primeira vez, ja baixa o navegador proprio sozinho (em 2o
    # plano). Ninguem precisa clicar em nada; a UI mostra o progresso.
    if not os.path.exists(CHROME_FIXO):
        threading.Thread(target=baixar_chrome_travado, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}/"

    if CHROME:
        proc = subprocess.Popen([
            CHROME, f"--app={url}", f"--user-data-dir={UI_UDD}",
            "--no-first-run", "--no-default-browser-check",
            "--window-size=1120,720",
        ])
        proc.wait()                 # bloqueia ate fechar a janela do app
    else:
        import webbrowser
        webbrowser.open(url)        # sem Chrome: abre no navegador padrao
        try:
            input()
        except Exception:
            threading.Event().wait()
    try:
        server.shutdown()
    except Exception:
        pass


if __name__ == "__main__":
    main()
