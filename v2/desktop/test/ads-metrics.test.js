// Testa o parser do Relatorio de ADS (ads-metrics.js). Roda com: node --test
const { test } = require("node:test");
const assert = require("node:assert");
const { extractAdsMetrics, parseNum } = require("../src/ads-metrics");

test("parseNum: BR (1.234,56), decimal, milhar, lixo -> null", () => {
  assert.strictEqual(parseNum("R$ 1.234,56"), 1234.56);
  assert.strictEqual(parseNum("1.234"), 1234);        // milhar BR
  assert.strictEqual(parseNum("12,50"), 12.5);
  assert.strictEqual(parseNum("4.05", true), 4.05);   // decimalPonto (ROI/ROAS)
  assert.strictEqual(parseNum("--"), null);           // lixo NAO vira 0
  assert.strictEqual(parseNum(""), null);
  assert.strictEqual(parseNum(null), null);
});

test("extractAdsMetrics: painel tipico -> numeros certos", () => {
  const txt = [
    "Visão geral",
    "Custo", "R$ 1.234,56",
    "Pedidos pagos", "42",
    "Receita", "R$ 5.000,00",
    "ROI", "4.05"
  ].join("\n");
  const m = extractAdsMetrics(txt);
  assert.strictEqual(m.ok, true);
  assert.strictEqual(m.custo, 1234.56);
  assert.strictEqual(m.pedidos, 42);
  assert.strictEqual(m.receita, 5000);
  assert.strictEqual(m.roi, 4.05);
});

test("extractAdsMetrics: ignora ruido de intervalo '(7 dias)' no rotulo", () => {
  const txt = [
    "Visão geral",
    "Custo (7 dias) R$ 1.234,56",
    "Pedidos pagos 42",
    "Receita R$ 5.000,00",
    "ROI 4.05"
  ].join("\n");
  const m = extractAdsMetrics(txt);
  assert.strictEqual(m.ok, true);
  assert.strictEqual(m.custo, 1234.56, "nao pode pegar o '7' de '(7 dias)'");
  assert.strictEqual(m.pedidos, 42);
});

test("extractAdsMetrics: deriva ROI e ticket quando faltam", () => {
  const txt = ["Visão geral", "Custo", "R$ 1.000,00", "Pedidos pagos", "10", "Receita", "R$ 8.000,00"].join("\n");
  const m = extractAdsMetrics(txt);
  assert.strictEqual(m.ok, true);
  assert.strictEqual(m.roi, 8, "ROI = receita/custo");
  assert.strictEqual(m.ticket, 800, "ticket = receita/pedidos");
});

test("extractAdsMetrics: painel que nao carregou -> erro explicito (nao R$ 0)", () => {
  const m = extractAdsMetrics("Carregando...\nAlguma coisa");
  assert.strictEqual(m.ok, false);
  assert.ok(m.motivo && m.motivo.length > 0);
});
