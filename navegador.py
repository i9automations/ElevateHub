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
CHROME_UDD = os.path.join(PASTA, "navegadores")      # perfis dos clientes
UI_UDD = os.path.join(PASTA, "_ui_profile")          # perfil da janela do app
REG = os.path.join(PASTA, "contas.json")
LOGIN_URL = "https://seller-br.tiktok.com/account/login"


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


CHROME = achar_chrome()


def _slug(nome):
    return re.sub(r'[\\/:*?"<>|]', "", nome).strip() or "conta"


def carregar():
    try:
        with open(REG, encoding="utf-8") as f:
            return json.load(f).get("contas", [])
    except Exception:
        return []


def salvar(contas):
    try:
        with open(REG, "w", encoding="utf-8") as f:
            json.dump({"contas": contas}, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def semear(nome):
    d = os.path.join(CHROME_UDD, _slug(nome))
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
        f"--user-data-dir={CHROME_UDD}",
        f"--profile-directory={_slug(nome)}",
        "--no-first-run", "--no-default-browser-check", LOGIN_URL,
    ])
    return True


HTML = r"""<!doctype html>
<html lang="pt-br"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Contas TikTok</title>
<style>
:root{
  --bg:#0e1217; --side:#0a0e13; --card:#19212c; --card2:#212c39;
  --chip:#26333f; --fg:#eaeef4; --muted:#828d9c; --line:#222c38;
  --teal:#16c79a; --tealh:#1ee0af; --green:#27c07e; --greenh:#31d68d;
  --cy:#25f4ee; --pk:#fe2c55;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);
  color:var(--fg);display:flex;overflow:hidden}
::-webkit-scrollbar{width:10px}
::-webkit-scrollbar-thumb{background:#2a3543;border-radius:6px}
::-webkit-scrollbar-track{background:transparent}

/* sidebar */
.side{width:230px;background:var(--side);height:100vh;flex-shrink:0;
  padding:22px 16px;display:flex;flex-direction:column;border-right:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:26px;padding:0 6px}
.logo{width:42px;height:42px;border-radius:50%;overflow:hidden;background:#000;
  box-shadow:0 4px 14px #0008;flex-shrink:0}
.logo img{width:100%;height:100%;object-fit:cover;transform:scale(1.06);display:block}
.brand h1{font-size:17px;font-weight:700;letter-spacing:.2px}
.btn-criar{width:100%;border:0;border-radius:11px;background:var(--teal);
  color:#06231f;font-weight:700;font-size:14px;padding:12px;cursor:pointer;
  transition:.15s;display:flex;align-items:center;justify-content:center;gap:8px}
.btn-criar:hover{background:var(--tealh);transform:translateY(-1px)}
.navit{display:flex;align-items:center;gap:10px;padding:11px 12px;margin-top:18px;
  border-radius:10px;background:var(--card);font-weight:600;font-size:13px;
  position:relative;color:var(--fg)}
.navit::before{content:"";position:absolute;left:0;top:8px;bottom:8px;width:3px;
  background:var(--teal);border-radius:3px}
.count{color:var(--muted);font-size:12px;margin-top:14px;padding-left:6px}
.foot{margin-top:auto;color:#5d6775;font-size:10px;line-height:1.5}

/* main */
.main{flex:1;height:100vh;display:flex;flex-direction:column;overflow:hidden}
.top{display:flex;align-items:center;gap:14px;padding:22px 26px 12px}
.top h2{font-size:23px;font-weight:800;flex:1}
.search{background:var(--card);border:1px solid var(--line);border-radius:11px;
  color:var(--fg);padding:11px 14px;width:240px;font-size:13px;outline:none}
.search::placeholder{color:var(--muted)}
.search:focus{border-color:var(--teal)}
.thead{display:flex;justify-content:space-between;color:var(--muted);
  font-size:11px;font-weight:700;letter-spacing:.6px;padding:6px 30px;
  border-bottom:1px solid var(--line)}
.list{flex:1;overflow-y:auto;padding:14px 22px 22px}

/* card */
.card{display:flex;align-items:center;gap:14px;background:var(--card);
  border-radius:15px;padding:12px 16px;margin-bottom:10px;
  transition:.13s;border:1px solid transparent}
.card:hover{background:var(--card2);transform:translateY(-1px);
  border-color:#2f3b49;box-shadow:0 6px 18px #0006}
.ava{width:44px;height:44px;border-radius:50%;display:grid;place-items:center;
  font-weight:800;color:#0c0d11;font-size:17px;flex-shrink:0}
.nome{font-size:15px;font-weight:700;flex:1}
.tag{background:var(--chip);color:#8fb7ff;font-size:11px;font-weight:700;
  padding:5px 11px;border-radius:8px}
.start{border:0;border-radius:10px;background:var(--green);color:#06231f;
  font-weight:800;font-size:13px;padding:10px 18px;cursor:pointer;transition:.13s;
  display:flex;align-items:center;gap:7px}
.start:hover{background:var(--greenh)}
.del{background:none;border:0;color:var(--muted);font-size:17px;cursor:pointer;
  padding:8px;border-radius:9px;transition:.13s}
.del:hover{color:var(--pk);background:#2a1820}

/* vazio */
.vazio{text-align:center;color:var(--muted);margin-top:80px}
.vazio .ic{font-size:60px;opacity:.7}
.vazio h3{color:var(--fg);font-size:18px;margin:10px 0 4px}

/* modal */
.ov{position:fixed;inset:0;background:#000a;display:none;place-items:center;z-index:9}
.ov.on{display:grid}
.modal{background:var(--card);border-radius:16px;padding:24px;width:380px;
  box-shadow:0 20px 50px #000b;border:1px solid var(--line)}
.modal h3{font-size:17px;margin-bottom:6px}
.modal p{color:var(--muted);font-size:13px;margin-bottom:14px}
.modal input{width:100%;background:#0b0f14;border:1px solid var(--line);
  border-radius:10px;color:var(--fg);padding:12px;font-size:14px;outline:none}
.modal input:focus{border-color:var(--teal)}
.macts{display:flex;justify-content:flex-end;gap:10px;margin-top:18px}
.bsec{background:var(--chip);color:var(--fg);border:0;border-radius:10px;
  padding:10px 16px;font-weight:600;cursor:pointer}
.bsec:hover{background:#313e4c}
.bok{background:var(--teal);color:#06231f;border:0;border-radius:10px;
  padding:10px 18px;font-weight:700;cursor:pointer}
.bok:hover{background:var(--tealh)}
</style></head>
<body>
  <aside class="side">
    <div class="brand">
      <div class="logo"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAIAAABMXPacAAAczElEQVR4nO1dCXhVRZauqru8PS8hycsCJCEJgRCWsCtkZBmwEXSIrAYUl3ZtbBtpQbFdaFtbEWbaxnbpcfwYaeVTsIXmUxGNKDsCQkDCEiAQtpB9eevdquare18eAV5C8pZszP+9L4S8u9X5q06dOufUuXDp0qWg44FpAEJIURRBEBwOh91ur66uttvtbre7rq7O7Xb7DrZYLGaz2Wg0RqqwWCxGo5HjOAAAxliWZUVRCCGg4wF2zMcSRfH8+fMnTpw4fvz4yZMnz58/X1paWldXV19fL0mSoiiaTH3HsyoYhjEajRaLxWazJSYmpqSk9O3bNzMzMzU1NSYmBnRIdCAC6urqCgsLd+7cuWvXrl9++eXSpUu+Ph4MIITR0dHp6elDhw7NyckZPnx4amoqhBB0DLQ/AaWlpdu3b//666+3b99eUlLSuF9r4vN7VsCPHRERkZ2dPWHChEmTJg0aNIjneXBzEmC323/44Yd169bl5+dfvny57R+A5/mBAwfm5uZOmzYtMzMTtBdIm6OoqGjp0qXt2earYTabc3NzN2zY4HK52l4abUrA/v37f/3rX0dGRoIOicGDB7///vs1NTVdkIB9+/bl5eUZjUbQ4ZGRkfHWW2/V1tZ2EQKKiooefvjhTiH6xujfv/9HH30kimInJqCuru61117rsAZ4SzBu3Lht27Z1SgK++eabIUOGgM4PvV6/YMGC8vLyTkNAVVXVb3/7W80N0GXQr1+/r7/+uhMQsG3btsGDB4OuCI7jFi9ebLfbOygBiqL85S9/MZvNoEvjtttuKyws7HAEVFdXz5s3D9wcSEhI2LBhQwci4OTJk6NGjQI3E3Q63YoVKzoEAXv27ElLSwM3JRYsWCAIQnsSsHnz5vj4eHATY86cOUFOy4ET8MUXX1gslvaWQPvj7rvvrq+vb2sC/l/6jTF16tSAOQgkHrBp06bZs2fb7XbQAQA5HplMkAZuYLMtoa3FDjuR5XA8xvTp01evXh2Ay6vVBOzZs2fq1Knl5eWgY8A09nb9gkVYlqj4m2kKZYg4X3rWc+yXMD3Jgw8++MEHHzAM06qz2FYdXVRUlJeX13GkT6HT41gbFgREQLNxXkgQPRiEDatWrbLZbG+88Ua4CKiqqrrvvvvOnj0LOhQIAYqCFAUSgAEQlaZHAceKRlOYngJCqkuWL1+empr66KOPhp4AWZaffPLJvXv3ancCHQqEfjABUSzzUFKsgUHA72BgWTF7LDlQQ906AHwlntsqhGwoazLBGP/+979PT08fP358iAlYvnz5p59+2nGyORqDPhQECiaxOvRCRgKArH8CAFLGT3StOYZ4xoBQDXRtFcubmzYCgsPheOSRR3744YekpKSWHI9aclB+fv4rr7wCOiyI918FADdBgH7gtR9MKZGyUzxWvUdRPJgAiABsftoIEMXFxfPnzxdFMTQElJWVzZ8/3+Px+FIoAOh4GojQX5A6GOgPvx8A+OQ4OKgXkKglmoiMgIR8AHjx5Zdfrly5MjQELFmypKioqGMqn2vRvDgJgCyjzx1Fp20A0hgLCmejXn311f379wdLwBdffLF69WrQeUCa+kIVNQRAf9dIkJ4gy1IqiohhdGHRQSrq6uoWLlx4w+zK5gioqqpasmSJlivYATVPq6HKmo2J4O6fIMlyPDSMZLtpFqQGEGps37793XffDZyAZcuWFRUVgS4GAizzJoDsNCTId+qTwjcCNCxbtuzUqVOBEHDo0KH3338fdD0QgqJMlpfvk/XceDYhiTOGbSamqKioaN6A9E8AIeRPf/qT3W7vHHNvqwBp63TjBzCLZsQL3IO6sEeT1q5du2PHjtYR8OOPP27cuBF0TUBN35ueugs8NPFektyLpYOAhK2nCYLw6quvXpN23xwBGOM333xTkqQuMvc2YQ4BltG9Ma/7g/+xmM1UPanhaimE8LvvvsvPz28pAVu3bm3q6K4ECACj47kVD9235Jl7jSnhnAhon16xYoXfQXAtAYSQlStXyrLcBbX/1VAdSABxjOnFe/5zzT9GpfUF4cTWrVt37tx5YwIKCgo2b94MbgLAhg8AIHZqzpot3wy7dy4wGBv1O+rBaHQgvB4tuZGmxiVJeu+9925MwIcffuh2u7t89/ehoZ0kOSn581WrJ67+DN19D5vQXfVo05C519nd+NhA8dVXX504caI5d3RZWdn69evBTQhChZvMorXTpjyXNfAfR4vIsaOwcL988gS+XIrr66EsY0EAxL8l00LY7fY1a9b88Y9/bJKAL7/88tKlS13T+GkeaucmhEQi+F5mjxyrflli3KnRow1YQnY7cDohwa73/+rZuS1I3bBu3brFixeb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" alt=""></div>
      <h1>Contas TikTok</h1>
    </div>
    <button class="btn-criar" onclick="abrirModal()">+ &nbsp;Criar perfil</button>
    <div class="navit">Todos os perfis</div>
    <div class="count" id="count">0 perfis</div>
    <div class="foot">sem proxy · sem anti-detecção<br>simples e direto</div>
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
      <p id="mmsg">Nome do cliente (ex: Loja da Ana):</p>
      <input id="mInput" autocomplete="off">
      <div class="macts">
        <button class="bsec" onclick="fecharModal()">Cancelar</button>
        <button class="bok" id="mok">OK</button>
      </div>
    </div>
  </div>

<script>
const CORES=["#a78bfa","#34d399","#60a5fa","#fbbf24","#fb7185","#22d3ee",
             "#f472b6","#4ade80","#818cf8","#f0883e"];
let CONTAS=[];

async function api(p,body){
  const o={method: body?'POST':'GET'};
  if(body){o.headers={'Content-Type':'application/json'};o.body=JSON.stringify(body)}
  const r=await fetch(p,o); return r.json();
}
async function load(){ CONTAS=(await api('/api/list')).contas||[]; render(); }

function render(){
  const f=(document.getElementById('busca').value||'').toLowerCase();
  document.getElementById('count').textContent=CONTAS.length+' perfis';
  const vis=CONTAS.filter(n=>n.toLowerCase().includes(f));
  const L=document.getElementById('list');
  if(!CONTAS.length){L.innerHTML=`<div class="vazio"><div class="ic">`+
    `<svg width="58" height="58" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></div>`+
    `<h3>Nenhum perfil ainda</h3><div>Clique em “+ Criar perfil”.</div></div>`;return}
  if(!vis.length){L.innerHTML=`<div class="vazio"><h3>Nada encontrado</h3></div>`;return}
  L.innerHTML=vis.map(n=>{
    const i=CONTAS.indexOf(n), c=CORES[i%CORES.length];
    const ini=n.trim()[0].toUpperCase();
    return `<div class="card">
      <div class="ava" style="background:${c}">${ini}</div>
      <div class="nome">${esc(n)}</div>
      <span class="tag">TikTok Shop</span>
      <button class="start" onclick="abrir('${esc(n)}')"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>START</button>
      <button class="del" title="Remover" onclick="remover('${esc(n)}')"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg></button>
    </div>`;}).join('');
}
function esc(s){return s.replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}

async function abrir(n){ await api('/api/open',{nome:n}); }
async function remover(n){
  pedir("Remover perfil","Remover '"+n+"'? Isso apaga o login salvo dele.",async()=>{
    await api('/api/delete',{nome:n}); load();
  },"Remover");
}
function abrirModal(){
  pedir("Novo perfil","Nome do cliente (ex: Loja da Ana):",async()=>{
    const v=document.getElementById('mInput').value.trim();
    if(!v) return;
    const r=await api('/api/create',{nome:v});
    if(r.erro){ alert(r.erro); return; }
    load();
  },"Criar");
}
let _cb=null;
function pedir(tit,msg,cb,okTxt){
  document.getElementById('mtit').textContent=tit;
  document.getElementById('mmsg').textContent=msg;
  document.getElementById('mok').textContent=okTxt||'OK';
  const inp=document.getElementById('mInput');
  inp.style.display=(tit==='Novo perfil')?'block':'none';
  inp.value='';
  document.getElementById('ov').classList.add('on');
  setTimeout(()=>inp.focus(),50);
  _cb=cb;
}
function fecharModal(){document.getElementById('ov').classList.remove('on');_cb=null;}
document.getElementById('mok').onclick=()=>{const cb=_cb;fecharModal();if(cb)cb();};
document.getElementById('mInput').addEventListener('keydown',e=>{
  if(e.key==='Enter'){const cb=_cb;fecharModal();if(cb)cb();}
});
document.addEventListener('keydown',e=>{if(e.key==='Escape')fecharModal();});
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
            self._send(200, json.dumps({"contas": carregar()}))
        else:
            self._send(404, "{}")

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        try:
            dados = json.loads(self.rfile.read(n) or "{}")
        except Exception:
            dados = {}
        nome = (dados.get("nome") or "").strip()
        contas = carregar()
        if self.path == "/api/create":
            if not nome:
                return self._send(200, json.dumps({"erro": "Nome vazio"}))
            if nome in contas:
                return self._send(200, json.dumps(
                    {"erro": "Ja existe um perfil com esse nome."}))
            contas.append(nome)
            salvar(contas)
            semear(nome)
            self._send(200, json.dumps({"ok": True}))
        elif self.path == "/api/open":
            ok = abrir_perfil(nome)
            self._send(200, json.dumps({"ok": ok}))
        elif self.path == "/api/delete":
            if nome in contas:
                contas.remove(nome)
                salvar(contas)
            try:
                shutil.rmtree(os.path.join(CHROME_UDD, _slug(nome)),
                              ignore_errors=True)
            except Exception:
                pass
            self._send(200, json.dumps({"ok": True}))
        else:
            self._send(404, "{}")


def main():
    os.makedirs(CHROME_UDD, exist_ok=True)
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
