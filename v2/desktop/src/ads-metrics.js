// Lê as métricas de ADS (TikTok GMV Max) do TEXTO da página (não OCR).
// Reescrito p/ ser robusto ao layout real do GMV Max:
//  - variações de rótulo (Custo/Gasto/Investimento, Receita/GMV, ROI/ROAS, Pedidos pagos…)
//  - lê o valor NA MESMA linha do rótulo ("Custo R$ 1.234,56 +12%") ou nas linhas seguintes
//  - ignora a variação ("+12%"), aceita decimal com ponto (3.5) e milhar BR (1.234,56)
//  - falha de leitura vira ERRO explícito (não "R$ 0" silencioso) + diagnóstico do que leu

function semAcento(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

// linha que é só variação/percentual (ex: "+12% em relação a ontem")
function ehVariacaoPura(linha) {
  const semNum = linha.replace(/[+\-]?\d+([.,]\d+)?\s*%.*$/, "").trim();
  return !/\d/.test(semNum);
}

// remove um sufixo de variação ("... +12%") pra sobrar o valor principal
function tirarVariacao(linha) {
  return linha.replace(/\s*[+\-]?\d+([.,]\d+)?\s*%.*$/, "").trim();
}

function parseNum(s, decimalPonto = false) {
  if (s == null) return null;
  let t = String(s).replace(/BRL/gi, "").replace(/R\$/g, "").replace(/[^\d.,]/g, "");
  if (t === "") return null;
  let n;
  if (decimalPonto) n = parseFloat(t.replace(",", "."));
  else if (t.includes(",")) n = parseFloat(t.replace(/\./g, "").replace(",", ".")); // BR: 1.234,56
  else if (/^\d+\.\d{1,2}$/.test(t)) n = parseFloat(t); // 12.50 = decimal (não milhar)
  else n = parseFloat(t.replace(/\./g, "")); // 1.234 = 1234 (milhar)
  // Nunca devolve NaN (que viraria 0 silencioso lá no `|| 0`): valor ilegivel = null.
  return Number.isFinite(n) ? n : null;
}

// Rótulos aceitos por métrica (testados no texto SEM acento e minúsculo).
// Ordem importa: "custo por pedido" precisa casar ANTES de "custo".
const LABELS = {
  cpp:     [/^custo por pedido\b/, /^custo\/pedido\b/, /^custo p\/?\s?pedido\b/, /^cpa\b/, /^custo por conversao\b/],
  custo:   [/^custo total\b/, /^custo\b(?!\s*(por|\/|p\/))/, /^gasto( total)?\b/, /^investimento\b/, /^valor (gasto|investido)\b/],
  pedidos: [/^pedidos pagos\b/, /^pedidos( brutos| totais)?\b/, /^total de pedidos\b/, /^numero de pedidos\b/],
  receita: [/^receita bruta\b/, /^receita( total)?\b/, /^gmv\b/, /^faturamento\b/, /^vendas( brutas)?\b/],
  roi:     [/^roi\b/, /^roas\b/, /^retorno( sobre)?\b/, /^gross roi\b/],
};

// primeiro número plausível em UMA linha (usado p/ valor na mesma linha do rótulo)
function primeiroValorNaLinha(linha) {
  let cand = tirarVariacao(linha);
  // Remove ruído de INTERVALO ("(7 dias)", "últimos 7 dias", "7d") que era
  // confundido com o valor — ex: "Custo (7 dias) R$ 1.234,56" pegava "7".
  cand = cand.replace(/\(?\búltimos?\b\)?/gi, " ").replace(/\(?\b\d+\s*(dias?|d)\b\)?/gi, " ");
  // Prefere um valor com R$ (dinheiro); senão, o primeiro número que sobrar.
  const comReais = cand.match(/R\$\s*\d[\d.,]*/);
  if (comReais) return comReais[0];
  const m = cand.match(/\d[\d.,]*/);
  return m ? m[0] : null;
}

// acha o valor de uma métrica: mesma linha do rótulo, senão nas próximas ~7 linhas
function achaValor(linhas, matchers, inteiro = false) {
  for (let i = 0; i < linhas.length; i++) {
    const de = semAcento(linhas[i]);
    const rx = matchers.find((r) => r.test(de));
    if (!rx) continue;
    // 1) valor na MESMA linha (depois do rótulo). O rótulo não tem número,
    //    então o 1o número da linha é o valor.
    const mesma = primeiroValorNaLinha(linhas[i]);
    if (mesma && (!inteiro || /^\d[\d.]*$/.test(mesma.replace(/R\$\s*/, "")))) return mesma;
    // 2) próximas linhas, pulando variações puras ("+12%")
    for (let j = i + 1; j < Math.min(i + 7, linhas.length); j++) {
      const bruto = linhas[j].trim();
      if (ehVariacaoPura(bruto)) continue;
      const val = tirarVariacao(bruto);
      if (inteiro) { if (/^\d[\d.]*$/.test(val)) return val; }
      else if (/\d/.test(val)) return val;
    }
  }
  return null;
}

// bodyText = document.body.innerText do painel de GMV Max.
// Retorna {ok:true, custo, pedidos, cpp, receita, roi, ticket, lidos, diag} ou {ok:false, motivo, diag}.
function extractAdsMetrics(bodyText) {
  const todas = String(bodyText || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // Âncora "Visão geral": foca a janela ali, mas cai pra página inteira se não achar.
  let ini = -1;
  for (let i = 0; i < todas.length; i++) {
    if (semAcento(todas[i]).startsWith("visao geral")) { ini = i; break; }
  }
  const achouAncora = ini >= 0;
  const janela = achouAncora ? todas.slice(ini, ini + 80) : todas;

  const raw = {
    cpp:     achaValor(janela, LABELS.cpp),
    custo:   achaValor(janela, LABELS.custo),
    pedidos: achaValor(janela, LABELS.pedidos, true),
    receita: achaValor(janela, LABELS.receita),
    roi:     achaValor(janela, LABELS.roi),
  };

  const lidos = Object.values(raw).filter((v) => v != null).length;
  const diag = {
    achouAncora,
    lidos,
    raw,
    // amostra do texto lido (p/ calibrar quando o layout for diferente do esperado)
    amostra: janela.slice(0, 40),
  };

  if (!achouAncora && lidos < 3) {
    return { ok: false, motivo: "não achei a seção 'Visão geral' (painel não carregou ou layout mudou)", diag };
  }
  if (lidos < 3) {
    return { ok: false, motivo: "li poucos campos do painel — provável falha de carregamento ou layout novo", diag };
  }

  const m = {
    ok: true,
    custo:   parseNum(raw.custo) || 0,
    cpp:     parseNum(raw.cpp) || 0,
    pedidos: Math.round(parseNum(raw.pedidos) || 0),
    receita: parseNum(raw.receita) || 0,
    roi:     parseNum(raw.roi, true) || 0,
    lidos,
    diag,
  };
  // Derivados (quando faltam ou pra completar): ROI = receita/custo; ticket = receita/pedidos.
  if (m.roi === 0 && m.custo > 0 && m.receita > 0) m.roi = Math.round((m.receita / m.custo) * 100) / 100;
  if ((m.cpp === 0) && m.custo > 0 && m.pedidos > 0) m.cpp = Math.round((m.custo / m.pedidos) * 100) / 100;
  m.ticket = m.pedidos > 0 ? Math.round((m.receita / m.pedidos) * 100) / 100 : 0;
  return m;
}

module.exports = { extractAdsMetrics, parseNum, semAcento };
