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


def achar_chrome():
    # 1) PREFERE o Chrome travado embutido (nao se atualiza, mantem logins).
    if os.path.exists(CHROME_FIXO):
        return CHROME_FIXO
    # 2) Senao, usa o Chrome do sistema (que se atualiza sozinho).
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


CHROME = achar_chrome()


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


def semear(nome):
    _migrar_se_preciso(nome)
    d = os.path.join(_perfil_dir(nome), "Default")
    os.makedirs(d, exist_ok=True)
    prefs = os.path.join(d, "Preferences")
    if not os.path.exists(prefs):
        try:
            with open(prefs, "w", encoding="utf-8") as f:
                json.dump({"profile": {"name": nome}}, f)
        except Exception:
            pass


def abrir_perfil(nome):
    if not CHROME:
        return False
    semear(nome)
    subprocess.Popen([
        CHROME,
        f"--user-data-dir={_perfil_dir(nome)}",   # pasta ISOLADA (chave propria)
        "--no-first-run", "--no-default-browser-check", LOGIN_URL,
    ])
    return True


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


# estado do download do Chrome travado (consultado pela UI)
_chrome_status = {"baixando": False, "msg": "", "ok": None}


def baixar_chrome_travado():
    """Baixa o Chrome for Testing (nao se atualiza) pra PASTA/chrome/."""
    import urllib.request
    import zipfile
    import io
    _chrome_status.update(baixando=True, ok=None, msg="Procurando versao...")
    try:
        idx = ("https://googlechromelabs.github.io/chrome-for-testing/"
               "last-known-good-versions-with-downloads.json")
        with urllib.request.urlopen(idx, timeout=30) as r:
            data = json.loads(r.read().decode("utf-8"))
        dls = data["channels"]["Stable"]["downloads"]["chrome"]
        url = next(d["url"] for d in dls if d["platform"] == "win64")
        _chrome_status["msg"] = "Baixando Chrome (~150 MB)..."
        with urllib.request.urlopen(url, timeout=600) as r:
            buf = io.BytesIO(r.read())
        _chrome_status["msg"] = "Extraindo..."
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
        _chrome_status.update(baixando=False, ok=True,
                              msg="Chrome travado instalado! Feche e reabra o app.")
    except Exception as e:
        _chrome_status.update(baixando=False, ok=False,
                              msg="Falhou: " + str(e))


HTML = r"""<!doctype html>
<html lang="pt-br"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Contas TikTok</title><link rel="icon" type="image/png" href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAAczElEQVR4nO1dCXhVRZauqru8PS8hycsCJCEJgRCWsCtkZBmwEXSIrAYUl3ZtbBtpQbFdaFtbEWbaxnbpcfwYaeVTsIXmUxGNKDsCQkDCEiAQtpB9eevdquare18eAV5C8pZszP+9L4S8u9X5q06dOufUuXDp0qWg44FpAEJIURRBEBwOh91ur66uttvtbre7rq7O7Xb7DrZYLGaz2Wg0RqqwWCxGo5HjOAAAxliWZUVRCCGg4wF2zMcSRfH8+fMnTpw4fvz4yZMnz58/X1paWldXV19fL0mSoiiaTH3HsyoYhjEajRaLxWazJSYmpqSk9O3bNzMzMzU1NSYmBnRIdCAC6urqCgsLd+7cuWvXrl9++eXSpUu+Ph4MIITR0dHp6elDhw7NyckZPnx4amoqhBB0DLQ/AaWlpdu3b//666+3b99eUlLSuF9r4vN7VsCPHRERkZ2dPWHChEmTJg0aNIjneXBzEmC323/44Yd169bl5+dfvny57R+A5/mBAwfm5uZOmzYtMzMTtBdIm6OoqGjp0qXt2earYTabc3NzN2zY4HK52l4abUrA/v37f/3rX0dGRoIOicGDB7///vs1NTVdkIB9+/bl5eUZjUbQ4ZGRkfHWW2/V1tZ2EQKKiooefvjhTiH6xujfv/9HH30kimInJqCuru61117rsAZ4SzBu3Lht27Z1SgK++eabIUOGgM4PvV6/YMGC8vLyTkNAVVXVb3/7W80N0GXQr1+/r7/+uhMQsG3btsGDB4OuCI7jFi9ebLfbOygBiqL85S9/MZvNoEvjtttuKyws7HAEVFdXz5s3D9wcSEhI2LBhQwci4OTJk6NGjQI3E3Q63YoVKzoEAXv27ElLSwM3JRYsWCAIQnsSsHnz5vj4eHATY86cOUFOy4ET8MUXX1gslvaWQPvj7rvvrq+vb2sC/l/6jTF16tSAOQgkHrBp06bZs2fb7XbQAQA5HplMkAZuYLMtoa3FDjuR5XA8xvTp01evXh2Ay6vVBOzZs2fq1Knl5eWgY8A09nb9gkVYlqj4m2kKZYg4X3rWc+yXMD3Jgw8++MEHHzAM06qz2FYdXVRUlJeX13GkT6HT41gbFgREQLNxXkgQPRiEDatWrbLZbG+88Ua4CKiqqrrvvvvOnj0LOhQIAYqCFAUSgAEQlaZHAceKRlOYngJCqkuWL1+empr66KOPhp4AWZaffPLJvXv3ancCHQqEfjABUSzzUFKsgUHA72BgWTF7LDlQQ906AHwlntsqhGwoazLBGP/+979PT08fP358iAlYvnz5p59+2nGyORqDPhQECiaxOvRCRgKArH8CAFLGT3StOYZ4xoBQDXRtFcubmzYCgsPheOSRR3744YekpKSWHI9aclB+fv4rr7wCOiyI918FADdBgH7gtR9MKZGyUzxWvUdRPJgAiABsftoIEMXFxfPnzxdFMTQElJWVzZ8/3+Px+FIoAOh4GojQX5A6GOgPvx8A+OQ4OKgXkKglmoiMgIR8AHjx5Zdfrly5MjQELFmypKioqGMqn2vRvDgJgCyjzx1Fp20A0hgLCmejXn311f379wdLwBdffLF69WrQeUCa+kIVNQRAf9dIkJ4gy1IqiohhdGHRQSrq6uoWLlx4w+zK5gioqqpasmSJlivYATVPq6HKmo2J4O6fIMlyPDSMZLtpFqQGEGps37793XffDZyAZcuWFRUVgS4GAizzJoDsNCTId+qTwjcCNCxbtuzUqVOBEHDo0KH3338fdD0QgqJMlpfvk/XceDYhiTOGbSamqKioaN6A9E8AIeRPf/qT3W7vHHNvqwBp63TjBzCLZsQL3IO6sEeT1q5du2PHjtYR8OOPP27cuBF0TUBN35ueugs8NPFektyLpYOAhK2nCYLw6quvXpN23xwBGOM333xTkqQuMvc2YQ4BltG9Ma/7g/+xmM1UPanhaimE8LvvvsvPz28pAVu3bm3q6K4ECACj47kVD9235Jl7jSnhnAhon16xYoXfQXAtAYSQlStXyrLcBbX/1VAdSABxjOnFe/5zzT9GpfUF4cTWrVt37tx5YwIKCgo2b94MbgLAhg8AIHZqzpot3wy7dy4wGBv1O+rBaHQgvB4tuZGmxiVJeu+9925MwIcffuh2u7t89/ehoZ0kOSn581WrJ67+DN19D5vQXfVo05C519nd+NhA8dVXX504caI5d3RZWdn69evBTQhChZvMorXTpjyXNfAfR4vIsaOwcL988gS+XIrr66EsY0EAxL8l00LY7fY1a9b88Y9/bJKAL7/88tKlS13T+GkeaucmhEQi+F5mjxyrflli3KnRow1YQnY7cDohwa73/+rZuS1I3bBu3brFixeb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">
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
</style></head>
<body>
  <aside class="side">
    <div class="brand">
      <div class="logo"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAAczElEQVR4nO1dCXhVRZauqru8PS8hycsCJCEJgRCWsCtkZBmwEXSIrAYUl3ZtbBtpQbFdaFtbEWbaxnbpcfwYaeVTsIXmUxGNKDsCQkDCEiAQtpB9eevdquare18eAV5C8pZszP+9L4S8u9X5q06dOufUuXDp0qWg44FpAEJIURRBEBwOh91ur66uttvtbre7rq7O7Xb7DrZYLGaz2Wg0RqqwWCxGo5HjOAAAxliWZUVRCCGg4wF2zMcSRfH8+fMnTpw4fvz4yZMnz58/X1paWldXV19fL0mSoiiaTH3HsyoYhjEajRaLxWazJSYmpqSk9O3bNzMzMzU1NSYmBnRIdCAC6urqCgsLd+7cuWvXrl9++eXSpUu+Ph4MIITR0dHp6elDhw7NyckZPnx4amoqhBB0DLQ/AaWlpdu3b//666+3b99eUlLSuF9r4vN7VsCPHRERkZ2dPWHChEmTJg0aNIjneXBzEmC323/44Yd169bl5+dfvny57R+A5/mBAwfm5uZOmzYtMzMTtBdIm6OoqGjp0qXt2earYTabc3NzN2zY4HK52l4abUrA/v37f/3rX0dGRoIOicGDB7///vs1NTVdkIB9+/bl5eUZjUbQ4ZGRkfHWW2/V1tZ2EQKKiooefvjhTiH6xujfv/9HH30kimInJqCuru61117rsAZ4SzBu3Lht27Z1SgK++eabIUOGgM4PvV6/YMGC8vLyTkNAVVXVb3/7W80N0GXQr1+/r7/+uhMQsG3btsGDB4OuCI7jFi9ebLfbOygBiqL85S9/MZvNoEvjtttuKyws7HAEVFdXz5s3D9wcSEhI2LBhQwci4OTJk6NGjQI3E3Q63YoVKzoEAXv27ElLSwM3JRYsWCAIQnsSsHnz5vj4eHATY86cOUFOy4ET8MUXX1gslvaWQPvj7rvvrq+vb2sC/l/6jTF16tSAOQgkHrBp06bZs2fb7XbQAQA5HplMkAZuYLMtoa3FDjuR5XA8xvTp01evXh2Ay6vVBOzZs2fq1Knl5eWgY8A09nb9gkVYlqj4m2kKZYg4X3rWc+yXMD3Jgw8++MEHHzAM06qz2FYdXVRUlJeX13GkT6HT41gbFgREQLNxXkgQPRiEDatWrbLZbG+88Ua4CKiqqrrvvvvOnj0LOhQIAYqCFAUSgAEQlaZHAceKRlOYngJCqkuWL1+empr66KOPhp4AWZaffPLJvXv3ancCHQqEfjABUSzzUFKsgUHA72BgWTF7LDlQQ906AHwlntsqhGwoazLBGP/+979PT08fP358iAlYvnz5p59+2nGyORqDPhQECiaxOvRCRgKArH8CAFLGT3StOYZ4xoBQDXRtFcubmzYCgsPheOSRR3744YekpKSWHI9aclB+fv4rr7wCOiyI918FADdBgH7gtR9MKZGyUzxWvUdRPJgAiABsftoIEMXFxfPnzxdFMTQElJWVzZ8/3+Px+FIoAOh4GojQX5A6GOgPvx8A+OQ4OKgXkKglmoiMgIR8AHjx5Zdfrly5MjQELFmypKioqGMqn2vRvDgJgCyjzx1Fp20A0hgLCmejXn311f379wdLwBdffLF69WrQeUCa+kIVNQRAf9dIkJ4gy1IqiohhdGHRQSrq6uoWLlx4w+zK5gioqqpasmSJlivYATVPq6HKmo2J4O6fIMlyPDSMZLtpFqQGEGps37793XffDZyAZcuWFRUVgS4GAizzJoDsNCTId+qTwjcCNCxbtuzUqVOBEHDo0KH3338fdD0QgqJMlpfvk/XceDYhiTOGbSamqKioaN6A9E8AIeRPf/qT3W7vHHNvqwBp63TjBzCLZsQL3IO6sEeT1q5du2PHjtYR8OOPP27cuBF0TUBN35ueugs8NPFektyLpYOAhK2nCYLw6quvXpN23xwBGOM333xTkqQuMvc2YQ4BltG9Ma/7g/+xmM1UPanhaimE8LvvvsvPz28pAVu3bm3q6K4ECACj47kVD9235Jl7jSnhnAhon16xYoXfQXAtAYSQlStXyrLcBbX/1VAdSABxjOnFe/5zzT9GpfUF4cTWrVt37tx5YwIKCgo2b94MbgLAhg8AIHZqzpot3wy7dy4wGBv1O+rBaHQgvB4tuZGmxiVJeu+9925MwIcffuh2u7t89/ehoZ0kOSn581WrJ67+DN19D5vQXfVo05C519nd+NhA8dVXX504caI5d3RZWdn69evBTQhChZvMorXTpjyXNfAfR4vIsaOwcL988gS+XIrr66EsY0EAxL8l00LY7fY1a9b88Y9/bJKAL7/88tKlS13T+GkeaucmhEQi+F5mjxyrflli3KnRow1YQnY7cDohwa73/+rZuS1I3bBu3brFixeb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" alt=""></div>
      <h1>Contas TikTok</h1>
    </div>
    <button class="btn-criar" onclick="novo()">+ &nbsp;Criar perfil</button>
    <div class="navit on" id="navtodos" onclick="filtrar('')">Todos os perfis</div>
    <div class="tagnav" id="tagnav"></div>
    <div class="count" id="count">0 perfis</div>
    <div class="tools">
      <button class="btool" onclick="backup()">Backup das contas</button>
      <button class="btool" onclick="restaurar()">Restaurar último backup</button>
      <button class="btool" id="btravar" onclick="travar()">Travar Chrome (recomendado)</button>
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
async function load(){const d=await api('/api/list');CONTAS=d.contas||[];ALLTAGS=d.tags||[];
  const bt=$('btravar');if(bt){if(d.chrome_travado){bt.textContent='Chrome travado ✓';bt.disabled=true;bt.style.opacity=.6;}else{bt.textContent='Travar Chrome (recomendado)';}}
  render();}
async function backup(){$('tstatus').textContent='Fazendo backup...';const r=await api('/api/backup',{});$('tstatus').textContent=r.ok?('Backup salvo: '+r.arquivo):('Falhou: '+(r.erro||''));}
function restaurar(){dlgConfirma('Restaurar o último backup? FECHE todos os navegadores antes. Isso sobrescreve as contas atuais.',async()=>{$('tstatus').textContent='Restaurando...';const r=await api('/api/restaurar',{});$('tstatus').textContent=r.ok?('Restaurado: '+r.arquivo):('Falhou: '+(r.erro||''));if(r.ok)load();},'Restaurar backup','Restaurar');}
function travar(){dlgConfirma('Baixar um Chrome que NÃO se atualiza (~150 MB)? É o que impede as contas de deslogarem sozinhas. Pode demorar alguns minutos.',()=>{api('/api/travar_chrome',{});pollChrome();},'Travar Chrome','Baixar');}
async function pollChrome(){const s=await api('/api/chrome_status');$('tstatus').textContent=s.msg||'';if(s.baixando){setTimeout(pollChrome,1500);}else{if(s.ok)load();}}
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
      <div style="flex:1;min-width:0"><div class="nome">${esc(c.nome)}</div>${chips?`<div class="cardtags">${chips}</div>`:''}</div>
      <button class="edit" title="Editar / renomear" onclick="editar(${i})"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>
      <button class="start" onclick="abrir(${i})"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>START</button>
      <button class="del" title="Remover" onclick="remover(${i})"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg></button>
    </div>`;}).join('');
}
async function abrir(i){await api('/api/open',{nome:CONTAS[i].nome});}
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
            self._send(200, json.dumps(_chrome_status))
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
            self._send(200, json.dumps({"ok": abrir_perfil(nome)}))
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
        elif self.path == "/api/travar_chrome":
            if not _chrome_status["baixando"]:
                threading.Thread(target=baixar_chrome_travado,
                                 daemon=True).start()
            self._send(200, json.dumps({"ok": True}))
        else:
            self._send(404, "{}")


def main():
    os.makedirs(CONTAS_DIR, exist_ok=True)
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
