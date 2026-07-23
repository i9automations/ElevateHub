"""
Adiciona Creator IDs no TikTok Shop
(tela "Escolha criadores" > "Adicionar criadores manualmente")
lendo de uma planilha Excel.

Requisitos:
    pip install playwright pandas openpyxl
    playwright install chromium

Uso (resumido):
    1. Coloque a(s) planilha(s) .xlsx do(s) cliente(s) nesta pasta.
    2. Rode o RODAR.bat (ou: python add_creators.py).
    3. Escolha a planilha do cliente (se houver mais de uma).
    4. Faca login (so na 1a vez), navegue ate a tela de "Escolha criadores".
    5. Aperte ENTER no terminal -> o resto e automatico.

Cada cliente tem progresso separado (status_<planilha>.json), entao da pra
rodar varios lotes sem repetir ninguem e sem misturar clientes.
Ele verifica o contador "X/50 criadores no total" pra confirmar cada adicao
e mapeia quem ja esta na campanha / ja esta na tela.
"""

import os
import re
import json
import time
import random
import datetime
import threading

# --- Workaround (Windows + Python 3.14): o 'import pandas' chama
# platform.machine() -> win32_ver() -> _wmi_query(), e a consulta WMI desta
# maquina TRAVA (deadlock). Desligamos a consulta WMI antes de importar o
# pandas; o proprio platform tem fallback via sys.getwindowsversion(). ---
import platform as _platform
_platform._wmi_query = lambda *a, **k: (_ for _ in ()).throw(OSError("wmi off"))

import pandas as pd

# ---------------------------------------------------------------------------
# CONFIG — edite aqui
# ---------------------------------------------------------------------------
# Pasta onde fica este script (e as planilhas dos clientes).
PASTA = os.path.dirname(os.path.abspath(__file__))

COLUNA_ID = "Creator id"          # nome exato da coluna no Excel
PROFILE_DIR = os.path.join(PASTA, "chrome_profile")
# pagina aberta ao abrir o navegador (login do seller BR — pra logar/conferir conta)
START_URL = "https://seller-br.tiktok.com/account/login"
LISTA_URL = "https://affiliate.tiktok.com/connection/target-invitation"  # lista de convites (Duplicar vai pra ca)
NOME_CONVITE = "{n} - Creators 12%"   # nome do novo convite ({n} = maior+1)
VALIDADE_DIAS = 365                   # validade = hoje + N dias (1 ano)

LIMITE_LOTE = 50                  # TikTok limita a 50 por lote

# Atrasos (segundos). Menores = mais rapido (porem mais risco de bloqueio).
# Se comecar a dar muito "NAO-ACHOU" do nada, aumente esses valores.
DELAY_MIN = 0.9                   # delay base entre criadores
DELAY_MAX = 1.8
PAUSA_A_CADA = 20                 # a cada N criadores, da uma pausa maior
PAUSA_LONGA_MIN = 6.0
PAUSA_LONGA_MAX = 11.0
TYPE_DELAY_MS = (25, 55)          # atraso por tecla ao digitar (parece humano)
DROPDOWN_TIMEOUT = 3.5            # quanto esperar o resultado no dropdown
CONFIRM_TIMEOUT = 1.5            # quanto esperar o contador confirmar a adicao
BUSCA_GAP_MIN = 1.0              # segundos MINIMOS entre 2 buscas

MAX_FALHAS_SEGUIDAS = 5           # freio de seguranca: avisa/pede ENTER se isso acontecer
MAX_FALHAS_ABORT = 15             # backstop: no painel (nao-interativo), ABORTA o lote
                                  # apos tantas falhas SEGUIDAS (bloqueio/tela errada) —
                                  # nao adianta martelar a lista e queimar a conta.
MAX_ILEGIVEL_SEGUIDAS = 4         # se o contador '/50' ficar ILEGIVEL tantas vezes
                                  # seguidas, nao da mais pra CONFIRMAR adicao —
                                  # paramos em vez de marcar tudo como "ok" no escuro.
DEBUG = True                      # mostra detalhes (campo, contador antes/depois)

_OVERLAP_DUMP = False    # ja despejei o HTML de uma linha de sobreposicao? (1x)

# Estado POR-THREAD: permite rodar varias contas em PARALELO no MESMO processo
# (painel de colunas) sem uma atrapalhar a outra. Cada worker tem sua conta
# (pro _debug_<conta>.log) e seu proprio espacamento de busca.
_tl = threading.local()

MARCA = {"ok": "OK   ", "already_in_campaign": "JA-NA-CAMPANHA",
         "not_found": "NAO-ACHOU", "error": "ERRO ",
         "sobreposicao": "SOBREPOSICAO-PULADO",
         "nao_confirmado": "NAO-CONFIRMADO"}


def definir_conta(nome):
    """Define a conta da THREAD atual. Usado pra separar o _debug.log por conta,
    para rodar varias contas em PARALELO sem uma sobrescrever a outra."""
    _tl.conta = re.sub(r"[^A-Za-z0-9_-]", "", (nome or "").replace(" ", ""))


def _debug_path():
    """Caminho do log de debug (um por conta: _debug_<conta>.log)."""
    conta = getattr(_tl, "conta", "")
    sufixo = f"_{conta}" if conta else ""
    return os.path.join(PASTA, f"_debug{sufixo}.log")


def _dbg(msg):
    """Grava uma linha de debug em _debug_<conta>.log (quando DEBUG ligado)."""
    if not DEBUG:
        return
    try:
        with open(_debug_path(), "a", encoding="utf-8") as f:
            f.write(msg + "\n")
    except Exception:
        pass
# ---------------------------------------------------------------------------


# ----- escolha da planilha do cliente --------------------------------------
def escolher_planilha():
    """Lista as planilhas .xlsx da pasta e deixa escolher a do cliente.
    Cada cliente tem progresso separado (status_<planilha>.json).
    Devolve (caminho_excel, caminho_status)."""
    arqs = sorted(f for f in os.listdir(PASTA)
                  if f.lower().endswith(".xlsx")
                  and not f.startswith("~$")
                  and not f.lower().endswith("_removidos.xlsx")    # relatorio
                  and not f.lower().endswith("_filtrado.xlsx"))    # saida do filtro
    if not arqs:
        print(f"Nenhuma planilha .xlsx encontrada em:\n  {PASTA}")
        print("Coloque a planilha do cliente nessa pasta e rode de novo.")
        raise SystemExit(1)

    if len(arqs) == 1:
        escolhido = arqs[0]
        print(f"Planilha (unica na pasta): {escolhido}")
    else:
        print("\nPlanilhas encontradas (cada cliente tem a sua):")
        for i, a in enumerate(arqs):
            print(f"  [{i}] {a}")
        sel = input("Numero da planilha do cliente (ENTER = 0): ").strip()
        idx = int(sel) if (sel.isdigit() and int(sel) < len(arqs)) else 0
        escolhido = arqs[idx]
        print(f"Escolhido: {escolhido}")

    excel = os.path.join(PASTA, escolhido)
    base = os.path.splitext(escolhido)[0]
    status = os.path.join(PASTA, f"status_{base}.json")
    return excel, status


# ----- persistencia de progresso (resume entre lotes) ----------------------
def carregar_status(caminho):
    if os.path.exists(caminho):
        try:
            with open(caminho, "r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            # arquivo corrompido (crash no meio da gravacao antiga). Guarda o
            # arquivo ruim de lado e segue, em vez de quebrar o app.
            try:
                os.replace(caminho, caminho + ".corrompido")
            except OSError:
                pass
            return {}
    return {}


def salvar_status(status, caminho):
    # Gravacao ATOMICA: escreve num temporario e so entao troca pelo definitivo.
    # Assim um crash no meio nunca deixa o status_*.json corrompido/pela metade.
    tmp = caminho + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(status, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, caminho)


def abrir_contexto(p, profile_dir, log=print, tentativas=3, executable_path=None):
    """Abre o navegador persistente da conta. Se o perfil estiver OCUPADO
    (ex: um Chrome desta conta travou e nao soltou o perfil ainda), espera e
    TENTA DE NOVO algumas vezes — evita o 'nao consigo abrir de novo'.

    executable_path: quando roda dentro do ElevateHub, aponta pro Chrome que o
    app ja embute (evita baixar o navegador do Playwright)."""
    erro = None
    for i in range(tentativas):
        try:
            opts = dict(
                headless=False, no_viewport=True,
                ignore_default_args=["--enable-automation"],
                args=["--start-maximized", "--no-first-run",
                      "--no-default-browser-check",
                      # mesmo tratamento do ElevateHub: esconde o banner amarelo
                      # "Chrome for Testing" e o marcador navigator.webdriver.
                      "--test-type",
                      "--disable-blink-features=AutomationControlled"])
            if executable_path:
                opts["executable_path"] = executable_path
            return p.chromium.launch_persistent_context(profile_dir, **opts)
        except Exception as e:
            erro = e
            if i < tentativas - 1:
                log(f"   perfil ocupado, tentando de novo em 4s... "
                    f"({i + 1}/{tentativas})")
                time.sleep(4)
    raise erro


# ----- leitura do Excel ----------------------------------------------------
def _fmt_id(v):
    """Normaliza o id (evita virar '123.0' quando a planilha le como numero)."""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


def _achar_coluna_id(df):
    """Acha a coluna do ID do criador, tolerando maiuscula/espaco e variacoes."""
    variantes = {COLUNA_ID.strip().lower(), "creator id", "creatorid",
                 "id de usuario", "id de usuário", "id do criador",
                 "creator_id", "id"}
    for c in df.columns:
        if str(c).strip().lower() in variantes:
            return c
    return None


def ler_ids(caminho):
    df = pd.read_excel(caminho)
    col = _achar_coluna_id(df)
    if col is None:
        raise ValueError(
            "A planilha nao tem a coluna 'Creator id'. Colunas encontradas: "
            + ", ".join(str(c) for c in df.columns))
    ids = [_fmt_id(v) for v in df[col].dropna()]
    return [i for i in ids if i]


# ----- helpers de pagina ---------------------------------------------------
def ler_contador(page):
    """Le 'X/50 criadores no total' e devolve (X, Y) ou (None, None).
    Usa count() antes do inner_text pra NAO esperar timeout quando nao existe."""
    try:
        # "6/50criadores no total" — as vezes SEM espaco antes de 'criadores'
        loc = page.get_by_text(re.compile(r"\d+\s*/\s*\d+\s*cria", re.I)).first
        if loc.count() == 0:
            return None, None
        txt = loc.inner_text(timeout=800)
        m = re.search(r"(\d+)\s*/\s*(\d+)", txt)
        if m:
            return int(m.group(1)), int(m.group(2))
    except Exception:
        pass
    return None, None


def confirmar_adicao(page, antes, timeout_s=CONFIRM_TIMEOUT):
    """Confirma se o criador entrou. Devolve:
      'ok'        -> o contador subiu
      'nao_subiu' -> da pra ler o contador e ele NAO subiu (ja na campanha)
      'ilegivel'  -> nao deu pra ler o contador (assumimos que entrou)"""
    base = antes if antes is not None else 0
    inicio = time.time()
    fim = inicio + timeout_s
    leu = False
    while time.time() < fim:
        atual, _ = ler_contador(page)
        if atual is not None:
            leu = True
            if atual > base:
                return "ok"
        elif not leu and (time.time() - inicio) > 0.6:
            return "ilegivel"   # sem contador legivel -> assume ok rapido
        time.sleep(0.1)
    return "nao_subiu" if leu else "ilegivel"


def campo_busca(page):
    """Devolve o campo de busca VISIVEL (a pagina tem mais de um input com esse
    placeholder; o `.first` pode ser um escondido)."""
    return page.locator(
        'input[placeholder*="Pesquisar criadores"]:visible'
    ).first


def _buscar_resultado(page, creator_id):
    """Uma tentativa de busca. Garante um ESPACAMENTO MINIMO entre buscas
    (o TikTok engasga em buscas rapidas demais — causava a alternancia), limpa
    o campo e digita com TECLAS REAIS. Devolve o locator visivel ou None."""
    ultima = getattr(_tl, "ultima_busca", 0.0)   # espacamento por-thread
    espera = BUSCA_GAP_MIN - (time.monotonic() - ultima)
    if espera > 0:
        time.sleep(espera)
    _tl.ultima_busca = time.monotonic()

    campo = campo_busca(page)
    # ate 2 tentativas: depois de SELECIONAR um criador, o dropdown fica
    # "travado" e nao reabre. Tirar o FOCO (blur) e re-focar com clique +
    # teclas reais reseta esse estado. A 1a tentativa e curta; se nao abrir,
    # a 2a (apos novo blur) costuma abrir.
    for tentativa in range(2):
        try:
            try:   # tira o foco do que estiver focado (reseta o estado)
                page.evaluate(
                    "() => { const a = document.activeElement;"
                    " if (a && a.blur) a.blur(); }")
            except Exception:
                pass
            page.wait_for_timeout(120)
            campo.click(timeout=6000)              # foco fresco
            campo.fill("", timeout=4000)
            page.wait_for_timeout(120)
            page.keyboard.type(creator_id, delay=random.randint(*TYPE_DELAY_MS))
            try:
                val = (campo.input_value(timeout=600) or "").strip()
            except Exception:
                val = ""
            if val.lower() != creator_id.lower():
                campo.fill(creator_id, timeout=4000)
        except Exception:
            continue

        alvo = page.get_by_text(f"@{creator_id}", exact=True)
        # 1a tentativa falha rapido (logo apos selecionar o dropdown nao abre);
        # a 2a (apos novo blur) tem o tempo cheio.
        limite = time.time() + (DROPDOWN_TIMEOUT if tentativa else 1.5)
        while time.time() < limite:
            try:
                for i in range(alvo.count()):
                    if alvo.nth(i).is_visible():
                        return alvo.nth(i)
            except Exception:
                pass
            time.sleep(0.12)
        # nao abriu nesta tentativa -> proxima volta faz blur de novo
    return None


def adicionar_um(page, creator_id):
    """
    Tenta adicionar um creator. Devolve um dos status:
      'ok'                  -> contador subiu
      'already_in_campaign' -> ja estava na campanha
      'not_found'           -> nao apareceu no dropdown
      'error'               -> qualquer outra falha
    """
    antes, _ = ler_contador(page)

    # busca UMA vez. Os poucos que falharem por timing sao recuperados
    # depois, na 2a passada no final (sem repetir na hora).
    resultado = _buscar_resultado(page, creator_id)
    if resultado is None:
        if DEBUG:
            try:
                val = campo_busca(page).input_value(timeout=500)
            except Exception:
                val = "?"
            # o que o dropdown esta mostrando? (popups visiveis + "nao encontrado")
            try:
                info = page.evaluate(
                    "(cid) => {"
                    " const vis = e => e && e.offsetParent !== null;"
                    " const pops = [...document.querySelectorAll("
                    "  '[role=listbox],[class*=dropdown],[class*=popup],"
                    "[class*=popover],[class*=suggest],[class*=option]')]"
                    "  .filter(vis).slice(0,4).map(e => (e.textContent||'')"
                    "  .trim().slice(0,70));"
                    " const todos = [...document.querySelectorAll('*')];"
                    " const naoenc = todos.some(e => vis(e) &&"
                    "  /n[aã]o encontrado|n[aã]o se juntou/i.test(e.textContent||'')"
                    "  && e.children.length < 3);"
                    " const temArroba = todos.some(e =>"
                    "  (e.textContent||'').includes('@'+cid));"
                    " return {pops, naoenc, temArroba};"
                    "}", creator_id)
            except Exception as e:
                info = {"err": str(e)[:60]}
            _dbg(f"NAOACHOU id={creator_id} campo='{val}' {info}")
        return "not_found"

    try:
        resultado.click()
    except Exception:
        return "error"

    # RESET pos-selecao: selecionar trava o dropdown da proxima busca. Tirar o
    # foco (blur) + dar um tempinho reseta o estado, pra a PROXIMA busca ja
    # funcionar de primeira (sem precisar do retry).
    try:
        page.wait_for_timeout(250)            # deixa o add registrar
        page.evaluate(
            "() => { const a = document.activeElement;"
            " if (a && a.blur) a.blur(); }")
        page.wait_for_timeout(700)            # deixa o componente 'desselecionar'
    except Exception:
        pass

    # confirmacao rapida pelo contador
    r = confirmar_adicao(page, antes)
    if DEBUG:
        dep, _ = ler_contador(page)
        _dbg(f"{r.upper()} id={creator_id} antes={antes} depois={dep}")
    if r == "ok":
        return "ok"
    if r == "ilegivel":
        # Cliquei, mas NAO consegui ler o contador '/50' pra confirmar. NAO marca
        # "ok" no escuro (se o layout do contador mudar, isso mascararia o lote
        # inteiro como sucesso sem ter adicionado ninguem). Fica 'nao_confirmado':
        # nao entra em 'resolvidos', entao e re-tentado no proximo lote, e se
        # acontecer varias vezes seguidas o rodar_lote PARA e avisa.
        return "nao_confirmado"
    return "already_in_campaign"  # contador legivel e nao subiu


def _linha_do_criador(page, creator_id):
    """Locator da LINHA do criador na lista (ancestral do handle que tem a
    lixeira/checkbox)."""
    handle = page.get_by_text(creator_id, exact=True)
    if handle.count() == 0:
        return None
    return handle.first.locator(
        'xpath=ancestor::*[.//*[name()="svg"] or .//button '
        'or .//input][1]')


def _tem_sobreposicao(page, creator_id, esperar=True):
    """True se a linha do criador mostra 'Sobreposicao de convite'.
    Com esperar=True aguarda ate ~2.5s o aviso aparecer (ele renderiza
    com um pequeno atraso depois da adicao — era a causa de 'so o 1o ser
    tratado': o 2o era checado cedo demais)."""
    tentativas = 5 if esperar else 1
    for i in range(tentativas):
        try:
            linha = _linha_do_criador(page, creator_id)
            if linha is not None:
                txt = (linha.inner_text(timeout=1200) or "").lower()
                if "sobreposi" in txt:
                    return True
        except Exception:
            pass
        if i < tentativas - 1:
            page.wait_for_timeout(500)
    return False


def _remover_criador(page, creator_id, log=print):
    """Clica na LIXEIRA da linha do criador. True se clicou."""
    global _OVERLAP_DUMP
    try:
        linha = _linha_do_criador(page, creator_id)
        if linha is None:
            _dbg(f"OVERLAP_REMOVE id={creator_id} linha=None")
            return False
        if DEBUG and not _OVERLAP_DUMP:   # captura o HTML da linha 1x
            try:
                _dbg("LINHA_SOBREPOSICAO " +
                     (linha.evaluate("e => e.outerHTML") or "")[:1500])
            except Exception:
                pass
            _OVERLAP_DUMP = True
        # a lixeira costuma ser o ULTIMO clicavel da linha (a direita)
        cliques = linha.locator(
            'button, [role="button"], svg, [class*="delete"], [class*="trash"]')
        n = cliques.count()
        _dbg(f"OVERLAP_REMOVE id={creator_id} clicaveis={n}")
        if n == 0:
            return False
        cliques.nth(n - 1).click(timeout=3000)
        page.wait_for_timeout(700)
        return True
    except Exception as e:
        _dbg(f"OVERLAP_REMOVE id={creator_id} erro={e}")
        return False


def _pular_se_sobreposicao(page, creator_id, log=print):
    """Se o criador ficou com 'Sobreposicao de convite', ele NAO serve:
    EXCLUI da lista (lixeira) e devolve True (= foi pulado). Nao re-adiciona.
    Devolve False se nao havia sobreposicao (o criador fica na lista)."""
    over = _tem_sobreposicao(page, creator_id)
    _dbg(f"OVERLAP_CHECK id={creator_id} sobreposto={over}")
    if not over:
        return False
    log(f"   sobreposicao: {creator_id} nao serve — excluindo e pulando...")
    if not _remover_criador(page, creator_id, log):
        log(f"   (!) nao consegui excluir {creator_id} — remova na mao (lixeira)")
    return True


def _varrer_sobreposicoes(page, resultados, status, status_path, log=print,
                          emit=None, teto=None):
    """VARREDURA: reconfere os criadores ja ADICIONADOS (resultados['ok']) e
    remove os que estao em 'Sobreposicao de convite' — inclusive os cujo aviso
    apareceu ATRASADO (a causa de sobrar sobreposto na lista). Os removidos
    viram 'sobreposicao' (pulados). Devolve quantos removeu."""
    removidos = 0
    for cid in list(resultados["ok"]):
        try:
            if not _tem_sobreposicao(page, cid, esperar=False):
                continue
        except Exception:
            continue
        if _remover_criador(page, cid, log):
            resultados["ok"].remove(cid)
            resultados["sobreposicao"].append(cid)
            status[cid] = "sobreposicao"
            removidos += 1
            log(f"   limpeza: sobreposto removido -> {cid}")
            page.wait_for_timeout(300)
    if removidos:
        salvar_status(status, status_path)
        if emit is not None:
            lido, maxlido = ler_contador(page)
            emit(lido if lido is not None else len(resultados["ok"]),
                 maxlido or teto or LIMITE_LOTE)
    return removidos


def ler_ja_adicionados(page, candidatos):
    """
    Le quem JA esta na tela como adicionado e devolve o subconjunto de
    `candidatos` (ids do Excel) que ja aparecem la.

    Funciona porque, antes de digitar qualquer busca, os unicos ids do Excel
    presentes no texto da pagina sao os que ja estao na lista de adicionados.
    Rola os containers ate o fim pra carregar linhas que estejam fora da view.
    """
    candidatos = set(candidatos)
    encontrados = set()
    for _ in range(4):
        try:
            texto = page.inner_text("body", timeout=3000)
        except Exception:
            break
        # SO conta tokens que vem com "@" na frente — e assim que a lista de
        # ADICIONADOS mostra o handle (@fulano). Isso evita o falso-positivo de
        # um id que apareca solto em outro lugar da pagina (sugestao/recentes),
        # que marcaria o criador como "ja adicionado" e o pularia no escuro.
        tokens = {t.rstrip(",").rstrip("·").lstrip("@")
                  for t in re.split(r"\s+", texto) if t.startswith("@")}
        encontrados |= (candidatos & tokens)
        # rola qualquer area scrollavel ate o fim pra carregar mais linhas
        try:
            page.evaluate(
                "() => { document.querySelectorAll('*').forEach(el => {"
                " if (el.scrollHeight - el.clientHeight > 20)"
                " el.scrollTop = el.scrollHeight; }); }"
            )
        except Exception:
            pass
        time.sleep(0.8)
    return encontrados


def _skip_pauses(pg):
    """Manda o Chrome IGNORAR as pausas do 'debugger;' (anti-automacao do TikTok)
    nesta aba, e solta a aba se ja estiver congelada."""
    try:
        client = pg.context.new_cdp_session(pg)
        client.send("Debugger.enable")
        client.send("Debugger.setSkipAllPauses", {"skip": True})
        try:
            client.send("Debugger.resume")   # se ja estiver pausada, solta
        except Exception:
            pass
    except Exception:
        pass


def desativar_pausas_debugger(page):
    """Aplica o anti-pausa na aba atual e em TODA nova aba/popup que abrir."""
    _skip_pauses(page)
    try:
        page.context.on("page", _skip_pauses)   # novas abas tambem
    except Exception:
        pass


def _disfarce_chrome(pg):
    """Forca a marca 'Google Chrome' no navigator.userAgentData desta aba.
    O Chrome for Testing se identifica como 'Chromium', e o TikTok Shop checa isso
    e REJEITA a sessao -> a conta abria DESLOGADA no painel de creators (mesmo com
    os cookies certos injetados). Este e o MESMO disfarce que o ElevateHub aplica
    (Emulation.setUserAgentOverride) ao abrir uma conta normal -> aqui replicamos."""
    try:
        cdp = pg.context.new_cdp_session(pg)
        ua = pg.evaluate("() => navigator.userAgent") or ""
        m = re.search(r"Chrome/([\d.]+)", ua)
        full = m.group(1) if m else "150.0.0.0"
        major = full.split(".")[0]
        cdp.send("Emulation.setUserAgentOverride", {
            "userAgent": ua,
            "userAgentMetadata": {
                "brands": [
                    {"brand": "Not;A=Brand", "version": "8"},
                    {"brand": "Chromium", "version": major},
                    {"brand": "Google Chrome", "version": major},
                ],
                "fullVersionList": [
                    {"brand": "Not;A=Brand", "version": "8.0.0.0"},
                    {"brand": "Chromium", "version": full},
                    {"brand": "Google Chrome", "version": full},
                ],
                "fullVersion": full,
                "platform": "Windows", "platformVersion": "15.0.0",
                "architecture": "x86", "model": "", "mobile": False,
                "bitness": "64", "wow64": False,
            },
        })
        return True
    except Exception:
        return False


def aplicar_disfarce_chrome(page, log=print):
    """Aplica o disfarce 'Google Chrome' na aba atual e em toda aba nova do fluxo."""
    ok = _disfarce_chrome(page)
    log(f"   disfarce Google Chrome: {'aplicado' if ok else 'FALHOU (CDP)'}")
    try:
        page.context.on("page", _disfarce_chrome)
    except Exception:
        pass


def seguir_para_aba_certa(page):
    """Destrava todas as abas e escolhe a que esta na tela de criadores
    (a que tem o campo 'Pesquisar criadores por nome ou ID')."""
    ctx = page.context
    for pg in list(ctx.pages):
        _skip_pauses(pg)

    # 1) aba que ja mostra o campo de busca
    for pg in list(ctx.pages):
        try:
            pg.bring_to_front()
            campo = pg.get_by_placeholder(
                re.compile("Pesquisar criadores por nome ou ID"))
            if campo.count() > 0:
                print(f"Usando a aba com o campo de busca: {pg.url}")
                return pg
        except Exception:
            pass

    # 2) qualquer aba do TikTok afiliados
    for pg in list(ctx.pages):
        if "affiliate.tiktok.com" in (pg.url or ""):
            pg.bring_to_front()
            print(f"Usando aba do TikTok afiliados: {pg.url}")
            return pg

    return page


# ----- duplicar convite (criar o proximo lote) ------------------------------
def _maior_numero_convites(page):
    """Le a lista de convites e devolve o maior numero no nome (ex: '16 - ...')."""
    try:
        texto = page.inner_text("body", timeout=5000)
    except Exception:
        return 0
    nums = []
    # aceita traco normal, en-dash, em-dash e espacos variados
    for m in re.finditer(r"(\d+)\s*[-–—]\s*Creators", texto, re.I):
        nums.append(int(m.group(1)))
    for m in re.finditer(r"Creators\s*1?2?%?\s*[-–—]\s*(\d+)", texto, re.I):
        nums.append(int(m.group(1)))
    return max(nums) if nums else 0


def duplicar_proximo(page, log=print):
    """Vai na lista, descobre o maior numero, DUPLICA o convite do topo, preenche
    Nome (maior+1) e Validade (hoje + 1 ano) e seleciona 'Adicionar criadores
    manualmente'. Devolve (nova_page, numero) ou (None, None) se falhar.

    Tenta clicar em Duplicar sozinho; se nao conseguir, pede pra voce clicar no
    menu (˅) > Duplicar — e segue assim que a aba de criar abrir."""
    ctx = page.context

    log("Abrindo a lista de convites (Colaboracao direcionada)...")
    try:
        page.goto(LISTA_URL, wait_until="domcontentloaded", timeout=60000)
    except Exception:
        pass
    _skip_pauses(page)
    page.wait_for_timeout(3000)

    # le os numeros da lista (com algumas tentativas, ate a lista renderizar)
    maior = 0
    for _ in range(10):
        maior = _maior_numero_convites(page)
        if maior:
            break
        page.wait_for_timeout(1000)
    numero = maior + 1
    if maior:
        log(f"Maior numero na lista: {maior}  ->  novo convite: {numero}")
    else:
        log("Nao consegui ler os numeros da lista — vou usar 1. "
            "(Se estiver errado, corrija o Nome na mao.)")

    log("=" * 50)
    log(">>> AGORA, NO NAVEGADOR:")
    log(">>> clique no  v  (ao lado de 'Editar') do convite do TOPO")
    log(">>> e depois em 'Duplicar'  (abre uma aba nova).")
    log(f">>> O novo convite sera o numero {numero}.")
    log("=" * 50)
    log("Esperando voce clicar em Duplicar...")

    # espera a aba de criar abrir (voce clica Duplicar na mao)
    nova = None
    fim = time.time() + 150
    ultimo_aviso = time.time()
    while time.time() < fim:
        for pg in ctx.pages:
            if "/target-invitation/create" in (pg.url or ""):
                nova = pg
                break
        if nova:
            break
        if time.time() - ultimo_aviso > 15:
            log("...ainda esperando voce clicar em '˅ > Duplicar'.")
            ultimo_aviso = time.time()
        try:
            page.wait_for_timeout(400)   # pump (destrava abas novas)
        except Exception:
            time.sleep(0.4)
    if nova is None:
        log("Nao detectei a aba de criar convite. Clique 'Duplicar proximo' de novo.")
        return None, None
    log("Aba de criar convite detectada! Assumindo...")

    _skip_pauses(nova)
    nova.bring_to_front()
    # (A1) GARANTE o disfarce 'Google Chrome' NESTA aba nova ANTES de operar. O
    # handler de contexto (page.context.on("page", ...)) pode aplicar tarde demais
    # — a 1a requisicao da aba ja teria saido como 'Chromium', e o TikTok pode
    # rejeitar/deslogar essa aba. Reaplicamos e RECARREGAMOS com o disfarce ja
    # ativo. O formulario ainda esta vazio aqui, entao o reload nao perde nada.
    if _disfarce_chrome(nova):
        try:
            nova.reload(wait_until="domcontentloaded", timeout=30000)
            _skip_pauses(nova)
        except Exception:
            pass
    try:
        nova.wait_for_load_state("domcontentloaded", timeout=20000)
    except Exception:
        pass
    nova.wait_for_timeout(2500)

    # Nome do convite
    try:
        nome = NOME_CONVITE.format(n=numero)
        campo_nome = nova.get_by_placeholder("Nome do convite")
        campo_nome.click(timeout=8000)
        campo_nome.fill(nome)
        log(f"Nome preenchido: {nome}")
    except Exception as e:
        log(f"(nao consegui preencher o Nome — preencha na mao: '{NOME_CONVITE.format(n=numero)}') {type(e).__name__}")

    # Validade = hoje + 1 ano. O campo e um calendario; DIGITAR (tecla a tecla)
    # funciona melhor que fill. Depois conferimos se entrou.
    data = (datetime.date.today()
            + datetime.timedelta(days=VALIDADE_DIAS)).strftime("%d/%m/%Y")
    try:
        campo_val = nova.get_by_placeholder("Data de término")
        campo_val.click(timeout=3000)
        try:
            campo_val.fill("", timeout=1500)          # limpa o que tiver
        except Exception:
            pass
        nova.keyboard.type(data, delay=45)            # digita dd/mm/aaaa
        nova.keyboard.press("Enter")
        # fecha o calendario clicando de volta no campo de nome
        try:
            nova.get_by_placeholder("Nome do convite").click(timeout=2000)
        except Exception:
            pass
        # confere se a data entrou
        try:
            val = (campo_val.input_value(timeout=1500) or "")
        except Exception:
            val = ""
        if data in val or val.strip():
            log(f"Validade preenchida: {val.strip() or data}")
        else:
            log("(confira a Validade — talvez precise digitar na mao)")
    except Exception:
        log("(nao consegui preencher a Validade — coloque ~1 ano na mao no campo "
            "'Data de termino')")

    # marca "Adicionar criadores manualmente". A secao "Escolha criadores" pode
    # estar FECHADA — entao tentamos; se nao achar, abrimos a secao e tentamos.
    try:
        nova.mouse.wheel(0, 6000)        # rola pro fim do formulario
        nova.wait_for_timeout(800)
    except Exception:
        pass

    def _marcar_manual():
        opc = nova.get_by_text("Adicionar criadores manualmente", exact=False).first
        opc.scroll_into_view_if_needed(timeout=3000)
        opc.click(timeout=3000)

    selecionou = False
    try:
        _marcar_manual()
        selecionou = True
    except Exception:
        # secao provavelmente fechada -> abre 'Escolha criadores' e tenta de novo
        try:
            sec = nova.get_by_text("Escolha criadores", exact=True).first
            sec.scroll_into_view_if_needed(timeout=3000)
            sec.click(timeout=3000)
            nova.wait_for_timeout(700)
            _marcar_manual()
            selecionou = True
        except Exception:
            pass
    if selecionou:
        log("Selecionei 'Adicionar criadores manualmente'.")
    else:
        log("(nao consegui marcar 'Adicionar criadores manualmente')")

    # confirma que o campo de busca apareceu
    try:
        campo_busca(nova).wait_for(state="visible", timeout=5000)
        log("PRONTO! Campo de busca apareceu. Confira Nome/Validade e clique "
            "'3) Comecar a adicionar'.")
    except Exception:
        log(">>> ATENCAO: desca ate 'Escolha criadores', ABRA a secao e MARQUE "
            "'Adicionar criadores manualmente' voce mesmo. Depois '3) Comecar'.")
    return nova, numero


# ----- nucleo reutilizavel (usado pelo CLI e pela janela app.py) ------------
def rodar_lote(page, todos, status, status_path, log=print,
               deve_parar=None, on_stat=None, interativo=True):
    """Faz a pre-varredura + loop de adicao + 2a passada. Devolve `resultados`.
      log(msg)        -> mostra mensagem (print no CLI; caixa de log na janela)
      deve_parar()    -> bool; se True, aborta no proximo passo
      on_stat(dict)   -> atualiza contadores (usado pela janela)
      interativo      -> True usa input() no freio de seguranca; False so avisa"""
    # 'nao_confirmado' NAO entra em 'resolvidos' de proposito: e uma adicao que
    # nao deu pra confirmar pelo contador -> fica pendente pra re-tentar depois.
    resolvidos = {"ok", "already_in_campaign", "ja_na_tela", "sobreposicao"}
    vazio = {"ok": [], "already_in_campaign": [], "not_found": [], "error": [],
             "sobreposicao": [], "nao_confirmado": []}

    def parou():
        return bool(deve_parar and deve_parar())

    # TRAVA: so roda se estiver na tela certa (com o campo de buscar criadores).
    try:
        campo_busca(page).wait_for(state="visible", timeout=8000)
    except Exception:
        log("!!! Nao achei o campo 'Pesquisar criadores por nome ou ID' nesta tela.")
        log("    Voce NAO esta na tela 'Adicionar criadores manualmente'.")
        log("    Duplique um convite e desca ate 'Escolha criadores' antes de comecar.")
        return vazio

    if DEBUG:   # zera o log de debug pra este lote
        try:
            open(_debug_path(), "w", encoding="utf-8").close()
        except Exception:
            pass

    atual, maximo = ler_contador(page)
    maximo = maximo or LIMITE_LOTE
    if atual is None:
        log("AVISO: nao consegui ler o contador 'X/50'. Seguindo mesmo assim...")
        atual = 0
    log(f"Lote atual no TikTok: {atual}/{maximo}")
    inicial = atual

    log("Analisando quem ja esta adicionado na tela...")
    ja_na_tela = ler_ja_adicionados(page, todos)
    for cid in ja_na_tela:
        status[cid] = "ja_na_tela"
    salvar_status(status, status_path)
    log(f"  -> {len(ja_na_tela)} ja na tela.")

    pendentes = [i for i in todos if status.get(i) not in resolvidos]
    log(f"  -> pendentes pra adicionar: {len(pendentes)}")

    resultados = {"ok": [], "already_in_campaign": [], "not_found": [],
                  "error": [], "sobreposicao": [], "nao_confirmado": []}
    falhas_seguidas = 0        # not_found/error seguidos -> aviso (ENTER no CLI)
    falhas_abort = 0           # not_found/error seguidos -> backstop de abortar (A4)
    ilegiveis_seguidas = 0     # adicoes sem contador legivel seguidas (A2)
    abortado = False           # lote interrompido por bloqueio/contador quebrado

    def emit(na_tela, teto):
        if on_stat:
            feitos = sum(len(v) for v in resultados.values())
            on_stat({"ok": len(resultados["ok"]),
                     "ja": len(resultados["already_in_campaign"]),
                     "nao": len(resultados["not_found"]),
                     "err": len(resultados["error"]),
                     "pulados": len(resultados["sobreposicao"]),
                     "naoconf": len(resultados["nao_confirmado"]),
                     "na_tela": na_tela, "teto": teto,
                     "feitos": feitos, "total": len(pendentes)})

    time.sleep(0.8)   # respiro antes de comecar

    teto = maximo or LIMITE_LOTE
    idx = 0
    while idx < len(pendentes):
        if parou():
            log(">>> Parado pelo usuario.")
            break
        lido, maxlido = ler_contador(page)
        na_tela = lido if lido is not None else inicial + len(resultados["ok"])
        teto = maxlido or maximo or LIMITE_LOTE
        if na_tela >= teto:
            # lista "cheia": pode ter sobreposto (inclusive aviso ATRASADO).
            # ESPERA os avisos renderizarem e varre ATE ZERAR antes de decidir.
            for _ in range(4):
                if parou():
                    break
                try:
                    page.wait_for_timeout(1500)
                except Exception:
                    pass
                if _varrer_sobreposicoes(page, resultados, status, status_path,
                                         log, emit, teto) == 0:
                    break
            lido2, _ = ler_contador(page)
            if (lido2 if lido2 is not None else na_tela) >= teto:
                log(f">>> Lote cheio ({teto}/{teto} LIMPOS). Envie e rode de novo.")
                break
            continue   # abriu espaco -> segue adicionando ate ter 50 LIMPOS

        creator_id = pendentes[idx]
        idx += 1
        st = adicionar_um(page, creator_id)
        status[creator_id] = st
        resultados[st].append(creator_id)
        salvar_status(status, status_path)
        log(f"[{idx}/{len(pendentes)}] {MARCA[st]} -> {creator_id}")
        emit(na_tela + (1 if st == "ok" else 0), teto)

        # (A2) contador ilegivel seguidas vezes = nao da mais pra CONFIRMAR nada.
        # Melhor PARAR e avisar do que marcar o lote inteiro como sucesso no escuro.
        ilegiveis_seguidas = ilegiveis_seguidas + 1 if st == "nao_confirmado" else 0
        if ilegiveis_seguidas >= MAX_ILEGIVEL_SEGUIDAS:
            log(f"!!! {ilegiveis_seguidas} adicoes SEM confirmar seguidas — nao "
                "consegui ler o contador '/50'. NAO da pra garantir que entraram.")
            log("    Verifique a tela de 'Escolha criadores' (o contador X/50 "
                "sumiu?). Nada foi marcado como concluido — rode de novo depois.")
            if interativo:
                input("Confira o navegador e aperte ENTER pra continuar... ")
                ilegiveis_seguidas = 0
            else:
                abortado = True
                break

        # (A4) not_found/error seguidos: aviso a cada MAX_FALHAS_SEGUIDAS; e, no
        # painel (nao-interativo), ABORTA de vez apos MAX_FALHAS_ABORT (bloqueio).
        falhas_seguidas = falhas_seguidas + 1 if st in ("not_found", "error") else 0
        falhas_abort = falhas_abort + 1 if st in ("not_found", "error") else 0
        if falhas_seguidas >= MAX_FALHAS_SEGUIDAS:
            log(f"!!! {falhas_seguidas} falhas seguidas — pode ser bloqueio/tela errada.")
            if interativo:
                input("Verifique o navegador e aperte ENTER pra continuar... ")
            falhas_seguidas = 0
        if not interativo and falhas_abort >= MAX_FALHAS_ABORT:
            log(f"!!! {falhas_abort} falhas SEGUIDAS — parece bloqueio ou tela "
                "errada. Abortando este lote pra nao martelar a lista e queimar "
                "a conta. O progresso ja esta salvo; rode de novo mais tarde.")
            abortado = True
            break

        # varredura periodica: pega os avisos de sobreposicao que aparecem
        # atrasados (era a causa de sobrar sobreposto na lista)
        if idx % 10 == 0 and not parou():
            _varrer_sobreposicoes(page, resultados, status, status_path,
                                  log, emit, teto)

        time.sleep(random.uniform(DELAY_MIN, DELAY_MAX))
        if idx % PAUSA_A_CADA == 0 and not parou():
            pausa = random.uniform(PAUSA_LONGA_MIN, PAUSA_LONGA_MAX)
            log(f"   ...pausa de {pausa:.0f}s (anti-bloqueio)")
            time.sleep(pausa)

    # 2a passada: re-tenta os "nao achados" (geralmente misses por timing).
    # Se abortamos por bloqueio, NAO re-tenta (senao remartela a lista travada).
    nao_achados = list(resultados["not_found"])
    if nao_achados and not parou() and not abortado:
        log(f"--- 2a passada: re-tentando {len(nao_achados)} nao-achados ---")
        resultados["not_found"] = []
        for i, cid in enumerate(nao_achados, start=1):
            if parou():
                resultados["not_found"].extend(nao_achados[i - 1:])
                break
            lido, maxlido = ler_contador(page)
            na_tela = lido if lido is not None else inicial + len(resultados["ok"])
            if na_tela >= (maxlido or maximo or LIMITE_LOTE):
                resultados["not_found"].extend(nao_achados[i - 1:])
                break
            st = adicionar_um(page, cid)
            status[cid] = st
            resultados[st].append(cid)
            salvar_status(status, status_path)
            log(f"[retry {i}/{len(nao_achados)}] {MARCA[st]} -> {cid}")
            emit(na_tela + (1 if st == "ok" else 0), maxlido or maximo or LIMITE_LOTE)
            time.sleep(random.uniform(DELAY_MIN, DELAY_MAX))

    # VARREDURA FINAL (loop ate ZERAR): os avisos de sobreposicao as vezes
    # demoram a aparecer (e em paralelo, demora mais). Repete varrendo, COM
    # espera, ate uma passada nao achar mais nenhum sobreposto.
    total_final = 0
    for _ in range(6):
        try:
            page.wait_for_timeout(1500)
        except Exception:
            pass
        n = _varrer_sobreposicoes(page, resultados, status, status_path,
                                  log, emit, teto)
        total_final += n
        if n == 0:
            break
    if total_final:
        log(f"--- limpeza final: removi {total_final} sobreposto(s) "
            "que sobraram ---")

    log("=" * 50)
    if abortado:
        log(">>> LOTE ABORTADO (bloqueio ou contador ilegivel). Progresso salvo.")
    log("RESUMO: "
        f"adicionados={len(resultados['ok'])}  "
        f"ja-na-campanha={len(resultados['already_in_campaign'])}  "
        f"sobreposicao-pulados={len(resultados['sobreposicao'])}  "
        f"nao-confirmados={len(resultados['nao_confirmado'])}  "
        f"nao-acharam={len(resultados['not_found'])}  "
        f"erros={len(resultados['error'])}")
    return resultados


# Este arquivo e o MOTOR (logica). Use o APP.bat (interface) pra rodar.
if __name__ == "__main__":
    print("Este e o motor. Para usar, abra o APP.bat (a janela).")
