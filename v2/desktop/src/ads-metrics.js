// Lê as métricas de ADS (TikTok GMV Max) do TEXTO da página (não OCR), portado
// da automação em Python do parceiro — COM as correções da revisão:
//  - falha de leitura vira ERRO explícito (não "R$ 0" silencioso)
//  - valor + variação na mesma linha ("R$ 1.234,56 +12%") lê o valor certo
//  - aceita número decimal com ponto (12.50) sem inflar 100x

function semAcento(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

// linha que é só variação/percentual (ex: "+12% em relação a ontem")
function ehVariacaoPura(linha) {
  const semNum = linha.replace(/[+\-]?\d+([.,]\d+)?\s*%.*$/, "").trim();
  return !/\d/.test(semNum); // se, tirando o "+12%...", não sobra número -> era só variação
}

// remove um sufixo de variação ("... +12%") pra sobrar o valor principal
function tirarVariacao(linha) {
  return linha.replace(/\s*[+\-]?\d+([.,]\d+)?\s*%.*$/, "").trim();
}

function parseNum(s, decimalPonto = false) {
  if (s == null) return null;
  let t = String(s).replace(/BRL/gi, "").replace(/R\$/g, "").replace(/[^\d.,]/g, "");
  if (t === "") return null;
  if (decimalPonto) return parseFloat(t.replace(",", ".")) || 0;
  if (t.includes(",")) return parseFloat(t.replace(/\./g, "").replace(",", ".")); // BR: 1.234,56
  if (/^\d+\.\d{1,2}$/.test(t)) return parseFloat(t); // 12.50 = decimal (não milhar)
  return parseFloat(t.replace(/\./g, "")); // 1.234 = 1234 (milhar)
}

// procura o valor logo depois de um rótulo (janela curta), pulando variações
function valorApos(janela, pred, inteiro = false) {
  for (let i = 0; i < janela.length; i++) {
    if (pred(semAcento(janela[i]))) {
      for (let j = i + 1; j < Math.min(i + 7, janela.length); j++) {
        const bruto = janela[j].trim();
        if (ehVariacaoPura(bruto)) continue;
        const cand = tirarVariacao(bruto); // "R$ 1.234,56 +12%" -> "R$ 1.234,56"
        if (inteiro) {
          if (/^\d[\d.]*$/.test(cand)) return cand;
        } else if (/\d/.test(cand)) {
          return cand;
        }
      }
    }
  }
  return null;
}

// bodyText = document.body.innerText da página do painel.
// Retorna {ok:true, custo, pedidos, cpp, receita, roi} ou {ok:false, motivo}.
function extractAdsMetrics(bodyText) {
  const linhas = String(bodyText || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let ini = 0;
  let achouAncora = false;
  for (let i = 0; i < linhas.length; i++) {
    if (semAcento(linhas[i]).startsWith("visao geral")) { ini = i; achouAncora = true; break; }
  }
  const janela = ini ? linhas.slice(ini, ini + 45) : linhas.slice(0, 45);

  const raw = {
    custo:   valorApos(janela, (l) => l.startsWith("custo") && !l.startsWith("custo p")),
    cpp:     valorApos(janela, (l) => l.startsWith("custo p")),
    pedidos: valorApos(janela, (l) => l.startsWith("pedidos"), true),
    receita: valorApos(janela, (l) => l.startsWith("receita")),
    roi:     valorApos(janela, (l) => l.startsWith("roi")),
  };

  // CORREÇÃO principal: se quase nada foi lido, é ERRO (não zero silencioso).
  // Uma loja zerada de verdade ainda mostra "R$ 0,00" -> os rótulos aparecem.
  const lidos = Object.values(raw).filter((v) => v != null).length;
  if (!achouAncora && lidos < 3) {
    return { ok: false, motivo: "não achei a seção 'Visão geral' (painel não carregou ou layout mudou)" };
  }
  if (lidos < 3) {
    return { ok: false, motivo: "li poucos campos do painel — provável falha de carregamento" };
  }

  const m = {
    ok: true,
    custo:   parseNum(raw.custo) || 0,
    cpp:     parseNum(raw.cpp) || 0,
    pedidos: Math.round(parseNum(raw.pedidos) || 0),
    receita: parseNum(raw.receita) || 0,
    roi:     parseNum(raw.roi, true) || 0,
    lidos,
  };
  if (m.roi === 0 && m.custo > 0 && m.receita > 0) m.roi = Math.round((m.receita / m.custo) * 100) / 100;
  return m;
}

module.exports = { extractAdsMetrics, parseNum, semAcento };
