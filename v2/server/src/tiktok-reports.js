// Relatório Semanal por cliente (fonte: Supabase do ELEVATOK — o painel de analytics).
// SOMENTE LEITURA (apenas GET na REST API). Nunca escreve nada no banco.
//
// A URL e a CHAVE do Supabase vêm de variáveis de ambiente (NUNCA hardcoded aqui,
// senão vazariam no repositório):
//   V2_ELEVATOK_URL  = https://xxxx.supabase.co
//   V2_ELEVATOK_KEY  = a chave de leitura (service_role ou read-only)
//
// De onde sai cada métrica (tudo já agregado pelo próprio ELEVATOK):
//   GMV, Pedidos, Amostras + %crescimento -> mv_dashboard_period_cache (period_key=7d,
//        traz `current` e `previous`)
//   Investimento, Receita, ROI            -> ad_spend_products (soma do período)
//   GMV Afiliados / Vídeos                -> mv_analytics_period_cache (cards)
//   Nome do cliente                       -> sellers.display_name
const https = require("https");

const SUPA_URL = (process.env.V2_ELEVATOK_URL || "").replace(/\/+$/, "");
const SUPA_KEY = process.env.V2_ELEVATOK_KEY || "";

function isConfigured() { return !!(SUPA_URL && SUPA_KEY); }

// GET puro na REST API do Supabase. Retorna JSON. Sem métodos de escrita.
function sbGet(pathQuery) {
  return new Promise((resolve, reject) => {
    const url = `${SUPA_URL}/rest/v1/${pathQuery}`;
    const req = https.request(url, {
      method: "GET",
      headers: { apikey: SUPA_KEY, Authorization: "Bearer " + SUPA_KEY, Accept: "application/json" },
      timeout: 30000
    }, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; });
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error("resposta inválida do Supabase")); }
        } else {
          reject(new Error(`Supabase HTTP ${res.statusCode}: ${buf.slice(0, 160)}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("timeout Supabase")); });
    req.end();
  });
}

// ---- formatação BR ----
function brl(cents) {
  const v = (Number(cents) || 0) / 100;
  return "R$ " + v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function inteiro(n) { return (Math.round(Number(n) || 0)).toLocaleString("pt-BR"); }
function numero(n, casas = 2) {
  return (Number(n) || 0).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
}
function variacao(cur, prev) {
  if (!prev) return null;
  return ((cur - prev) / prev) * 100;
}
function linhaVariacao(p) {
  if (p == null || !Number.isFinite(p)) return "";
  const sinal = p >= 0 ? "+" : "-";
  const rotulo = p >= 0 ? "Crescimento" : "Variação";
  return `\n${rotulo}: ${sinal}${numero(Math.abs(p))}%`;
}
function dm(s) { return `${s.slice(8, 10)}/${s.slice(5, 7)}`; }

// Monta a mensagem no formato aprovado. `ads` decide se a seção de Anúncios aparece.
// % inline curto: " (+12,34%)" / " (-5,00%)" / "" (quando nao ha base de comparacao).
function pctInline(cur, prev) {
  if (!prev || cur == null) return "";
  const p = ((cur - prev) / prev) * 100;
  if (!Number.isFinite(p)) return "";
  return ` (${p >= 0 ? "+" : "-"}${numero(Math.abs(p))}%)`;
}
function montarMensagem({ nome, ini, fim, cur, prev, custo, receita, roi,
  afiliados, videosGmv, visAtual, visAnt, convAtual, convAnt, videosCount }) {
  const partes = [
    `Oii! 💚 Seguem as métricas da semana da ${nome} (${dm(ini)} a ${dm(fim)}). Separei por tópicos pra ficar fácil de acompanhar 👇`,
    `\n📊 *Visão geral da loja*\nGMV: ${brl(cur.gmv_cents)}${pctInline(cur.gmv_cents, prev.gmv_cents)}\nPedidos: ${inteiro(cur.order_count)}${pctInline(cur.order_count, prev.order_count)}`
  ];
  // Tráfego e conversão (MEDIA DIARIA do periodo — regra do ETOK: nunca somar visitantes).
  if (visAtual != null) {
    let s = `\n👀 *Tráfego e conversão*\nVisitantes: ${inteiro(visAtual)}/dia (média)${pctInline(visAtual, visAnt)}`;
    if (convAtual != null) s += `\nTaxa de conversão: ${numero(convAtual)}%${pctInline(convAtual, convAnt)}`;
    partes.push(s);
  }
  // Anúncios: só entra se houve investimento (cliente sem ADS não vira "R$ 0 / ROI 0").
  if (custo > 0) {
    partes.push(`\n📣 *Anúncios (GMV Max)*\nInvestimento: ${brl(custo)}\nReceita bruta: ${brl(receita)}\nROI: ${numero(roi)}`);
  }
  if (afiliados > 0) partes.push(`\n🤝 *Afiliados*\nGMV atribuído: ${brl(afiliados)}`);
  // Vídeos publicados: contagem (mostra mesmo sendo 0). GMV de vídeos como apoio, se houver.
  if (videosCount != null) {
    let s = `\n🎬 *Vídeos*\nForam ${inteiro(videosCount)} vídeo(s) publicado(s) no período.`;
    if (videosGmv > 0) s += `\nGMV de vídeos: ${brl(videosGmv)}`;
    partes.push(s);
  } else if (videosGmv > 0) {
    partes.push(`\n🎬 *Vídeos*\nGMV: ${brl(videosGmv)}`);
  }
  partes.push(`\n📦 *Amostras enviadas*\nTotal: ${inteiro(cur.sample_count)}${pctInline(cur.sample_count, prev.sample_count)}`);
  partes.push(`\n⏳ *Observação sobre as datas*\nAfiliados, vídeos e amostras o TikTok fecha com ~2 dias de defasagem, então essas valem até por volta de 2 dias atrás 🗓️`);
  partes.push(`\nQualquer dúvida sobre algum ponto é só me chamar que eu explico com calma 😊`);
  return partes.join("\n");
}

// Gera os relatórios semanais de TODOS os clientes com dados na última janela de 7 dias.
// Retorna { ok, geradoEm, clientes: [{ sellerId, nome, inicio, fim, metrics, mensagem }] }.
async function buildWeeklyReports() {
  if (!isConfigured()) {
    return { ok: false, error: "not-configured", detail: "Defina V2_ELEVATOK_URL e V2_ELEVATOK_KEY no servidor." };
  }
  const [sellersRaw, dashRaw, analRaw] = await Promise.all([
    sbGet("sellers?select=id,display_name,internal_label"),
    sbGet("mv_dashboard_period_cache?period_key=eq.7d&select=seller_id,start_date,end_date,previous_start_date,previous_end_date,refreshed_at,payload"),
    sbGet("mv_analytics_period_cache?period_key=eq.7d&select=seller_id,payload")
  ]);
  const nomes = {};
  for (const s of sellersRaw) nomes[s.id] = s.display_name || s.internal_label || "Cliente";
  const anal = {};
  for (const a of analRaw) anal[a.seller_id] = a.payload || {};

  // Dedup: mantém só a janela de 7 dias MAIS RECENTE por cliente.
  const maisRecente = {};
  for (const r of dashRaw) {
    const k = r.seller_id;
    const cmp = [r.end_date, r.refreshed_at || ""].join("|");
    if (!maisRecente[k] || cmp > [maisRecente[k].end_date, maisRecente[k].refreshed_at || ""].join("|")) {
      maisRecente[k] = r;
    }
  }

  const clientes = [];
  for (const r of Object.values(maisRecente)) {
    const cur = (r.payload && r.payload.current) || {};
    if (!cur.gmv_cents) continue; // sem GMV = sem movimento -> pula
    const prev = (r.payload && r.payload.previous) || {};
    const sid = r.seller_id, ini = r.start_date, fim = r.end_date;

    // ADS do período (soma). Uma consulta por cliente (poucos por semana).
    let custo = 0, receita = 0;
    try {
      const ads = await sbGet(`ad_spend_products?seller_id=eq.${sid}&spend_date=gte.${ini}&spend_date=lte.${fim}&select=spend_cents,gross_revenue_cents&limit=5000`);
      for (const a of ads) { custo += a.spend_cents || 0; receita += a.gross_revenue_cents || 0; }
    } catch { /* sem ads -> fica 0 */ }
    const roi = custo ? receita / custo : 0;

    const cards = {};
    for (const c of ((anal[sid] && anal[sid].cards) || [])) cards[c.key] = c;
    const afiliados = ["affiliate_organic", "affiliate_ads", "live_affiliates"]
      .reduce((s, k) => s + ((cards[k] && cards[k].revenueCents) || 0), 0);
    const videosGmv = (cards.content && cards.content.revenueCents) || 0;

    // TRAFEGO: Visitantes e Conversao vem do tiktok_shop_content_daily_agg (diario).
    // REGRA DO ETOK: NUNCA somar visitantes entre dias (a mesma pessoa reconta todo dia)
    // -> usar a MEDIA DIARIA do periodo. Conversao = media dos dias * 100 (vem em fracao).
    // So dias fechados (is_ready) e nao-nulos. Pega o periodo atual E o anterior (p/ %).
    const prevIni = r.previous_start_date || ini, prevFim = r.previous_end_date || fim;
    let visAtual = null, visAnt = null, convAtual = null, convAnt = null;
    try {
      const dias = await sbGet(`tiktok_shop_content_daily_agg?seller_id=eq.${sid}&sale_date=gte.${prevIni}&sale_date=lte.${fim}&is_ready=eq.true&avg_visitors=not.is.null&select=sale_date,avg_visitors,conversion_rate&limit=200`);
      const noPeriodo = (a, b) => dias.filter((d) => d.sale_date >= a && d.sale_date <= b);
      const mediaVis = (arr) => arr.length ? Math.round(arr.reduce((s, d) => s + (d.avg_visitors || 0), 0) / arr.length) : null;
      const mediaConv = (arr) => arr.length ? (arr.reduce((s, d) => s + (d.conversion_rate || 0), 0) / arr.length) * 100 : null;
      const cAtual = noPeriodo(ini, fim), cAnt = noPeriodo(prevIni, prevFim);
      visAtual = mediaVis(cAtual); visAnt = mediaVis(cAnt);
      convAtual = mediaConv(cAtual); convAnt = mediaConv(cAnt);
    } catch { /* sem trafego -> omite a secao */ }

    // VIDEOS publicados no periodo: contagem DISTINTA de video_id (tabela nova).
    // O PostgREST corta ~1000 linhas por pagina -> PAGINA (offset) e junta num Set,
    // senao contas grandes travavam em 1000. Teto de 20 paginas (seguranca).
    let videosCount = null;
    try {
      const ids = new Set();
      for (let off = 0; off < 20000; off += 1000) {
        const vids = await sbGet(`tiktok_shop_video_daily_agg?seller_id=eq.${sid}&sale_date=gte.${ini}&sale_date=lte.${fim}&select=video_id&limit=1000&offset=${off}`);
        vids.forEach((v) => ids.add(v.video_id));
        if (vids.length < 1000) break;
      }
      videosCount = ids.size;
    } catch { /* sem dados de video */ }

    const mensagem = montarMensagem({
      nome: nomes[sid] || "Cliente", ini, fim, cur, prev, custo, receita, roi,
      afiliados, videosGmv, visAtual, visAnt, convAtual, convAnt, videosCount
    });
    clientes.push({
      sellerId: sid,
      nome: nomes[sid] || "Cliente",
      inicio: ini, fim,
      metrics: {
        gmv_cents: cur.gmv_cents || 0, pedidos: cur.order_count || 0, amostras: cur.sample_count || 0,
        ads_custo_cents: custo, ads_receita_cents: receita, roi,
        afiliados_cents: afiliados, videos_gmv_cents: videosGmv,
        visitantes: visAtual, conversao: convAtual, videos: videosCount
      },
      mensagem
    });
  }
  clientes.sort((a, b) => b.metrics.gmv_cents - a.metrics.gmv_cents);
  return { ok: true, geradoEm: new Date().toISOString(), total: clientes.length, clientes };
}

module.exports = { buildWeeklyReports, isConfigured };
