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
import base64
import shutil
import threading
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PASTA = os.path.dirname(os.path.abspath(__file__))
CHROME_UDD = os.path.join(PASTA, "navegadores")      # LEGADO: layout antigo (1 pasta p/ TODAS as contas)
CONTAS_DIR = os.path.join(PASTA, "contas")           # NOVO: cada conta tem a PROPRIA pasta isolada
UI_UDD = os.path.join(PASTA, "_ui_profile")          # perfil da janela do app
BACKUPS_DIR = os.path.join(PASTA, "backups")         # zips de backup das contas
HOSTINGER_REG = os.path.join(PASTA, "hostinger.json")
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
    """Devolve lista de contas. Migra o formato antigo (lista de nomes)."""
    try:
        with open(REG, encoding="utf-8") as f:
            dados = json.load(f).get("contas", [])
    except Exception:
        return []
    out = []
    for c in dados:
        if isinstance(c, str):
            out.append({"nome": c, "tags": [], "ultima_abertura": None,
                        "email_alias": "", "email_login": "", "email_senha": ""})
        elif isinstance(c, dict) and c.get("nome"):
            item = dict(c)
            item["nome"] = c["nome"]
            item["tags"] = list(c.get("tags") or [])
            item.setdefault("ultima_abertura", None)
            item.setdefault("email_alias", "")
            item.setdefault("email_login", "")
            item.setdefault("email_senha", "")
            out.append(item)
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


def _contas_publicas(contas):
    out = []
    for c in contas:
        item = dict(c)
        senha = item.pop("email_senha", "")
        item["email_senha_salva"] = bool(senha)
        out.append(item)
    return out


def _dpapi_encrypt(texto):
    if not texto:
        return ""
    try:
        import ctypes
        from ctypes import wintypes

        class DATA_BLOB(ctypes.Structure):
            _fields_ = [("cbData", wintypes.DWORD),
                        ("pbData", ctypes.POINTER(ctypes.c_char))]

        data = texto.encode("utf-8")
        buf = ctypes.create_string_buffer(data)
        entrada = DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
        saida = DATA_BLOB()
        ok = ctypes.windll.crypt32.CryptProtectData(
            ctypes.byref(entrada), None, None, None, None, 0, ctypes.byref(saida))
        if not ok:
            raise ctypes.WinError()
        try:
            enc = ctypes.string_at(saida.pbData, saida.cbData)
        finally:
            ctypes.windll.kernel32.LocalFree(saida.pbData)
        return "dpapi:" + base64.b64encode(enc).decode("ascii")
    except Exception:
        return "b64:" + base64.b64encode(texto.encode("utf-8")).decode("ascii")


def _dpapi_decrypt(valor):
    if not valor:
        return ""
    if valor.startswith("b64:"):
        try:
            return base64.b64decode(valor[4:]).decode("utf-8")
        except Exception:
            return ""
    if not valor.startswith("dpapi:"):
        return valor
    try:
        import ctypes
        from ctypes import wintypes

        class DATA_BLOB(ctypes.Structure):
            _fields_ = [("cbData", wintypes.DWORD),
                        ("pbData", ctypes.POINTER(ctypes.c_char))]

        data = base64.b64decode(valor[6:])
        buf = ctypes.create_string_buffer(data)
        entrada = DATA_BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
        saida = DATA_BLOB()
        ok = ctypes.windll.crypt32.CryptUnprotectData(
            ctypes.byref(entrada), None, None, None, None, 0, ctypes.byref(saida))
        if not ok:
            raise ctypes.WinError()
        try:
            dec = ctypes.string_at(saida.pbData, saida.cbData)
        finally:
            ctypes.windll.kernel32.LocalFree(saida.pbData)
        return dec.decode("utf-8")
    except Exception:
        return ""


def _aplicar_email(conta, dados, manter_senha=True):
    conta["email_alias"] = (dados.get("email_alias") or "").strip().lower()
    conta["email_login"] = (dados.get("email_login") or "").strip().lower()
    senha = dados.get("email_senha")
    if senha:
        conta["email_senha"] = _dpapi_encrypt(str(senha))
    elif not manter_senha:
        conta["email_senha"] = ""


def _normalizar_caixas(valor):
    if isinstance(valor, str):
        partes = re.split(r"[\s,;]+", valor)
    else:
        partes = valor or []
    caixas = []
    for item in partes:
        caixa = str(item or "").strip().lower()
        if caixa and caixa not in caixas:
            caixas.append(caixa)
    return caixas


def salvar_hostinger(conf):
    try:
        with open(HOSTINGER_REG, "w", encoding="utf-8") as f:
            json.dump(conf, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def carregar_hostinger():
    conf = {"imap_host": "imap.hostinger.com", "imap_port": 993,
            "caixas": [], "senha": ""}
    try:
        with open(HOSTINGER_REG, encoding="utf-8") as f:
            dados = json.load(f)
        if isinstance(dados, dict):
            conf.update(dados)
    except Exception:
        pass
    conf["imap_host"] = (conf.get("imap_host") or "imap.hostinger.com").strip()
    try:
        conf["imap_port"] = int(conf.get("imap_port") or 993)
    except Exception:
        conf["imap_port"] = 993
    conf["caixas"] = _normalizar_caixas(conf.get("caixas"))
    senha = str(conf.get("senha") or "")
    if senha and not (senha.startswith("dpapi:") or senha.startswith("b64:")):
        conf["senha"] = _dpapi_encrypt(senha)
        salvar_hostinger(conf)
    else:
        conf["senha"] = senha
    return conf


def _hostinger_publico():
    conf = carregar_hostinger()
    return {"caixas": conf.get("caixas", []),
            "senha_salva": bool(conf.get("senha")),
            "imap_host": conf.get("imap_host") or "imap.hostinger.com",
            "imap_port": conf.get("imap_port") or 993}


def _aplicar_hostinger(dados):
    conf = carregar_hostinger()
    conf["caixas"] = _normalizar_caixas(dados.get("caixas"))
    senha = dados.get("senha")
    if senha:
        conf["senha"] = _dpapi_encrypt(str(senha))
    elif dados.get("limpar_senha"):
        conf["senha"] = ""
    salvar_hostinger(conf)
    return _hostinger_publico()


def _candidatos_email(conta):
    candidatos = []
    vistos = set()

    def add(login, senha):
        login = (login or "").strip().lower()
        if not login or not senha or login in vistos:
            return
        vistos.add(login)
        candidatos.append({"login": login, "senha": senha})

    login_perfil = (conta.get("email_login") or "").strip().lower()
    senha_perfil = _dpapi_decrypt(conta.get("email_senha") or "")
    add(login_perfil, senha_perfil)

    hostinger = carregar_hostinger()
    senha_global = _dpapi_decrypt(hostinger.get("senha") or "")
    if senha_global:
        add(login_perfil, senha_global)
        for caixa in hostinger.get("caixas", []):
            add(caixa, senha_global)
    return candidatos


def _agora_iso():
    import datetime
    return datetime.datetime.now().astimezone().isoformat(timespec="seconds")


def _ultima_abertura(nome):
    contas = carregar()
    k = _idx(contas, nome)
    if k >= 0:
        return contas[k].get("ultima_abertura")
    return None


def _marcar_ultima_abertura(nome):
    contas = carregar()
    k = _idx(contas, nome)
    valor = _agora_iso()
    if k >= 0:
        contas[k]["ultima_abertura"] = valor
        salvar(contas)
    return valor


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
    # JA ABERTO? Nao abre outro. Antes, CADA clique em "Abrir" fazia um novo
    # subprocess.Popen (sem checar nada) -> como o Chrome demora a aparecer, o
    # usuario clicava de novo e acumulava VARIOS Chromes da mesma conta no PC.
    # poll()==None = processo ainda vivo -> so devolve "ja aberto".
    proc = _abertos.get(nome)
    if proc is not None and proc.poll() is None:
        return "ja_aberta"
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
    _marcar_ultima_abertura(nome)
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


def _texto_email(msg):
    partes = []
    if msg.is_multipart():
        for p in msg.walk():
            ctype = p.get_content_type()
            disp = (p.get("Content-Disposition") or "").lower()
            if "attachment" in disp or ctype not in ("text/plain", "text/html"):
                continue
            try:
                txt = p.get_content()
            except Exception:
                payload = p.get_payload(decode=True) or b""
                charset = p.get_content_charset() or "utf-8"
                txt = payload.decode(charset, errors="ignore")
            partes.append(txt)
    else:
        try:
            partes.append(msg.get_content())
        except Exception:
            payload = msg.get_payload(decode=True) or b""
            charset = msg.get_content_charset() or "utf-8"
            partes.append(payload.decode(charset, errors="ignore"))
    texto = "\n".join(partes)
    texto = re.sub(r"<[^>]+>", " ", texto)
    return re.sub(r"\s+", " ", texto).strip()


def _extrair_codigo_tiktok(texto):
    if not texto:
        return None
    # Primeiro tenta achar um codigo perto de palavras de verificacao.
    ctx = re.compile(
        r"(?i)(?:tiktok|c[oó]digo|codigo|code|verification|verifica[cç][aã]o)"
        r".{0,120}?\b(\d{6})\b")
    m = ctx.search(texto)
    if m:
        return m.group(1)
    achados = re.findall(r"\b(\d{6})\b", texto)
    return achados[0] if achados else None


def _parse_corte_iso(valor):
    import datetime

    if not valor:
        return None
    try:
        dt = datetime.datetime.fromisoformat(str(valor).replace("Z", "+00:00"))
        if dt.tzinfo:
            dt = dt.astimezone().replace(tzinfo=None)
        return dt.replace(tzinfo=None)
    except Exception:
        return None


def _internal_dt(internal, imaplib_mod):
    import datetime

    try:
        tup = imaplib_mod.Internaldate2tuple(internal)
        if tup:
            return datetime.datetime(*tup[:6])
    except Exception:
        pass
    return None


def _buscar_codigo_em_caixa(alias, login, senha, corte=None):
    import datetime
    import imaplib
    import email
    from email import policy

    hostinger = carregar_hostinger()
    imap = None
    try:
        imap = imaplib.IMAP4_SSL(hostinger.get("imap_host") or "imap.hostinger.com",
                                 int(hostinger.get("imap_port") or 993),
                                 timeout=12)
        imap.login(login, senha)
        imap.select("INBOX", readonly=True)
        base = corte.date() if corte else (datetime.date.today() - datetime.timedelta(days=2))
        if corte:
            base = base - datetime.timedelta(days=1)
        desde = base.strftime("%d-%b-%Y")
        typ, data = imap.search(None, "SINCE", desde)
        if typ != "OK":
            raise RuntimeError("Nao consegui listar a caixa de entrada.")
        ids = data[0].split()[-120:]
        for mid in reversed(ids):
            typ, raw = imap.fetch(mid, "(INTERNALDATE BODY.PEEK[])")
            if typ != "OK" or not raw:
                continue
            msg_bytes = None
            internal = None
            for item in raw:
                if isinstance(item, tuple):
                    internal = item[0]
                    msg_bytes = item[1]
                    break
            if not msg_bytes:
                continue
            dt = _internal_dt(internal, imaplib)
            if corte:
                if not dt or dt < corte:
                    continue
            msg = email.message_from_bytes(msg_bytes, policy=policy.default)
            headers = " ".join(str(x or "") for x in [
                msg.get("From"), msg.get("To"), msg.get("Cc"), msg.get("Subject"),
                msg.get("Delivered-To"), msg.get("X-Original-To"), msg.get("Envelope-To")])
            corpo = _texto_email(msg)
            pacote = (headers + " " + corpo).lower()
            if alias not in pacote:
                continue
            if "tiktok" not in pacote and "verification" not in pacote and "verifica" not in pacote:
                continue
            codigo = _extrair_codigo_tiktok(headers + " " + corpo)
            if not codigo:
                continue
            return {"ok": True, "codigo": codigo, "alias": alias,
                    "caixa": login, "assunto": str(msg.get("Subject") or ""),
                    "data": dt.isoformat(timespec="seconds") if dt else None}
        return {"ok": False, "erro": "Nenhum codigo recente do TikTok foi encontrado nessa caixa.",
                "caixa": login, "tipo": "vazio"}
    except imaplib.IMAP4.error:
        return {"ok": False, "erro": "Falha no login da caixa Hostinger.",
                "caixa": login, "tipo": "login"}
    except Exception as e:
        return {"ok": False, "erro": str(e), "caixa": login, "tipo": "erro"}
    finally:
        if imap is not None:
            try:
                imap.logout()
            except Exception:
                pass


def buscar_codigo_tiktok(nome, depois_de=None):
    contas = carregar()
    k = _idx(contas, nome)
    if k < 0:
        return {"ok": False, "erro": "Perfil nao encontrado."}
    c = contas[k]
    alias = (c.get("email_alias") or "").strip().lower()
    if not alias:
        return {"ok": False, "erro": "Configure o e-mail/alias do cliente no perfil."}
    candidatos = _candidatos_email(c)
    if not candidatos:
        return {"ok": False, "erro": "Configure a Hostinger no menu lateral ou informe a caixa e senha no perfil."}

    corte = _parse_corte_iso(depois_de)
    falhas_login = []
    falhas_erro = []
    for cand in candidatos:
        r = _buscar_codigo_em_caixa(alias, cand["login"], cand["senha"], corte)
        if r.get("ok"):
            return r
        if r.get("tipo") == "login":
            falhas_login.append(cand["login"])
        elif r.get("tipo") == "erro":
            falhas_erro.append(f"{cand['login']}: {r.get('erro')}")

    if falhas_login and len(falhas_login) == len(candidatos):
        return {"ok": False, "erro": "Falha no login da Hostinger. Confira a senha salva."}
    erro = "Nenhum codigo recente do TikTok foi encontrado para esse alias."
    if falhas_erro:
        erro += " Algumas caixas falharam: " + "; ".join(falhas_erro[:2])
    elif falhas_login:
        erro += " Algumas caixas recusaram a senha: " + ", ".join(falhas_login[:3])
    return {"ok": False, "erro": erro}


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
        return {"ok": True, "encontradas": 0, "importadas": 0, "logadas": 0}
    contas = carregar()
    tem = {_slug(c["nome"]) for c in contas}
    encontradas, novas, logadas = 0, 0, 0
    for d in sorted(os.listdir(CHROME_UDD)):
        pdir = os.path.join(CHROME_UDD, d)
        if not os.path.isdir(pdir):
            continue
        # e um PERFIL? (tem Preferences OU cookies). Descarta pastas de
        # componente do Chrome (GPUCache, BrowserMetrics, etc.).
        eh_perfil = (os.path.exists(os.path.join(pdir, "Preferences"))
                     or os.path.exists(os.path.join(pdir, "Cookies"))
                     or os.path.exists(os.path.join(pdir, "Network", "Cookies")))
        if not eh_perfil:
            continue
        encontradas += 1
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
            contas.append({"nome": nome, "tags": [], "ultima_abertura": None})
            tem.add(_slug(nome))
            novas += 1
    salvar(contas)
    return {"ok": True, "encontradas": encontradas,
            "importadas": novas, "logadas": logadas}


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
  --bg:#0a0c10; --side:#080a0d; --panel:#10151b; --card:#131922; --card2:#18202a; --chip:#202833;
  --fg:#f0f3f7; --muted:#8b95a3; --line:rgba(255,255,255,.07);
  --pk:#fe2c55; --pkd:#e01f46; --cy:#25f4ee; --cyd:#16dcd6;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{font-family:'Segoe UI Variable Text','Segoe UI',system-ui,-apple-system,sans-serif;
  color:var(--fg);display:flex;overflow:hidden;background:var(--bg);letter-spacing:0}
::-webkit-scrollbar{width:11px}
::-webkit-scrollbar-thumb{background:#252e3a;border-radius:9px;border:3px solid transparent;background-clip:padding-box}
::-webkit-scrollbar-thumb:hover{background:#333d4b;background-clip:padding-box}
::-webkit-scrollbar-track{background:transparent}

.side{width:256px;height:100vh;flex-shrink:0;padding:22px 16px;display:flex;
  flex-direction:column;background:var(--side);border-right:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:11px;margin-bottom:22px;padding:0 6px}
.logo{width:40px;height:40px;border-radius:50%;overflow:hidden;background:#000;flex-shrink:0}
.logo img{width:100%;height:100%;object-fit:cover;transform:scale(1.06);display:block}
.brand h1{font-size:16px;font-weight:800;letter-spacing:0;line-height:1.1}
.brand span{display:block;color:var(--muted);font-size:11px;font-weight:600;margin-top:3px}
.btn-criar{width:100%;border:0;border-radius:8px;cursor:pointer;color:#fff;
  background:var(--pk);font-weight:800;font-size:14px;padding:12px;transition:.13s}
.btn-criar:hover{background:var(--pkd)}
.navit{display:flex;align-items:center;gap:10px;padding:10px 12px;margin-top:18px;
  border-radius:8px;font-weight:700;font-size:13px;color:var(--muted);cursor:pointer;transition:.12s}
.navit:hover{background:rgba(255,255,255,.04);color:var(--fg)}
.navit.on{background:rgba(254,44,85,.12);color:#fff}
.tagnav{display:flex;flex-direction:column;gap:2px;margin-top:4px;overflow-y:auto}
.tagit{display:flex;align-items:center;gap:9px;padding:9px 12px;border-radius:8px;
  font-size:12.5px;color:var(--muted);cursor:pointer;transition:.12s}
.tagit:hover{background:rgba(255,255,255,.04);color:var(--fg)}
.tagit.on{background:rgba(254,44,85,.12);color:#fff}
.tagit .dt{width:7px;height:7px;border-radius:50%;background:var(--cy);flex-shrink:0}
.count{color:var(--muted);font-size:12px;margin-top:14px;padding-left:8px;font-weight:600}
.foot{margin-top:auto;color:#5a6573;font-size:11px;letter-spacing:.3px;padding:0 8px;font-weight:600}

.main{flex:1;height:100vh;display:flex;flex-direction:column;overflow:hidden;background:var(--panel)}
.top{display:flex;align-items:center;gap:14px;padding:20px 26px 12px;border-bottom:1px solid var(--line)}
.headcopy{flex:1;min-width:170px}
.top h2{font-size:22px;font-weight:850;letter-spacing:0;line-height:1.15}
.subhead{display:block;color:var(--muted);font-size:12px;margin-top:4px;font-weight:600}
.quickstats{display:flex;align-items:center;gap:8px}
.stat{min-width:78px;border:1px solid var(--line);border-radius:8px;padding:8px 10px;background:#0d1117}
.stat b{display:block;font-size:17px;line-height:1;color:#fff}
.stat span{display:block;font-size:10.5px;color:var(--muted);font-weight:700;margin-top:4px;text-transform:uppercase}
.toolbar{display:flex;align-items:center;gap:10px;padding:12px 26px;background:#0d1117;border-bottom:1px solid var(--line)}
.statusfilters{display:flex;align-items:center;gap:6px;flex:1;min-width:0}
.filterbtn{height:34px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--muted);
  padding:0 11px;font-size:12.5px;font-weight:800;cursor:pointer;transition:.13s;white-space:nowrap}
.filterbtn:hover{background:rgba(255,255,255,.045);color:#fff}
.filterbtn.on{background:#18212b;border-color:rgba(255,255,255,.10);color:#fff}
.search{border:1px solid var(--line);border-radius:8px;color:var(--fg);
  padding:10px 14px 10px 38px;width:248px;font-size:13px;outline:none;transition:.13s;
  background:var(--card) url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" stroke="%238b95a3" stroke-width="2" stroke-linecap="round"><circle cx="7" cy="7" r="5.2"/><path d="M15 15l-4-4"/></svg>') no-repeat 13px center}
.search::placeholder{color:var(--muted)}
.search:focus{border-color:#465262;background-color:#151c25}
.thead{display:grid;grid-template-columns:minmax(240px,2fr) minmax(118px,.72fr) minmax(130px,1fr) minmax(150px,.9fr) 280px;
  gap:12px;color:var(--muted);font-size:10.5px;font-weight:850;letter-spacing:.9px;padding:10px 32px;
  border-bottom:1px solid var(--line);background:#0d1117;text-transform:uppercase}
.thead span:last-child{text-align:right}
.list{flex:1;overflow-y:auto;padding:0 26px 26px}
.table{border:1px solid var(--line);border-top:0;border-radius:0 0 10px 10px;overflow:hidden;background:#0d1117}

.card{display:grid;grid-template-columns:minmax(240px,2fr) minmax(118px,.72fr) minmax(130px,1fr) minmax(150px,.9fr) 280px;
  gap:12px;align-items:center;min-height:68px;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.055);
  background:var(--card);transition:.13s}
.card:last-child{border-bottom:0}
.card:hover{background:var(--card2)}
.profilecell{display:flex;align-items:center;gap:12px;min-width:0}
.ava{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;
  font-weight:850;color:#08130f;font-size:16px;flex-shrink:0}
.cardbody{min-width:0}
.cardhead{display:flex;align-items:center;gap:8px;min-width:0}
.nome{font-size:15px;font-weight:800;letter-spacing:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.slugline{color:#697586;font-size:11.5px;font-weight:700;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.last{color:#9aa7b8;font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tag{background:rgba(37,244,238,.10);color:var(--cy);font-size:11px;font-weight:700;
  padding:5px 11px;border-radius:7px;border:1px solid rgba(37,244,238,.18)}
.actions{display:flex;align-items:center;justify-content:flex-end;gap:7px;flex-shrink:0}
.start{border:0;border-radius:8px;cursor:pointer;color:#04211f;font-weight:850;
  font-size:12.5px;width:86px;height:36px;transition:.13s;display:flex;align-items:center;
  justify-content:center;gap:8px;background:var(--cy)}
.start:hover{background:var(--cyd)}
.codebtn{border:1px solid rgba(37,244,238,.24);border-radius:8px;background:rgba(37,244,238,.08);
  color:#bdfdfb;font-weight:800;font-size:12px;width:94px;height:36px;cursor:pointer;transition:.13s}
.codebtn:hover{background:rgba(37,244,238,.16);border-color:rgba(37,244,238,.42)}
.codebtn.busy{opacity:.65;pointer-events:none}
.codebtn.watch{border-color:rgba(251,191,36,.34);background:rgba(251,191,36,.10);color:#fde68a}
.codebtn.done{border-color:rgba(52,211,153,.32);background:rgba(52,211,153,.10);color:#bbf7d0}
.del{background:none;border:0;color:var(--muted);cursor:pointer;display:grid;
  place-items:center;width:36px;height:36px;border-radius:8px;transition:.13s}
.del:hover{color:var(--pk);background:rgba(254,44,85,.12)}
.edit{background:none;border:0;color:var(--muted);cursor:pointer;display:grid;
  place-items:center;width:36px;height:36px;border-radius:8px;transition:.13s}
.edit:hover{color:var(--cy);background:rgba(37,244,238,.10)}
.cardtags{display:flex;gap:5px;flex-wrap:wrap}
.t2{background:var(--chip);color:#9fb3c9;font-size:10.5px;font-weight:700;
  padding:3px 8px;border-radius:7px;border:1px solid var(--line)}
.mutedcell{color:#788697;font-size:12px;font-weight:700}
.statuscell{min-width:0}
.modal label{display:block;font-size:12px;color:var(--muted);margin:14px 0 6px;font-weight:600}

.vazio{text-align:center;color:var(--muted);margin-top:90px}
.vazio .ic{opacity:.5}
.vazio h3{color:var(--fg);font-size:18px;margin:14px 0 4px;font-weight:700}

.ov{position:fixed;inset:0;background:rgba(5,7,10,.62);backdrop-filter:blur(3px);
  display:none;place-items:center;z-index:9}
.ov.on{display:grid}
.modal{background:var(--card2);border-radius:10px;padding:26px;width:460px;
  border:1px solid var(--line);box-shadow:0 20px 50px rgba(0,0,0,.55)}
.modal h3{font-size:18px;margin-bottom:6px;font-weight:700}
.modal p{color:var(--muted);font-size:13px;margin-bottom:16px}
.modal input,.modal textarea{width:100%;background:#0a0d12;border:1px solid var(--line);border-radius:8px;
  color:var(--fg);padding:13px;font-size:14px;outline:none;transition:.13s}
.modal textarea{min-height:118px;resize:vertical;font-family:inherit;line-height:1.35}
.modal input:focus,.modal textarea:focus{border-color:#39434f}
.hint{color:#7f8a99;font-size:11.5px;margin-top:6px;line-height:1.35}
.macts{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}
.bsec{background:var(--chip);color:var(--fg);border:0;border-radius:8px;
  padding:11px 18px;font-weight:600;cursor:pointer;transition:.13s}
.bsec:hover{background:#2a323d}
.bok{background:var(--pk);color:#fff;border:0;border-radius:8px;
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
  color:var(--muted);font-weight:700;white-space:nowrap}
.stbadge::before{content:"";width:8px;height:8px;border-radius:50%;
  background:#5a6472;flex:none}
.stbadge.aberta{color:#22d3ee}.stbadge.aberta::before{background:#22d3ee;
  box-shadow:0 0 0 3px rgba(34,211,238,.18)}
.stbadge.logada{color:#34d399}.stbadge.logada::before{background:#34d399}
.stbadge.expirada{color:#fbbf24}.stbadge.expirada::before{background:#fbbf24}
.stbadge.deslogada{color:#8b95a3}
.ordbtn{background:var(--chip);color:var(--fg);border:1px solid var(--line);
  border-radius:8px;height:36px;padding:0 13px;font-size:13px;font-weight:800;cursor:pointer;
  white-space:nowrap;transition:.13s}
.ordbtn:hover{border-color:var(--pk);color:var(--pk)}
.prep{display:none;margin:0 28px 12px;padding:11px 15px;border:1px solid var(--cy);
  border-radius:8px;background:rgba(37,244,238,.07);color:var(--fg);font-size:13px}
@media (max-width: 980px){
  .quickstats{display:none}
  .toolbar{flex-wrap:wrap}
  .search{width:100%}
  .thead{display:none}
  .list{padding:12px}
  .table{border-radius:10px;border-top:1px solid var(--line)}
  .card{grid-template-columns:1fr;gap:8px;padding:14px}
  .actions{justify-content:flex-end}
}
</style></head>
<body>
  <aside class="side">
    <div class="brand">
      <div class="logo"><img src="data:image/png;base64,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" alt=""></div>
      <div><h1>Contas TikTok</h1><span>Operação de perfis</span></div>
    </div>
    <button class="btn-criar" onclick="novo()">+ &nbsp;Criar perfil</button>
    <div class="navit on" id="navtodos" onclick="setFiltro('')">Todos os perfis</div>
    <div class="tagnav" id="tagnav"></div>
    <div class="count" id="count">0 perfis</div>
    <div class="tools">
      <button class="btool" onclick="abrirHostinger()">Configurar Hostinger</button>
      <button class="btool" onclick="importar()">Importar contas antigas</button>
      <button class="btool" onclick="backup()">Backup das contas</button>
      <button class="btool" onclick="restaurar()">Restaurar último backup</button>
      <div class="tstatus" id="tstatus"></div>
    </div>
    <div class="foot">By Avant IA</div>
  </aside>

  <main class="main">
    <div class="top">
      <div class="headcopy">
        <h2>Todos os perfis</h2>
        <span class="subhead" id="subhead">0 perfis cadastrados</span>
      </div>
      <div class="quickstats">
        <div class="stat"><b id="statTotal">0</b><span>Total</span></div>
        <div class="stat"><b id="statLogadas">0</b><span>Logadas</span></div>
        <div class="stat"><b id="statAbertas">0</b><span>Abertas</span></div>
      </div>
    </div>
    <div class="toolbar">
      <div class="statusfilters">
        <button class="filterbtn on" id="sfTodos" onclick="setStatusFiltro('')">Todos</button>
        <button class="filterbtn" id="sfAbertas" onclick="setStatusFiltro('aberta')">Abertas</button>
        <button class="filterbtn" id="sfLogadas" onclick="setStatusFiltro('logada')">Logadas</button>
        <button class="filterbtn" id="sfExpiradas" onclick="setStatusFiltro('expirada')">Expiradas</button>
        <button class="filterbtn" id="sfDeslogadas" onclick="setStatusFiltro('deslogada')">Não logadas</button>
      </div>
      <button class="ordbtn" id="ordbtn" onclick="toggleOrdem()" title="Ordenar">A → Z</button>
      <input class="search" id="busca" placeholder="Buscar perfil..." oninput="render()">
    </div>
    <div id="prep" class="prep"></div>
    <div class="thead"><span>Perfil</span><span>Status</span><span>Tags</span><span>Última abertura</span><span>Ações</span></div>
    <div class="list" id="list"></div>
  </main>

  <div class="ov" id="ov">
    <div class="modal">
      <h3 id="mtit">Novo perfil</h3>
      <label>Nome do cliente</label>
      <input id="mNome" autocomplete="off" placeholder="ex: Loja da Ana">
      <label>Tags / pastas (separe por vírgula)</label>
      <input id="mTags" autocomplete="off" placeholder="ex: Consultoria, Moda">
      <label>E-mail do TikTok / alias do cliente</label>
      <input id="mEmailAlias" autocomplete="off" placeholder="ex: petalabeauty@elevateecom.com.br">
      <label>Caixa principal da Hostinger (opcional)</label>
      <input id="mEmailLogin" autocomplete="off" placeholder="ex: clientes1@elevateecom.com.br">
      <label>Senha da caixa (opcional)</label>
      <input id="mEmailSenha" type="password" autocomplete="off" placeholder="Deixe em branco para manter a senha salva">
      <div class="hint" id="mEmailHint">Se a Hostinger estiver configurada no menu lateral, aqui basta o alias do cliente. A caixa acelera a busca quando você souber onde o alias está.</div>
      <div class="macts">
        <button class="bsec" onclick="fecharModal()">Cancelar</button>
        <button class="bok" id="mok">Salvar</button>
      </div>
    </div>
  </div>

  <div class="ov" id="ovh">
    <div class="modal">
      <h3>Hostinger</h3>
      <p>Caixas principais usadas para procurar os códigos do TikTok automaticamente.</p>
      <label>Caixas principais</label>
      <textarea id="hCaixas" autocomplete="off" placeholder="clientes@dominio.com.br&#10;clientes2@dominio.com.br&#10;clientes3@dominio.com.br"></textarea>
      <label>Senha das caixas</label>
      <input id="hSenha" type="password" autocomplete="off" placeholder="Deixe em branco para manter a senha salva">
      <div class="hint" id="hHint">A senha fica criptografada neste PC. Depois disso, cada perfil precisa apenas do alias/e-mail do cliente.</div>
      <div class="macts">
        <button class="bsec" onclick="fecharHostinger()">Cancelar</button>
        <button class="bok" id="hok">Salvar</button>
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
let CONTAS=[], ALLTAGS=[], HOSTINGER={caixas:[],senha_salva:false}, FILTRO='', STATUS_FILTRO='', ORDEM='az', VISCOUNT=0;
let CODE_WATCH={};
const CODE_WATCH_MS=10*60*1000, CODE_POLL_MS=12000;
function toggleOrdem(){ORDEM=ORDEM==='az'?'za':'az';const b=document.getElementById('ordbtn');if(b)b.textContent=ORDEM==='az'?'A → Z':'Z → A';render();}
const $=id=>document.getElementById(id);
function esc(s){return(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function plural(n,s,p){return n+' '+(n===1?s:p)}
function fmtHora(d){return d.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});}
function fmtUltima(v){
  if(!v)return 'Nunca aberta';
  const d=new Date(v); if(Number.isNaN(d.getTime()))return 'Data indisponível';
  const agora=new Date(), hoje=new Date(agora.getFullYear(),agora.getMonth(),agora.getDate());
  const dia=new Date(d.getFullYear(),d.getMonth(),d.getDate());
  const dias=Math.round((hoje-dia)/86400000);
  const mins=Math.floor((agora-d)/60000);
  if(mins>=0&&mins<2)return 'agora há pouco';
  if(dias===0)return 'hoje às '+fmtHora(d);
  if(dias===1)return 'ontem às '+fmtHora(d);
  if(dias>1&&dias<7)return 'há '+dias+' dias';
  return d.toLocaleDateString('pt-BR',{day:'2-digit',month:'2-digit',year:'2-digit'})+' às '+fmtHora(d);
}
function updateStats(visCount){
  const vals=Object.values(STATUS||{});
  const abertas=vals.filter(s=>s==='aberta').length;
  const logadas=vals.filter(s=>s==='logada'||s==='aberta').length;
  if($('statTotal'))$('statTotal').textContent=CONTAS.length;
  if($('statLogadas'))$('statLogadas').textContent=logadas;
  if($('statAbertas'))$('statAbertas').textContent=abertas;
  if($('subhead'))$('subhead').textContent=plural(CONTAS.length,'perfil cadastrado','perfis cadastrados');
  if($('count'))$('count').textContent=(visCount!==undefined&&visCount!==CONTAS.length)?(visCount+' de '+CONTAS.length+' perfis'):plural(CONTAS.length,'perfil','perfis');
}
function setStatusFiltro(s){STATUS_FILTRO=(STATUS_FILTRO===s?'':s);render();}
function syncStatusTabs(){
  const map={sfTodos:'',sfAbertas:'aberta',sfLogadas:'logada',sfExpiradas:'expirada',sfDeslogadas:'deslogada'};
  Object.entries(map).forEach(([id,val])=>{const el=$(id);if(el)el.classList.toggle('on',STATUS_FILTRO===val);});
}
async function api(p,body){const o={method:body?'POST':'GET'};if(body){o.headers={'Content-Type':'application/json'};o.body=JSON.stringify(body)}const r=await fetch(p,o);try{return await r.json()}catch(e){return{}}}
async function load(){const d=await api('/api/list');CONTAS=d.contas||[];ALLTAGS=d.tags||[];HOSTINGER=d.hostinger||{caixas:[],senha_salva:false};render();}
function hostingerPronta(c){
  return !!(HOSTINGER&&HOSTINGER.senha_salva&&(((HOSTINGER.caixas||[]).length>0)||(c&&c.email_login)));
}
function avisoConfigCodigo(c){
  if(!c||!c.email_alias)return {msg:'Abra o editar perfil e preencha o e-mail/alias do cliente usado no TikTok.'};
  if((c.email_login&&c.email_senha_salva)||hostingerPronta(c))return null;
  return {msg:'Configure a Hostinger uma vez no menu lateral ou informe caixa e senha nesse perfil.',cb:abrirHostinger,ok:'Configurar'};
}
function codeState(c){
  const w=CODE_WATCH[c.nome]||{};
  if(w.status==='watching')return {txt:'Buscando',cls:' watch'};
  if(w.status==='found')return {txt:'Copiado',cls:' done'};
  return {txt:'Código',cls:''};
}
function limparWatch(nome){
  const w=CODE_WATCH[nome];
  if(w&&w.timer)clearTimeout(w.timer);
  delete CODE_WATCH[nome];
}
function iniciarMonitorCodigo(nome){
  const c=CONTAS.find(x=>x.nome===nome);
  if(avisoConfigCodigo(c))return;
  limparWatch(nome);
  CODE_WATCH[nome]={status:'watching',inicio:new Date(Date.now()-45000).toISOString(),ate:Date.now()+CODE_WATCH_MS,timer:null};
  render();
  checarMonitorCodigo(nome);
}
async function checarMonitorCodigo(nome){
  const w=CODE_WATCH[nome];
  const c=CONTAS.find(x=>x.nome===nome);
  if(!w||w.status!=='watching'||!c)return;
  const r=await api('/api/code',{nome,depois_de:w.inicio});
  const atual=CODE_WATCH[nome];
  if(!atual||atual!==w||atual.status!=='watching')return;
  if(r&&r.ok){
    atual.status='found';atual.codigo=r.codigo;atual.timer=null;
    let copiado=false;try{await navigator.clipboard.writeText(r.codigo);copiado=true;}catch(e){}
    render();
    dlgAviso('Código '+r.codigo+' encontrado'+(copiado?' e copiado.':'.')+'\\nAlias: '+(r.alias||'')+(r.caixa?'\\nCaixa: '+r.caixa:''),'Código TikTok');
    return;
  }
  if(Date.now()>=atual.ate){
    atual.status='timeout';atual.timer=null;render();return;
  }
  atual.timer=setTimeout(()=>checarMonitorCodigo(nome),CODE_POLL_MS);
  render();
}
function importar(){dlgConfirma('Procurar contas já logadas na versão antiga do app (neste PC) e importar? O login é mantido. FECHE os navegadores abertos antes.',async()=>{$('tstatus').textContent='Importando...';const r=await api('/api/importar',{});$('tstatus').textContent='';if(!r||!r.ok){dlgAviso('Falhou ao importar'+(r&&r.erro?': '+r.erro:'.'));return;}load();if((r.encontradas||0)===0){dlgAviso('Nenhuma conta antiga foi encontrada na pasta do app (navegadores) neste PC. Se os logins antigos estiverem em outro lugar, me avise.','Importar contas');}else{dlgAviso('Encontrei '+r.encontradas+' conta(s) antiga(s): '+r.importadas+' nova(s) adicionada(s) à lista e '+r.logadas+' logada(s). As logadas ficam com a bolinha verde.','Importar contas');}},'Importar contas antigas','Importar');}
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
async function pollStatus(){try{const d=await api('/api/status');STATUS=d.status||{};if(STATUS_FILTRO)render();else pintarStatus();}catch(e){}setTimeout(pollStatus,5000);}
function pintarStatus(){CONTAS.forEach((c,i)=>{const el=$('st'+i);if(!el)return;const s=STATUS[c.nome]||'';el.className='stbadge '+s;el.textContent=_STXT[s]||'';});updateStats(VISCOUNT);}
function setFiltro(t){FILTRO=(FILTRO===t?'':t);render();}
function setFiltroIdx(i){setFiltro(ALLTAGS[i]);}
function render(){
  syncStatusTabs();
  $('navtodos').classList.toggle('on',FILTRO==='');
  $('tagnav').innerHTML=ALLTAGS.map((t,i)=>`<div class="tagit ${FILTRO===t?'on':''}" onclick="setFiltroIdx(${i})"><span class="dt"></span>${esc(t)}</div>`).join('');
  const f=($('busca').value||'').toLowerCase();
  let vis=CONTAS.filter(c=>c.nome.toLowerCase().includes(f));
  if(FILTRO)vis=vis.filter(c=>(c.tags||[]).includes(FILTRO));
  if(STATUS_FILTRO)vis=vis.filter(c=>{
    const s=STATUS[c.nome]||'';
    return STATUS_FILTRO==='logada' ? (s==='logada'||s==='aberta') : s===STATUS_FILTRO;
  });
  if(ORDEM==='az')vis.sort((a,b)=>a.nome.localeCompare(b.nome,'pt',{sensitivity:'base'}));
  else if(ORDEM==='za')vis.sort((a,b)=>b.nome.localeCompare(a.nome,'pt',{sensitivity:'base'}));
  VISCOUNT=vis.length;
  updateStats(vis.length);
  const L=$('list');
  if(!CONTAS.length){L.innerHTML=`<div class="vazio"><div class="ic"><svg width="58" height="58" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></div><h3>Nenhum perfil ainda</h3><div>Clique em "+ Criar perfil".</div></div>`;return;}
  if(!vis.length){L.innerHTML=`<div class="vazio"><h3>Nada encontrado</h3></div>`;return;}
  const rows=vis.map((c,vi)=>{
    const i=CONTAS.indexOf(c),cor=CORES[i%CORES.length],ini=(c.nome.trim()[0]||'?').toUpperCase();
    const chips=(c.tags||[]).map(t=>`<span class="t2">${esc(t)}</span>`).join('');
    const ultima=fmtUltima(c.ultima_abertura);
    const code=codeState(c);
    return `<div class="card" style="animation-delay:${(vi%14)*45}ms">
      <div class="profilecell">
        <div class="ava" style="background:linear-gradient(135deg,${cor},color-mix(in srgb,${cor},#000 38%))">${ini}</div>
        <div class="cardbody"><div class="nome">${esc(c.nome)}</div><div class="slugline">TikTok Seller</div></div>
      </div>
      <div class="statuscell"><span class="stbadge" id="st${i}"></span></div>
      <div class="cardtags">${chips||'<span class="mutedcell">Sem tags</span>'}</div>
      <div class="last">${esc(ultima)}</div>
      <div class="actions">
        <button class="edit" title="Editar / renomear" onclick="editar(${i})"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>
        <button class="codebtn${code.cls}" id="code${i}" onclick="codigo(${i})" title="Buscar código do TikTok no e-mail">${code.txt}</button>
        <button class="start" onclick="abrir(${i})"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>Abrir</button>
        <button class="del" title="Remover" onclick="remover(${i})"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg></button>
      </div>
    </div>`;}).join('');
  L.innerHTML=`<div class="table">${rows}</div>`;
  pintarStatus();
}
async function abrir(i){const r=await api('/api/open',{nome:CONTAS[i].nome});
  if(r.status==='preparando'){dlgAviso('O navegador próprio ainda está baixando (só na primeira vez). Espere a barra azul terminar e clique de novo.');}
  else if(r.status==='sem_navegador'){dlgAviso('Não achei um navegador pra abrir. Conecte a internet (pra baixar o navegador próprio) ou instale o Google Chrome.');}
  else{const nome=CONTAS[i].nome;CONTAS[i].ultima_abertura=r.ultima_abertura||new Date().toISOString();STATUS[nome]='aberta';render();iniciarMonitorCodigo(nome);}}
async function codigo(i){
  const c=CONTAS[i];
  const aviso=avisoConfigCodigo(c);
  if(aviso){
    if(aviso.cb)dlgConfirma(aviso.msg,aviso.cb,'Código TikTok',aviso.ok||'OK');
    else dlgAviso(aviso.msg,'Código TikTok');
    return;
  }
  const b=$('code'+i); if(b){b.classList.add('busy');b.textContent='...';}
  const r=await api('/api/code',{nome:c.nome});
  if(b){b.classList.remove('busy');b.textContent=codeState(c).txt;}
  if(!r||!r.ok){dlgAviso((r&&r.erro)||'Não encontrei o código agora.','Código TikTok');return;}
  if(CODE_WATCH[c.nome]&&CODE_WATCH[c.nome].timer)clearTimeout(CODE_WATCH[c.nome].timer);
  CODE_WATCH[c.nome]={status:'found',codigo:r.codigo,timer:null};
  try{await navigator.clipboard.writeText(r.codigo);}catch(e){}
  render();
  dlgAviso('Código '+r.codigo+' encontrado e copiado.\\nAlias: '+(r.alias||'')+(r.assunto?'\\nAssunto: '+r.assunto:''),'Código TikTok');
}
function remover(i){const n=CONTAS[i].nome;dlgConfirma("Remover '"+n+"'? Isso apaga o login salvo dele (vai precisar logar de novo).",()=>api('/api/delete',{nome:n}).then(load),'Remover perfil','Remover');}
function novo(){abrirModal('Novo perfil','',[],{},async(nome,tags,email)=>{const r=await api('/api/create',{nome,tags,...email});if(r.erro){dlgAviso(r.erro);return;}load();});}
function editar(i){const c=CONTAS[i];abrirModal('Editar perfil',c.nome,c.tags||[],c,async(nome,tags,email)=>{if(nome!==c.nome){const r=await api('/api/rename',{nome:c.nome,novo:nome});if(r.erro){dlgAviso(r.erro);return;}}await api('/api/tags',{nome,tags});await api('/api/email',{nome,email_alias:email.email_alias,email_login:email.email_login,email_senha:email.email_senha});load();});}
let _cb=null;
function abrirModal(tit,nome,tags,email,cb){$('mtit').textContent=tit;$('mNome').value=nome||'';$('mTags').value=(tags||[]).join(', ');$('mEmailAlias').value=(email&&email.email_alias)||'';$('mEmailLogin').value=(email&&email.email_login)||'';$('mEmailSenha').value='';$('mEmailSenha').placeholder=(email&&email.email_senha_salva)?'Senha salva - deixe em branco para manter':'Senha da caixa Hostinger';$('ov').classList.add('on');_cb=cb;setTimeout(()=>$('mNome').focus(),50);}
function fecharModal(){$('ov').classList.remove('on');_cb=null;}
function salvarModal(){const nome=$('mNome').value.trim();const tags=$('mTags').value.split(',').map(s=>s.trim()).filter(Boolean);const email={email_alias:$('mEmailAlias').value.trim(),email_login:$('mEmailLogin').value.trim(),email_senha:$('mEmailSenha').value};if(!nome)return;const cb=_cb;fecharModal();if(cb)cb(nome,tags,email);}
$('mok').onclick=salvarModal;
['mNome','mTags','mEmailAlias','mEmailLogin','mEmailSenha'].forEach(id=>$(id).addEventListener('keydown',e=>{if(e.key==='Enter')salvarModal();}));
function abrirHostinger(){
  $('hCaixas').value=((HOSTINGER&&HOSTINGER.caixas)||[]).join('\\n');
  $('hSenha').value='';
  $('hSenha').placeholder=(HOSTINGER&&HOSTINGER.senha_salva)?'Senha salva - deixe em branco para manter':'Senha das caixas';
  $('ovh').classList.add('on');
  setTimeout(()=>$('hCaixas').focus(),50);
}
function fecharHostinger(){$('ovh').classList.remove('on');}
async function salvarHostinger(){
  const caixas=$('hCaixas').value.split(/[\\n,;]+/).map(s=>s.trim()).filter(Boolean);
  const senha=$('hSenha').value;
  const r=await api('/api/hostinger',{caixas,senha});
  if(!r||!r.ok){dlgAviso((r&&r.erro)||'Não consegui salvar a Hostinger.','Hostinger');return;}
  HOSTINGER=r.hostinger||HOSTINGER;
  fecharHostinger();
  render();
  dlgAviso('Hostinger configurada. Ao abrir um perfil com alias salvo, o app já fica esperando o código automaticamente.','Hostinger');
}
$('hok').onclick=salvarHostinger;
['hCaixas','hSenha'].forEach(id=>$(id).addEventListener('keydown',e=>{if(e.key==='Enter'&&e.ctrlKey)salvarHostinger();}));
let _d2cb=null;
function dlg(tit,msg,okTxt,cb){$('d2tit').textContent=tit;$('d2msg').textContent=msg;$('d2ok').textContent=okTxt||'OK';$('d2cancel').style.display=cb?'':'none';$('ov2').classList.add('on');_d2cb=cb||null;}
function d2fechar(){$('ov2').classList.remove('on');_d2cb=null;}
$('d2ok').onclick=()=>{const cb=_d2cb;d2fechar();if(cb)cb();};
function dlgAviso(msg,tit){dlg(tit||'Aviso',msg,'OK',null);}
function dlgConfirma(msg,cb,tit,ok){dlg(tit||'Confirmar',msg,ok||'Sim',cb);}
document.addEventListener('keydown',e=>{if(e.key==='Escape'){fecharModal();fecharHostinger();d2fechar();}else if(e.key==='Enter'&&$('ov2').classList.contains('on'))$('d2ok').click();});
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
                {"contas": _contas_publicas(contas), "tags": _todas_tags(contas),
                 "chrome_travado": os.path.exists(CHROME_FIXO),
                 "hostinger": _hostinger_publico()}))
        elif self.path == "/api/chrome_status":
            self._send(200, json.dumps(
                {**_chrome_status, "pronto": os.path.exists(CHROME_FIXO)}))
        elif self.path == "/api/hostinger":
            self._send(200, json.dumps({"hostinger": _hostinger_publico()}))
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
            nova = {"nome": nome, "tags": tags, "ultima_abertura": None}
            _aplicar_email(nova, dados, manter_senha=False)
            contas.append(nova)
            salvar(contas)
            semear(nome)
            self._send(200, json.dumps({"ok": True}))
        elif self.path == "/api/open":
            status = abrir_perfil(nome)
            self._send(200, json.dumps(
                {"status": status, "ultima_abertura": _ultima_abertura(nome)}))
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
        elif self.path == "/api/email":
            k = _idx(contas, nome)
            if k >= 0:
                _aplicar_email(contas[k], dados, manter_senha=True)
                salvar(contas)
            self._send(200, json.dumps({"ok": True}))
        elif self.path == "/api/hostinger":
            self._send(200, json.dumps(
                {"ok": True, "hostinger": _aplicar_hostinger(dados)}))
        elif self.path == "/api/code":
            self._send(200, json.dumps(
                buscar_codigo_tiktok(nome, dados.get("depois_de"))))
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
            "--test-type", "--disable-infobars",   # esconde o aviso do Chrome for Testing
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
