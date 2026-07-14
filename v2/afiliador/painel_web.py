"""
PAINEL WEB do Afiliador — 3 contas em paralelo, interface HTML/CSS aberta numa
janela do Chrome (modo app). Backend Python (http.server) + worker Playwright por
slot. O motor de automacao (add_creators.py) e o mesmo de sempre.

Rodar: dois cliques no PAINEL.bat
"""

import os
import re
import json
import time
import threading
import subprocess
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from playwright.sync_api import sync_playwright
import add_creators as ac

PASTA = ac.PASTA
PERFIS_DIR = os.path.join(PASTA, "perfis")
UI_UDD = os.path.join(PASTA, "_ui_painel")
UPLOADS = os.path.join(PASTA, "_uploads")
CONFIG_PATH = os.path.join(PASTA, "config_painel.json")
N_SLOTS = 3


# ===== Integracao com o ElevateHub =====================================
# Quando aberto DE DENTRO do ElevateHub, o app passa um JSON (via env) com:
#   apiBase, token, chromePath e accounts[{id, name, profileDir}].
# Assim o painel usa as MESMAS contas/logins do ElevateHub (sem relogar) e o
# Chrome que o app ja embute (sem baixar o navegador do Playwright).
def _load_elevate_config():
    p = os.environ.get("ELEVATE_CREATORS_CONFIG")
    if p and os.path.exists(p):
        try:
            with open(p, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


ELEVATE = _load_elevate_config()
CHROME_EXE = ELEVATE.get("chromePath") or None
ELEVATE_ACCOUNTS = {a["name"]: a for a in (ELEVATE.get("accounts") or []) if a.get("name")}

# Dentro do ElevateHub o app fica empacotado (pasta do script = SO LEITURA).
# Todo arquivo gravavel (uploads, status_*.json, config, perfil da UI, logs) vai
# pra uma pasta gravavel que o app informa em dataDir (ex: userData/creators).
if ELEVATE.get("dataDir"):
    DATA_DIR = ELEVATE["dataDir"]
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
    except Exception:
        pass
    PASTA = DATA_DIR
    ac.PASTA = DATA_DIR          # redireciona status/_debug do motor tambem
    ac.PROFILE_DIR = os.path.join(DATA_DIR, "chrome_profile")  # fallback gravavel
    UI_UDD = os.path.join(DATA_DIR, "_ui_painel")
    UPLOADS = os.path.join(DATA_DIR, "_uploads")
    CONFIG_PATH = os.path.join(DATA_DIR, "config_painel.json")
    PERFIS_DIR = os.path.join(DATA_DIR, "perfis")   # nao pode apontar pro bundle (so-leitura)


def _elevate_profile_dir(conta):
    acc = ELEVATE_ACCOUNTS.get(conta)
    return acc.get("profileDir") if acc else None


def _injetar_cookies_elevate(ctx, conta, log=print):
    """Baixa a sessao (cookies) daquela conta do servidor do ElevateHub e injeta
    no contexto -> abre JA LOGADO, sem pedir login de novo."""
    acc = ELEVATE_ACCOUNTS.get(conta)
    base = (ELEVATE.get("apiBase") or "").rstrip("/")
    if not acc or not base:
        return
    try:
        req = urllib.request.Request(
            f"{base}/api/profiles/{acc['id']}/cookies",
            headers={"Authorization": "Bearer " + (ELEVATE.get("token") or "")})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode("utf-8"))
        pw = []
        for c in (data.get("cookies") or []):
            if not c.get("name") or not c.get("domain"):
                continue
            ck = {"name": str(c["name"]), "value": str(c.get("value") or ""),
                  "domain": str(c["domain"]), "path": c.get("path") or "/"}
            if isinstance(c.get("expires"), (int, float)) and c["expires"] > 0:
                ck["expires"] = c["expires"]
            if "httpOnly" in c:
                ck["httpOnly"] = bool(c["httpOnly"])
            ck["secure"] = bool(c.get("secure"))
            if c.get("sameSite") in ("Strict", "Lax", "None"):
                ck["sameSite"] = c["sameSite"]
                if c["sameSite"] == "None":
                    ck["secure"] = True   # Chromium exige Secure p/ SameSite=None
            pw.append(ck)
        if not pw:
            return
        # Injeta tudo de uma vez (rapido). Se UM cookie for invalido, o add_cookies
        # em lote falha INTEIRO e o painel abriria DESLOGADO em silencio -> cai pra
        # um-a-um (um cookie ruim nao derruba a sessao toda).
        try:
            ctx.add_cookies(pw)
            bons = len(pw)
        except Exception:
            bons = 0
            for ck in pw:
                try:
                    ctx.add_cookies([ck])
                    bons += 1
                except Exception:
                    pass
        log(f"   sessao do ElevateHub carregada ({bons}/{len(pw)} cookies).")
    except Exception as e:
        log(f"   (nao consegui carregar a sessao do ElevateHub: {e})")


def _slug(nome):
    return re.sub(r"[^A-Za-z0-9_-]", "", (nome or "").replace(" ", "")) \
        or "principal"


def _cfg_load():
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _cfg_save(cfg):
    # gravacao atomica: nunca deixa o config pela metade se crashar no meio
    tmp = CONFIG_PATH + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        os.replace(tmp, CONFIG_PATH)
    except Exception:
        pass


def _planilha_salva(conta):
    """Devolve {'arquivo','path'} da ultima planilha usada nessa conta, ou None."""
    return (_cfg_load().get("planilhas") or {}).get(conta)


def _planilha_guardar(conta, arquivo, path):
    cfg = _cfg_load()
    cfg.setdefault("planilhas", {})[conta] = {"arquivo": arquivo, "path": path}
    _cfg_save(cfg)


def _chrome():
    for c in [os.path.join(os.environ.get("PROGRAMFILES", ""),
                           r"Google\Chrome\Application\chrome.exe"),
              os.path.join(os.environ.get("PROGRAMFILES(X86)", ""),
                           r"Google\Chrome\Application\chrome.exe"),
              os.path.join(os.environ.get("LOCALAPPDATA", ""),
                           r"Google\Chrome\Application\chrome.exe")]:
        if c and os.path.exists(c):
            return c
    import shutil
    return shutil.which("chrome") or shutil.which("chrome.exe")


CHROME = CHROME_EXE or _chrome()   # dentro do ElevateHub usa o Chrome embutido


def listar_contas():
    # Dentro do ElevateHub, as contas vem do app (mesmas do painel principal).
    if ELEVATE_ACCOUNTS:
        return sorted(ELEVATE_ACCOUNTS.keys())
    # As lojas de verdade (perfis/) vem PRIMEIRO, pra serem as que abrem por
    # padrao nas 3 colunas. A "principal" (perfil antigo/legado) vai pro fim,
    # pra nao abrir uma conta vazia/deslogada sem querer.
    reais = []
    if os.path.isdir(PERFIS_DIR):
        reais = sorted(d for d in os.listdir(PERFIS_DIR)
                       if os.path.isdir(os.path.join(PERFIS_DIR, d)))
    return reais + ["principal"]


class Slot:
    def __init__(self, i):
        self.i = i
        self.conta = "principal"
        self.excel_path = None
        self.planilha = ""
        self.estado = "fechado"          # fechado/abrindo/pronto/duplicando/adicionando/parado/terminado
        self.navegador = False
        self.rodando = False
        self.aviso = False               # dispara o som 1x
        self.stat = {"ok": 0, "pulados": 0, "ja": 0, "nao": 0,
                     "na_tela": 0, "teto": ac.LIMITE_LOTE}
        self.log = []
        self.parar_ev = threading.Event()
        self.comecar_ev = threading.Event()
        self.duplicar_ev = threading.Event()
        self.fechar_ev = threading.Event()
        self.worker = None

    def _log(self, msg):
        self.log.append(str(msg))
        if len(self.log) > 400:
            self.log = self.log[-400:]

    def _stat(self, d):
        self.stat = {"ok": d.get("ok", 0), "pulados": d.get("pulados", 0),
                     "ja": d.get("ja", 0), "nao": d.get("nao", 0),
                     "na_tela": d.get("na_tela", 0),
                     "teto": d.get("teto", ac.LIMITE_LOTE)}

    def carregar_planilha_salva(self):
        """Recarrega a planilha que essa conta usou por ultimo (entre aberturas).
        Se a conta nao tiver planilha salva (ou o arquivo sumiu), fica vazio."""
        info = _planilha_salva(self.conta)
        if info and os.path.exists(info.get("path", "")):
            self.excel_path = info["path"]
            self.planilha = info.get("arquivo", "")
        else:
            self.excel_path = None
            self.planilha = ""

    def profile_dir(self):
        # Dentro do ElevateHub usa o MESMO perfil do app (login compartilhado).
        ed = _elevate_profile_dir(self.conta)
        if ed:
            return ed
        return (ac.PROFILE_DIR if self.conta == "principal"
                else os.path.join(PERFIS_DIR, self.conta))

    def abrir(self):
        if self.rodando:
            return
        self.fechar_ev.clear()
        self.parar_ev.clear()
        self.rodando = True
        self.worker = threading.Thread(target=self._rodar, daemon=True)
        self.worker.start()

    def _viva(self, ctx, page):
        try:
            if page is not None and not page.is_closed():
                return page
        except Exception:
            pass
        try:
            vivas = [pg for pg in ctx.pages if not pg.is_closed()]
            return vivas[-1] if vivas else ctx.new_page()
        except Exception:
            return None

    def _rodar(self):
        self.estado = "abrindo"
        self.navegador = False
        self._log(f"Conta: {self.conta}")
        try:
            ac.definir_conta(self.conta)
            with sync_playwright() as p:
                ctx = ac.abrir_contexto(p, self.profile_dir(), log=self._log,
                                        executable_path=CHROME_EXE)
                # Injeta a sessao do ElevateHub -> abre ja logado (sem relogar).
                _injetar_cookies_elevate(ctx, self.conta, log=self._log)
                page = ctx.pages[0] if ctx.pages else ctx.new_page()
                ac.desativar_pausas_debugger(page)
                try:
                    page.goto(ac.START_URL, wait_until="domcontentloaded",
                              timeout=60000)
                except Exception:
                    pass
                self.navegador = True
                morto = False
                while not self.fechar_ev.is_set():
                    self.parar_ev.clear()
                    self.comecar_ev.clear()
                    self.duplicar_ev.clear()
                    if self.estado not in ("terminado", "parado"):
                        self.estado = "pronto"
                    else:
                        self.estado = self.estado  # mantem
                    self.estado = "pronto"
                    while not (self.comecar_ev.is_set()
                               or self.duplicar_ev.is_set()
                               or self.fechar_ev.is_set()):
                        page = self._viva(ctx, page)
                        if page is None:
                            morto = True
                            break
                        try:
                            page.wait_for_timeout(150)
                        except Exception:
                            time.sleep(0.15)
                    if self.fechar_ev.is_set() or morto:
                        break
                    self.parar_ev.clear()
                    page = self._viva(ctx, page)
                    if page is None:
                        morto = True
                        break
                    if self.duplicar_ev.is_set():
                        self.duplicar_ev.clear()
                        self.estado = "duplicando"
                        try:
                            nova, _ = ac.duplicar_proximo(page, log=self._log)
                            if nova is not None:
                                page = nova
                        except Exception as e:
                            self._log("ERRO ao duplicar: " + str(e))
                        continue
                    self.comecar_ev.clear()
                    if not self.excel_path:
                        self._log(">>> Escolha a planilha antes de Comecar.")
                        continue
                    excel = self.excel_path
                    base = os.path.splitext(
                        os.path.basename(self.planilha or excel))[0]
                    cslug = re.sub(r"[^A-Za-z0-9_-]", "",
                                   self.conta.replace(" ", "")) or "principal"
                    status_path = os.path.join(
                        PASTA, f"status_{cslug}_{base}.json")
                    antigo = os.path.join(PASTA, f"status_{base}.json")
                    if not os.path.exists(status_path) and os.path.exists(antigo):
                        status = ac.carregar_status(antigo)
                        self._log("(progresso anterior herdado)")
                    else:
                        status = ac.carregar_status(status_path)
                    todos = ac.ler_ids(excel)
                    self._log(f"{len(todos)} IDs ({os.path.basename(excel)}).")
                    self.estado = "adicionando"
                    page = ac.seguir_para_aba_certa(page)
                    ac.rodar_lote(page, todos, status, status_path,
                                  log=self._log,
                                  deve_parar=lambda: self.parar_ev.is_set(),
                                  on_stat=self._stat, interativo=False)
                    if self.parar_ev.is_set():
                        self.estado = "parado"
                        self._log("Lote pausado. (navegador aberto)")
                    else:
                        self.estado = "terminado"
                        self.aviso = True
                        self._log("Lote terminado. Revise e ENVIE na mao.")
                if morto:
                    self._log(">>> Navegador fechado. Clique 'Abrir' de novo.")
                try:
                    ctx.close()
                except Exception:
                    pass
        except Exception as e:
            msg = str(e)
            low = msg.lower()
            # Erro tipico quando a conta ja esta ABERTA no ElevateHub: o Chrome
            # trava o perfil (nao abre a mesma pasta 2x). Mensagem clara em vez do
            # erro cru do Playwright.
            if any(t in low for t in ("singleton", "profile", "user data",
                                      "user-data", "lock", "in use", "cannot create")):
                self._log(">>> Esta conta parece ABERTA no ElevateHub. Feche-a lá "
                          "(botão Abrir) e clique '1 Abrir' aqui de novo.")
            else:
                self._log("ERRO: " + msg)
        finally:
            self.navegador = False
            self.rodando = False
            if self.estado not in ("terminado", "parado"):
                self.estado = "fechado"

    def to_dict(self):
        av = self.aviso
        self.aviso = False
        return {"i": self.i, "conta": self.conta, "planilha": self.planilha,
                "estado": self.estado, "navegador": self.navegador,
                "rodando": self.rodando, "stat": self.stat,
                "log": self.log[-140:], "aviso": av}


SLOTS = [Slot(i) for i in range(N_SLOTS)]

# Ultimo "ping" da UI (cada request atualiza). O painel usa isto pra saber que a
# janela ainda esta aberta, sem depender do processo-pai do Chrome.
_PING = [0.0]


HTML = r"""<!doctype html>
<html lang="pt-br"><head><meta charset="utf-8"><title>Afiliador — Painel</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0c0f14;--bar:#0a0d12;--col:#12171f;--card:#171e27;--chip:#1e2630;
 --fg:#eef2f7;--muted:#8a95a3;--line:rgba(255,255,255,.07);
 --pk:#fe2c55;--pkd:#e01f46;--cy:#25f4ee;--cyd:#16dcd6;--gr:#28c483;--am:#fbbf24;--rd:#ff5d54}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--fg);
 display:flex;flex-direction:column;overflow:hidden}
.top{display:flex;align-items:center;gap:12px;padding:14px 20px;background:var(--bar);
 border-bottom:1px solid var(--line)}
.top .dot{width:30px;height:30px;border-radius:50%;overflow:hidden;background:#000}
.top .dot img{width:100%;height:100%;object-fit:cover;transform:scale(1.06)}
.top h1{font-size:16px;font-weight:800}
.top .sub{color:var(--muted);font-size:12px}
.cols{flex:1;display:flex;gap:0;overflow:hidden}
.col{flex:1;min-width:0;display:flex;flex-direction:column;background:var(--col);
 border-right:1px solid var(--line);overflow:hidden}
.col:last-child{border-right:0}
.col.flash{animation:fl 1s ease 2}
@keyframes fl{0%,100%{background:var(--col)}50%{background:#15281f}}
.chead{padding:12px 14px;border-bottom:1px solid var(--line);display:flex;gap:8px;align-items:center}
.sel{flex:1;background:var(--card);color:var(--fg);border:1px solid var(--line);
 border-radius:9px;padding:9px 10px;font-size:13px;font-weight:600;outline:none}
.st{font-size:11px;font-weight:700;padding:4px 9px;border-radius:20px;white-space:nowrap}
.st.off{background:#2a3038;color:var(--muted)}
.st.on{background:rgba(40,196,131,.15);color:var(--gr)}
.st.run{background:rgba(37,244,238,.13);color:var(--cy)}
.st.done{background:rgba(251,191,36,.15);color:var(--am)}
.cbody{padding:12px 14px;display:flex;flex-direction:column;gap:10px;overflow:hidden;flex:1}
.plan{display:flex;align-items:center;gap:8px}
.plan .nm{flex:1;font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fbtn{background:var(--chip);color:var(--fg);border:1px solid var(--line);border-radius:8px;
 padding:7px 11px;font-size:12px;font-weight:600;cursor:pointer}
.fbtn:hover{background:#28313d}
.steps{display:flex;gap:6px}
.step{flex:1;border:0;border-radius:9px;padding:9px 4px;font-size:12px;font-weight:700;
 cursor:pointer;background:var(--chip);color:var(--fg);transition:.12s}
.step:disabled{opacity:.4;cursor:default}
.step.k{background:var(--cy);color:#04211f}
.step.k:hover:not(:disabled){background:var(--cyd)}
.step.stop{background:var(--rd);color:#fff}
.cards{display:flex;gap:8px}
.kpi{flex:1;background:var(--card);border:1px solid var(--line);border-radius:11px;
 padding:9px 6px;text-align:center}
.kpi b{display:block;font-size:19px;font-weight:800}
.kpi span{font-size:9.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px}
.kpi.ok b{color:var(--gr)} .kpi.pk b{color:var(--am)} .kpi.lote b{color:var(--cy)}
.bar{height:8px;background:#0a0e13;border-radius:6px;overflow:hidden;border:1px solid var(--line)}
.bar i{display:block;height:100%;background:var(--cy);width:0;transition:width .3s}
.guide{font-size:11.5px;color:var(--muted);min-height:16px}
.log{flex:1;background:#070a0e;border:1px solid var(--line);border-radius:11px;
 padding:9px 11px;font:11.5px/1.5 Consolas,monospace;overflow-y:auto;white-space:pre-wrap;color:#cdd6e0}
.log .ok{color:var(--gr)}.log .pk{color:var(--am)}.log .er{color:var(--rd)}.log .hd{color:var(--cy)}
::-webkit-scrollbar{width:9px}::-webkit-scrollbar-thumb{background:#26303c;border-radius:8px}
.top .novabtn{margin-left:auto;background:var(--pk);color:#fff;border:0;border-radius:9px;
 padding:9px 16px;font-weight:700;font-size:13px;cursor:pointer}
.top .novabtn:hover{filter:brightness(1.08)}
.ov{position:fixed;inset:0;background:rgba(5,7,10,.6);backdrop-filter:blur(3px);display:none;place-items:center;z-index:20}
.ov.on{display:grid}
.modal{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px;width:360px;box-shadow:0 20px 50px #000a}
.modal h3{font-size:16px;margin-bottom:6px}
.modal p{color:var(--muted);font-size:12px;margin-bottom:12px}
.modal input{width:100%;background:#0a0e13;border:1px solid var(--line);border-radius:9px;color:var(--fg);padding:11px;font-size:14px;outline:none}
.modal input:focus{border-color:var(--cy)}
.mb{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.mb button{border:0;border-radius:9px;padding:9px 16px;font-weight:700;cursor:pointer}
.mb .c{background:var(--chip);color:var(--fg)}
.mb .k{background:var(--cy);color:#04211f}
</style></head>
<body>
 <div class="top">
   <div class="dot"><img src="__LOGO__" alt=""></div>
   <h1>Adicionar creators</h1><span class="sub">até 3 contas em paralelo</span>
   <button class="novabtn" __NC_STYLE__ onclick="abrirNC()">+ Nova conta</button>
 </div>
 <div class="cols" id="cols"></div>
 <div class="ov" id="ov"><div class="modal">
   <h3>Nova conta</h3>
   <p>Nome do cliente. Você loga nela 1x ao abrir o navegador.</p>
   <input id="ncNome" autocomplete="off" placeholder="ex: Loja da Ana">
   <div class="mb"><button class="c" onclick="fecharNC()">Cancelar</button>
     <button class="k" onclick="salvarNC()">Criar</button></div>
 </div></div>
<script>
let CONTAS=[], prev={};
function beep(){try{const a=new(window.AudioContext||window.webkitAudioContext)();
 [0,180].forEach(d=>{const o=a.createOscillator(),g=a.createGain();o.connect(g);g.connect(a.destination);
 o.type='sine';o.frequency.value=880;g.gain.setValueAtTime(.001,a.currentTime+d/1000);
 g.gain.exponentialRampToValueAtTime(.12,a.currentTime+d/1000+.01);
 g.gain.exponentialRampToValueAtTime(.001,a.currentTime+d/1000+.16);
 o.start(a.currentTime+d/1000);o.stop(a.currentTime+d/1000+.17)});}catch(e){}}
async function api(p,opt){const r=await fetch(p,opt||{});try{return await r.json()}catch(e){return{}}}
function esc(s){return(s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}

function montar(){
 const C=document.getElementById('cols');C.innerHTML='';
 for(let i=0;i<3;i++){
  C.insertAdjacentHTML('beforeend',`
  <div class="col" id="col${i}">
   <div class="chead">
     <select class="sel" id="sel${i}" onchange="setConta(${i})">${CONTAS.map(c=>`<option>${esc(c)}</option>`).join('')}</select>
     <span class="st off" id="st${i}">fechado</span>
   </div>
   <div class="cbody">
     <div class="plan">
       <span class="nm" id="pl${i}">nenhuma planilha</span>
       <button class="fbtn" onclick="document.getElementById('f${i}').click()">Planilha</button>
       <input type="file" id="f${i}" accept=".xlsx" style="display:none" onchange="upPlan(${i})">
     </div>
     <div class="steps">
       <button class="step k" id="b_ab${i}" onclick="acao(${i},'abrir')">1 Abrir</button>
       <button class="step" id="b_dp${i}" onclick="acao(${i},'duplicar')">2 Duplicar</button>
       <button class="step k" id="b_go${i}" onclick="acao(${i},'comecar')">3 Começar</button>
       <button class="step stop" id="b_st${i}" onclick="acao(${i},'parar')">Parar</button>
     </div>
     <div class="guide" id="g${i}"></div>
     <div class="cards">
       <div class="kpi ok"><b id="k_ok${i}">0</b><span>Adicionados</span></div>
       <div class="kpi pk"><b id="k_pk${i}">0</b><span>Pulados</span></div>
       <div class="kpi"><b id="k_ja${i}">0</b><span>Já</span></div>
       <div class="kpi"><b id="k_no${i}">0</b><span>Não achou</span></div>
       <div class="kpi lote"><b id="k_lt${i}">0/50</b><span>Lote</span></div>
     </div>
     <div class="bar"><i id="bar${i}"></i></div>
     <div class="log" id="log${i}"></div>
   </div>
  </div>`);
 }
}
async function setConta(i){await api('/api/acao?i='+i+'&a=conta',{method:'POST',
  headers:{'Content-Type':'application/json'},body:JSON.stringify({nome:document.getElementById('sel'+i).value})});}
async function acao(i,a){await api('/api/acao?i='+i+'&a='+a,{method:'POST'});tick();}
async function upPlan(i){const f=document.getElementById('f'+i).files[0];if(!f)return;
  const buf=await f.arrayBuffer();
  await fetch('/api/planilha?i='+i,{method:'POST',headers:{'X-Filename':encodeURIComponent(f.name)},body:buf});
  tick();}
function abrirNC(){document.getElementById('ncNome').value='';document.getElementById('ov').classList.add('on');setTimeout(()=>document.getElementById('ncNome').focus(),60);}
function fecharNC(){document.getElementById('ov').classList.remove('on');}
function atualizarSelects(){for(let i=0;i<3;i++){const s=document.getElementById('sel'+i);if(!s)continue;const a=s.value;s.innerHTML=CONTAS.map(c=>`<option>${esc(c)}</option>`).join('');if(CONTAS.includes(a))s.value=a;}}
async function salvarNC(){
  const nome=document.getElementById('ncNome').value.trim();if(!nome)return;
  await api('/api/nova_conta',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nome})});
  fecharNC();
  CONTAS=(await api('/api/contas')).contas||CONTAS;
  atualizarSelects();
  for(let i=0;i<3;i++){const s=document.getElementById('sel'+i);if(s&&!s.disabled){s.value=nome;setConta(i);break;}}
}
document.addEventListener('keydown',e=>{const on=document.getElementById('ov').classList.contains('on');if(e.key==='Escape'&&on)fecharNC();else if(e.key==='Enter'&&on)salvarNC();});

const GUIA={fechado:'Escolha a conta e a planilha, depois clique 1 Abrir.',
 abrindo:'Abrindo o navegador...',pronto:'Navegador aberto. 2 Duplicar (na mão) e 3 Começar.',
 duplicando:'Duplicando — clique ˅ → Duplicar no navegador.',
 adicionando:'Adicionando criadores...',parado:'Lote pausado. 3 Começar continua de onde parou.',
 terminado:'Lote pronto! Revise e clique ENVIAR no navegador.'};

function pintar(line){let cls='';const L=line;
 if(L.includes('OK   ')||L.includes('-> ok'))cls='ok';
 else if(L.includes('SOBREPOSICAO')||L.includes('sobreposi'))cls='pk';
 else if(L.includes('ERRO')||L.startsWith('!!!'))cls='er';
 else if(L.startsWith('>>>')||L.startsWith('==='))cls='hd';
 return `<span class="${cls}">${esc(L)}</span>`;}

async function tick(){
 const d=await api('/api/estado');if(!d.slots)return;
 d.slots.forEach(s=>{const i=s.i;
   const st=document.getElementById('st'+i);
   const map={fechado:['off','fechado'],abrindo:['run','abrindo...'],pronto:['on','pronto'],
     duplicando:['run','duplicando'],adicionando:['run','adicionando'],parado:['done','pausado'],terminado:['done','lote pronto']};
   const m=map[s.estado]||['off',s.estado];st.className='st '+m[0];st.textContent=(s.navegador?'● ':'')+m[1];
   const sel=document.getElementById('sel'+i);if(document.activeElement!==sel){sel.value=s.conta;sel.disabled=s.rodando;}
   document.getElementById('pl'+i).textContent=s.planilha||'nenhuma planilha';
   document.getElementById('g'+i).textContent=GUIA[s.estado]||'';
   const k=s.stat||{};
   document.getElementById('k_ok'+i).textContent=k.ok||0;
   document.getElementById('k_pk'+i).textContent=k.pulados||0;
   document.getElementById('k_ja'+i).textContent=k.ja||0;
   document.getElementById('k_no'+i).textContent=k.nao||0;
   const teto=k.teto||50,nt=k.na_tela||0;
   document.getElementById('k_lt'+i).textContent=nt+'/'+teto;
   document.getElementById('bar'+i).style.width=Math.min(100,nt/teto*100)+'%';
   // botoes
   const open=s.navegador, add=s.estado==='adicionando';
   document.getElementById('b_ab'+i).disabled=s.rodando;
   document.getElementById('b_dp'+i).disabled=!open||add;
   document.getElementById('b_go'+i).disabled=!open||add;
   document.getElementById('b_st'+i).disabled=!add;
   // log
   const lg=document.getElementById('log'+i);const near=lg.scrollHeight-lg.scrollTop-lg.clientHeight<40;
   lg.innerHTML=(s.log||[]).map(pintar).join('\n');if(near)lg.scrollTop=lg.scrollHeight;
   // aviso de lote pronto
   if(s.aviso){beep();const col=document.getElementById('col'+i);col.classList.remove('flash');void col.offsetWidth;col.classList.add('flash');}
 });
}
(async()=>{CONTAS=(await api('/api/contas')).contas||['principal'];montar();
 for(let i=0;i<3;i++){document.getElementById('sel'+i).value=CONTAS[Math.min(i,CONTAS.length-1)];setConta(i);}
 tick();setInterval(tick,900);})();
</script></body></html>"""


def _logo_uri():
    # Le do lado do SCRIPT (asset empacotado), nao do dataDir gravavel.
    p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logo_tiktok.b64")
    try:
        with open(p) as f:
            return f.read().strip()
    except Exception:
        return ""


HTML = HTML.replace("__LOGO__", _logo_uri())
# Dentro do ElevateHub as contas vem do app -> esconde "+ Nova conta" (criar aqui
# geraria um perfil local vazio, sem os cookies/login do ElevateHub).
HTML = HTML.replace("__NC_STYLE__", 'style="display:none"' if ELEVATE_ACCOUNTS else "")


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        b = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        try:
            self.wfile.write(b)
        except Exception:
            pass

    def _qs(self):
        from urllib.parse import urlparse, parse_qs
        return parse_qs(urlparse(self.path).query)

    def do_GET(self):
        _PING[0] = time.time()          # UI viva
        path = self.path.split("?")[0]
        if path == "/":
            self._send(200, HTML, "text/html")
        elif path == "/api/contas":
            self._send(200, json.dumps({"contas": listar_contas()}))
        elif path == "/api/estado":
            self._send(200, json.dumps({"slots": [s.to_dict() for s in SLOTS]}))
        else:
            self._send(404, "{}")

    def do_POST(self):
        _PING[0] = time.time()          # UI viva
        path = self.path.split("?")[0]
        q = self._qs()
        i = int(q.get("i", ["0"])[0])
        if not (0 <= i < N_SLOTS):
            return self._send(400, "{}")
        slot = SLOTS[i]
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n) if n else b""
        if path == "/api/acao":
            a = q.get("a", [""])[0]
            if a == "conta":
                try:
                    nome = json.loads(body or "{}").get("nome", "").strip()
                except Exception:
                    nome = ""
                if nome and not slot.rodando:
                    slot.conta = nome
                    slot.carregar_planilha_salva()   # lembra a planilha da conta
            elif a == "abrir":
                slot.abrir()
            elif a == "duplicar":
                slot.duplicar_ev.set()
            elif a == "comecar":
                slot.comecar_ev.set()
            elif a == "parar":
                slot.parar_ev.set()
            self._send(200, "{}")
        elif path == "/api/planilha":
            os.makedirs(UPLOADS, exist_ok=True)
            from urllib.parse import unquote
            fn = unquote(self.headers.get("X-Filename", "planilha.xlsx"))
            fn = re.sub(r'[\\/:*?"<>|]', "", fn) or "planilha.xlsx"
            # nome do arquivo POR CONTA (estavel entre aberturas), nao por slot
            dest = os.path.join(UPLOADS, f"{_slug(slot.conta)}_{fn}")
            try:
                with open(dest, "wb") as f:
                    f.write(body)
                slot.excel_path = dest
                slot.planilha = fn
                _planilha_guardar(slot.conta, fn, dest)   # lembra pra proxima vez
            except Exception as e:
                slot._log("ERRO ao salvar planilha: " + str(e))
            self._send(200, "{}")
        elif path == "/api/nova_conta":
            try:
                nome = json.loads(body or "{}").get("nome", "").strip()
            except Exception:
                nome = ""
            nome = re.sub(r"[^A-Za-z0-9 _-]", "", nome).strip()
            if nome:
                os.makedirs(os.path.join(PERFIS_DIR, nome), exist_ok=True)
            self._send(200, json.dumps({"ok": bool(nome), "nome": nome}))
        else:
            self._send(404, "{}")


def main():
    try:
        os.makedirs(PERFIS_DIR, exist_ok=True)
    except Exception:
        pass                            # dentro do ElevateHub a pasta e so-leitura
    server = ThreadingHTTPServer(("127.0.0.1", 0), H)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}/"
    _PING[0] = time.time()
    proc = None
    if CHROME:
        proc = subprocess.Popen([
            CHROME, f"--app={url}", f"--user-data-dir={UI_UDD}",
            "--no-first-run", "--no-default-browser-check",
            "--window-size=1280,800",
        ])
    else:
        import webbrowser
        webbrowser.open(url)
    # Fica vivo enquanto a UI (janela) estiver aberta. NAO amarra a vida ao
    # processo-pai do Chrome — o Chrome-for-Testing solta o pai na hora, o que
    # fecharia o painel cedo demais. A UI faz ping a cada ~0.9s (tick); parou de
    # pingar por um tempo = a janela fechou -> encerra.
    time.sleep(3)                       # deixa a UI carregar e comecar a pingar
    while True:
        # A UI pinga a cada ~0.9s enquanto a janela esta aberta (inclusive rodando
        # um lote). So encerra apos um silencio LONGO (janela fechada). NAO usa o
        # processo-pai do Chrome (ele e solto de imediato) -> senao encerraria no
        # meio de um lote se a maquina desse uma engasgada.
        if time.time() - _PING[0] > 30:
            break
        time.sleep(1.0)
    for s in SLOTS:
        s.fechar_ev.set()
        s.parar_ev.set()
    try:
        server.shutdown()
    except Exception:
        pass


if __name__ == "__main__":
    main()
