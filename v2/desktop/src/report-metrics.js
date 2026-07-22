// Leitura das métricas do relatório do cliente (TikTok Seller) a partir do TEXTO das
// páginas (mesmo método robusto do ads-metrics.js: rótulos + formato BR, sem OCR).
// São 4 seções, cada uma numa página do Seller:
//   1) Visão Geral        -> GMV, Pedidos, Visitantes, Taxa de Conversão
//   2) MKT > Anúncios      -> Custo, Receita, ROI   (usa extractAdsMetrics do ads-metrics.js)
//   3) Afiliados > Desempenho -> GMV atribuído ao criador, GMV de Vídeos
//   4) Afiliados > Amostras   -> quantas amostras enviadas
//
// IMPORTANTE: os rótulos abaixo são o MELHOR palpite pelos nomes do painel PT-BR.
// Cada extract() devolve tambem um `diag` com uma amostra do texto lido -> a gente
// CALIBRA nos rótulos reais de UMA conta (igual foi feito no ADS), sem chutar no escuro.
const { parseNum, semAcento, achaValor, extractAdsMetrics } = require("./ads-metrics");

function linhas(bodyText) {
  return String(bodyText || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// ---- 1) Visão Geral ----
const LB_VISAO = {
  gmv:       [/^gmv\b/, /^receita( bruta| total)?\b/, /^faturamento\b/, /^valor bruto\b/, /^vendas( brutas)?\b/],
  pedidos:   [/^pedidos( pagos| totais| brutos)?\b/, /^total de pedidos\b/, /^numero de pedidos\b/],
  visitantes:[/^visitantes( unicos)?\b/, /^visitas\b/, /^visitantes\b/, /^trafego\b/],
  conversao: [/^taxa de conversao\b/, /^conversao\b/, /^taxa de conv\b/, /^conv\.?\b/],
};
// Conversão é uma % DE VERDADE (ex.: 2,35 %) -> o achaValor comum descartaria por
// achar que "%" é a variação. Aqui pegamos o número seguido de % perto do rótulo.
function achaConversao(ls, matchers) {
  for (let i = 0; i < ls.length; i++) {
    if (!matchers.find((r) => r.test(semAcento(ls[i])))) continue;
    for (let j = i; j < Math.min(i + 4, ls.length); j++) {
      const m = ls[j].match(/(\d+[.,]\d+|\d+)\s*%/);
      if (m) return m[1];
    }
  }
  return null;
}
function extractVisaoGeral(bodyText) {
  const ls = linhas(bodyText);
  const raw = {
    gmv:        achaValor(ls, LB_VISAO.gmv),
    pedidos:    achaValor(ls, LB_VISAO.pedidos, true),
    visitantes: achaValor(ls, LB_VISAO.visitantes, true),
    conversao:  achaConversao(ls, LB_VISAO.conversao),
  };
  const lidos = Object.values(raw).filter((v) => v != null).length;
  return {
    ok: lidos >= 2,
    gmv:        parseNum(raw.gmv) || 0,
    pedidos:    Math.round(parseNum(raw.pedidos) || 0),
    visitantes: Math.round(parseNum(raw.visitantes) || 0),
    conversao:  parseNum(raw.conversao, true) || 0,   // taxa (ex.: 2,35 %)
    lidos,
    diag: { raw, amostra: ls.slice(0, 40) },
  };
}

// ---- 3) Afiliados > Desempenho ----
const LB_AFIL = {
  gmvAtribuido: [/^gmv atribuido( ao criador)?\b/, /^gmv do criador\b/, /^gmv de afiliados\b/, /^gmv atribuido\b/],
  videosGmv:    [/^gmv de videos\b/, /^gmv \(videos\)\b/, /^videos\b/, /^gmv por video\b/],
};
function extractAfiliados(bodyText) {
  const ls = linhas(bodyText);
  const raw = {
    gmvAtribuido: achaValor(ls, LB_AFIL.gmvAtribuido),
    videosGmv:    achaValor(ls, LB_AFIL.videosGmv),
  };
  const lidos = Object.values(raw).filter((v) => v != null).length;
  return {
    ok: lidos >= 1,
    gmvAtribuido: parseNum(raw.gmvAtribuido) || 0,
    videosGmv:    parseNum(raw.videosGmv) || 0,
    lidos,
    diag: { raw, amostra: ls.slice(0, 40) },
  };
}

// ---- 4) Afiliados > Amostras ----
const LB_AMOSTRAS = {
  enviadas: [/^amostras enviadas\b/, /^amostras( totais)?\b/, /^enviadas\b/, /^total de amostras\b/, /^solicitacoes enviadas\b/],
};
function extractAmostras(bodyText) {
  const ls = linhas(bodyText);
  const raw = { enviadas: achaValor(ls, LB_AMOSTRAS.enviadas, true) };
  const n = Math.round(parseNum(raw.enviadas) || 0);
  return { ok: raw.enviadas != null, enviadas: n, diag: { raw, amostra: ls.slice(0, 40) } };
}

// ---- Formatação BR ----
function fmtBRL(n) {
  const v = Number(n) || 0;
  return "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtInt(n) {
  return (Math.round(Number(n) || 0)).toLocaleString("pt-BR");
}
function fmtNum(n, casas = 2) {
  return (Number(n) || 0).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
}
// linha de crescimento opcional (só aparece se veio o %). p pode ser + ou -.
function linhaCrescimento(p) {
  if (p == null || !Number.isFinite(Number(p))) return "";
  const v = Number(p);
  const sinal = v >= 0 ? "+" : "";
  const rotulo = v >= 0 ? "Crescimento" : "Variação";
  return `\n${rotulo}: ${sinal}${fmtNum(v)}%`;
}

// Monta a MENSAGEM final (formato do exemplo aprovado). `cresc` é opcional por métrica.
// dados = { visao, ads, afiliados, amostras }, cada um o objeto dos extract*() (ou null).
function buildReport({ tipo = "mensal", inicio = "", fim = "", dados = {}, cresc = {} } = {}) {
  const { visao, ads, afiliados, amostras } = dados;
  const saud = tipo === "semanal"
    ? `Oii! 💚 Segue o resumo da semana da loja (${inicio} a ${fim}). Separei por tópicos pra ficar fácil de acompanhar 👇`
    : `Oii! 💚 Trouxe o panorama da loja do dia ${inicio} até ${fim}. Separei por tópicos pra ficar fácil de acompanhar 👇`;
  const partes = [saud];

  if (visao) {
    let s = `\n📊 *Visão geral da loja*\nGMV: ${fmtBRL(visao.gmv)}\nPedidos: ${fmtInt(visao.pedidos)}`;
    if (visao.visitantes) s += `\nVisitantes: ${fmtInt(visao.visitantes)}`;
    if (visao.conversao)  s += `\nTaxa de conversão: ${fmtNum(visao.conversao)}%`;
    s += linhaCrescimento(cresc.gmv);
    partes.push(s);
  }
  if (ads) {
    partes.push(`\n📣 *Anúncios (GMV Max)*\nInvestimento: ${fmtBRL(ads.custo)}\nReceita bruta: ${fmtBRL(ads.receita)}\nROI: ${fmtNum(ads.roi)}\nOu seja, cada R$ 1 investido está voltando ${fmtBRL(ads.roi).replace("R$ ", "R$ ")}.`);
  }
  if (afiliados) {
    let s = `\n🤝 *Afiliados*\nGMV atribuído: ${fmtBRL(afiliados.gmvAtribuido)}`;
    s += linhaCrescimento(cresc.gmvAtribuido);
    partes.push(s);
    if (afiliados.videosGmv) {
      partes.push(`\n🎬 *Vídeos*\nGMV: ${fmtBRL(afiliados.videosGmv)}${linhaCrescimento(cresc.videosGmv)}`);
    }
  }
  if (amostras) {
    partes.push(`\n📦 *Amostras enviadas*\nTotal: ${fmtInt(amostras.enviadas)}${linhaCrescimento(cresc.amostras)}`);
  }
  partes.push(`\n⏳ *Observação sobre as datas*\nOs números de afiliados, vídeos e amostras o TikTok fecha com ~2 dias de defasagem, então essas três valem até por volta de 2 dias atrás 🗓️`);
  partes.push(`\nQualquer dúvida sobre algum ponto é só me chamar que eu explico com calma 😊`);
  return partes.join("\n");
}

module.exports = { extractVisaoGeral, extractAfiliados, extractAmostras, extractAdsMetrics, buildReport, fmtBRL, fmtInt, fmtNum };
