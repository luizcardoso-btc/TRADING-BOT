/**
 * scanner.js — Motor de análise técnica + geração de sinais automáticos
 * Analisa todos os pares configurados em múltiplos timeframes
 * e emite sinais quando score >= minScore
 */
"use strict";

const { Bybit, Binance, Novadex } = require("./exchanges");
const ind = require("./indicators");
const cfg = require("./config");

const EXCHANGES = { bybit: Bybit, binance: Binance, novadex: Novadex };

// ── Analisa um par em uma exchange e timeframe ─────────────────────
async function analyzePair(symbol, tf = "60", exchange = "bybit") {
  const ex = EXCHANGES[exchange];
  if (!ex) throw new Error(`Exchange desconhecida: ${exchange}`);

  const candles = await ex.candles(symbol, tf, 250);
  if (candles.length < 50) throw new Error(`Candles insuficientes: ${symbol}`);

  const closes  = candles.map(c => c.c);
  const atrVal  = ind.atr(candles);
  const q       = ind.quantScore(closes, candles);
  const fib     = ind.fibonacci(candles);
  const lv      = ind.levels(q.cur, q.dir, atrVal, cfg.risk);

  // MTF: alinhamento EMA200 em outros TFs
  let mtfBull = 0, mtfTotal = 0;
  const otherTFs = tf === "15" ? ["60","240"] : tf === "60" ? ["240","D"] : ["D"];
  await Promise.all(otherTFs.map(async t => {
    try {
      const c2  = await ex.candles(symbol, t, 210);
      const cl2 = c2.map(c => c.c);
      const e200 = ind.ema(cl2, 200).at(-1);
      if (cl2.at(-1) > e200) mtfBull++;
      mtfTotal++;
    } catch {}
  }));
  mtfTotal++; // conta TF atual
  if (q.cur > q.e200) mtfBull++;
  const mtfScore = mtfTotal > 0 ? mtfBull/mtfTotal : 0.5;
  if (mtfScore >= 0.8)       { q.score += 4; q.factors.push("MTF alinhado bull"); }
  else if (mtfScore >= 0.6)  { q.score += 2; }
  else if (mtfScore <= 0.2)  { q.score -= 4; }
  else if (mtfScore <= 0.4)  { q.score -= 2; }

  return {
    symbol, exchange, tf,
    cur:    q.cur,
    score:  q.score,
    prob:   Math.round(50 + (Math.max(-26,Math.min(26,q.score))/26)*45),
    dir:    q.dir,
    factors:q.factors,
    rsi:    q.rsi,
    phase:  q.wy.phase,
    spring: q.wy.spring,
    obBull: !!q.smc.obBull,
    obBear: !!q.smc.obBear,
    bosBull:q.smc.bosBull,
    fvgBull:q.smc.fvgBull,
    volRatio:q.vol.ratio,
    volSpike:q.vol.spike,
    macdBull:q.macd.hist > 0,
    bbBelow: q.cur < q.bb.lower,
    atr:    atrVal,
    fib, ...lv,
    mtfBull, mtfTotal,
    ts: Date.now(),
  };
}

// ── Scan completo de todos os pares ───────────────────────────────────
async function fullScan({ onSignal, onProgress, exchange = cfg.signals.defaultExchange }) {
  const pairs     = cfg.signals.pairs;
  const tf        = cfg.signals.timeframes[1]; // 1h padrão
  const results   = [];
  let   signals   = 0;

  for (let i = 0; i < pairs.length; i += 4) {
    const batch = pairs.slice(i, i+4);
    const res   = await Promise.allSettled(batch.map(p => analyzePair(p, tf, exchange)));

    res.forEach((r, idx) => {
      if (r.status !== "fulfilled") return;
      const a = r.value;
      results.push(a);

      // Emite sinal se score for suficiente
      if (Math.abs(a.score) >= cfg.signals.minScore && a.dir !== "NEUTRO" && a.prob >= cfg.signals.minConfidence) {
        signals++;
        if (onSignal) onSignal(a);
      }
    });

    if (onProgress) onProgress({ done: Math.min(i+4, pairs.length), total: pairs.length, signals });
    await new Promise(r => setTimeout(r, 150)); // evita rate limit
  }

  return { results: results.sort((a,b) => Math.abs(b.score)-Math.abs(a.score)), signals, total: pairs.length };
}

// ── Scan rápido: top 5 pares mais líquidos ──────────────────────────
async function quickScan({ onSignal, exchange = cfg.signals.defaultExchange }) {
  const TOP = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT"];
  const res = await Promise.allSettled(TOP.map(p => analyzePair(p, "60", exchange)));
  res.forEach(r => {
    if (r.status !== "fulfilled") return;
    const a = r.value;
    if (Math.abs(a.score) >= cfg.signals.minScore && a.dir !== "NEUTRO") {
      if (onSignal) onSignal(a);
    }
  });
}

// ── Monitor contínuo (executa a cada N minutos) ─────────────────────
let scanInterval = null;
function startMonitor({ onSignal, onScanDone, intervalMs = 15 * 60 * 1000 }) {
  stopMonitor();
  const run = async () => {
    console.log(`[SCANNER] Iniciando scan — ${new Date().toLocaleTimeString("pt-BR")}`);
    const result = await fullScan({ onSignal, exchange: cfg.signals.defaultExchange }).catch(e => {
      console.error("[SCANNER] Erro:", e.message);
      return null;
    });
    if (result && onScanDone) onScanDone(result);
  };
  run(); // imediato
  scanInterval = setInterval(run, intervalMs);
  return scanInterval;
}

function stopMonitor() {
  if (scanInterval) { clearInterval(scanInterval); scanInterval = null; }
}

module.exports = { analyzePair, fullScan, quickScan, startMonitor, stopMonitor };
