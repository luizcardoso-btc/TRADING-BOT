/**
 * index.js — Servidor principal do ACS Trading Bot
 * API REST + WebSocket + dashboard web
 */
"use strict";

const express  = require("express");
const http     = require("http");
const path     = require("path");
const { WebSocketServer } = require("ws");
const cfg      = require("./config");
const scanner  = require("./scanner");
const arb      = require("./arbitrage");
const executor = require("./executor");
const risk     = require("./risk");
const { Bybit, Binance, Novadex } = require("./exchanges");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(__dirname));

// ── Estado global ─────────────────────────────────────────────────────
const state = {
  signals:       [],
  arb:           [],
  scanRunning:   false,
  scanMode:      null,
  lastScan:      null,
  stats: { signalsSent:0, arbFound:0, tradesExecuted:0, winRate:0 },
};

// ── WebSocket ─────────────────────────────────────────────────────────
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

wss.on("connection", ws => {
  ws.send(JSON.stringify({ type:"init", data:{
    signals:  state.signals.slice(0,30),
    arb:      state.arb.slice(0,20),
    stats:    state.stats,
    risk:     risk.status(),
    config: {
      pairs:      cfg.signals.pairs.length,
      exchange:   cfg.signals.defaultExchange,
      minScore:   cfg.signals.minScore,
      leverage:   cfg.signals.defaultLeverage,
      autoExecute: cfg.signals.autoExecute,
    },
  }, ts: Date.now() }));
  ws.on("error", () => {});
});

// ── Handlers de sinal e arbitragem ───────────────────────────────────
async function onSignal(analysis) {
  const sig = { id: Date.now(), ...analysis, source:"scanner" };
  state.signals.unshift(sig);
  if (state.signals.length > 200) state.signals.length = 200;
  state.stats.signalsSent++;
  broadcast("signal", sig);

  // Execução automática
  if (cfg.signals.autoExecute) {
    try {
      const bal = await Bybit.balance().then(b=>b.availableBalance).catch(()=>1000);
      const res = await executor.executeSignal(sig, bal);
      broadcast("trade", { signal:sig, result:res });
      if (res.ok) state.stats.tradesExecuted++;
    } catch(e) { broadcast("error", { msg:e.message }); }
  }
}

function onArb(opp) {
  const o = { id: Date.now(), ...opp };
  state.arb.unshift(o);
  if (state.arb.length > 100) state.arb.length = 100;
  state.stats.arbFound++;
  broadcast("arb", o);

  if (cfg.arb.autoExecute) {
    executor.executeArb(o).then(r => broadcast("arb_trade", { opp:o, result:r })).catch(()=>{});
  }
}

// ── ROTAS API ─────────────────────────────────────────────────────────

// Auth middleware
const auth = (req,res,next) => {
  const key = req.headers["x-admin-key"] || req.query.key;
  if (key !== cfg.adminKey) return res.status(401).json({ error:"Chave inválida" });
  next();
};

// Inicia scanner
app.post("/api/scan/start", auth, async (req,res) => {
  if (state.scanRunning) return res.json({ ok:false, msg:"Scan já em andamento" });
  const { mode="full", exchange=cfg.signals.defaultExchange } = req.body||{};
  state.scanRunning = true; state.scanMode = mode;
  broadcast("scan_start", { mode, exchange });
  res.json({ ok:true, mode, exchange });

  try {
    if (mode === "quick") {
      await scanner.quickScan({ onSignal, exchange });
    } else {
      await scanner.fullScan({
        onSignal, exchange,
        onProgress: p => broadcast("scan_progress", p),
      });
    }
    state.lastScan = new Date().toISOString();
  } catch(e) { broadcast("scan_error", { msg:e.message }); }
  finally { state.scanRunning = false; broadcast("scan_done", { ts: state.lastScan }); }
});

// Para scanner
app.post("/api/scan/stop", auth, (req,res) => {
  scanner.stopMonitor();
  state.scanRunning = false;
  res.json({ ok:true });
});

// Auto-scanner (a cada 15 minutos)
app.post("/api/scan/auto", auth, (req,res) => {
  const { enable=true, intervalMin=15 } = req.body||{};
  if (enable) {
    scanner.startMonitor({ onSignal, onScanDone: r => broadcast("scan_done", r), intervalMs: intervalMin*60000 });
    res.json({ ok:true, auto:true, intervalMin });
  } else {
    scanner.stopMonitor();
    res.json({ ok:true, auto:false });
  }
});

// Lista sinais
app.get("/api/signals", auth, (req,res) => {
  const dir = req.query.dir;
  let sigs = state.signals;
  if (dir) sigs = sigs.filter(s => s.dir === dir.toUpperCase());
  res.json({ signals: sigs.slice(0, 50), total: state.signals.length });
});

// Scan de arbitragem
app.post("/api/arb/scan", auth, async (req,res) => {
  broadcast("arb_scan_start", {});
  res.json({ ok:true, msg:"Scan de arbitragem iniciado" });
  const result = await arb.fullArbScan(onArb).catch(e=>({ error:e.message }));
  broadcast("arb_scan_done", result);
});

// Lista oportunidades de arb
app.get("/api/arb", auth, (req,res) => {
  res.json({ opportunities: state.arb.slice(0,30), total: state.arb.length });
});

// Executa sinal manualmente
app.post("/api/execute/signal", auth, async (req,res) => {
  const { signalId, balanceUSD=1000 } = req.body||{};
  const sig = state.signals.find(s => s.id === signalId);
  if (!sig) return res.status(404).json({ error:"Sinal não encontrado" });
  const result = await executor.executeSignal(sig, balanceUSD);
  res.json(result);
});

// Executa arb manualmente
app.post("/api/execute/arb", auth, async (req,res) => {
  const { oppId } = req.body||{};
  const opp = state.arb.find(o => o.id === oppId);
  if (!opp) return res.status(404).json({ error:"Oportunidade não encontrada" });
  const result = await executor.executeArb(opp);
  res.json(result);
});

// Análise de um par específico
app.get("/api/analyze/:symbol", auth, async (req,res) => {
  const { symbol } = req.params;
  const { tf="60", exchange=cfg.signals.defaultExchange } = req.query;
  try {
    const analysis = await scanner.analyzePair(symbol.toUpperCase(), tf, exchange);
    res.json({ ok:true, analysis });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// Saldo das exchanges
app.get("/api/balances", auth, async (req,res) => {
  const [bybit, binance, novadex] = await Promise.allSettled([
    Bybit.balance(), Binance.balance(), Novadex.balance(),
  ]);
  res.json({
    bybit:   bybit.value   || { error: bybit.reason?.message },
    binance: binance.value || { error: binance.reason?.message },
    novadex: novadex.value || { error: novadex.reason?.message },
  });
});

// Posições abertas
app.get("/api/positions", auth, async (req,res) => {
  const [bybit, binance, novadex] = await Promise.allSettled([
    Bybit.positions(), Binance.positions(), Novadex.positions(),
  ]);
  const all = [
    ...(bybit.value   || []),
    ...(binance.value || []),
    ...(novadex.value || []),
  ];
  res.json({ positions: all, riskStatus: risk.status() });
});

// Status geral e risco
app.get("/api/status", auth, (req,res) => {
  res.json({
    scanRunning: state.scanRunning,
    scanMode:    state.scanMode,
    lastScan:    state.lastScan,
    stats:       state.stats,
    risk:        risk.status(),
    signals:     state.signals.length,
    arb:         state.arb.length,
    tradeLog:    executor.tradeLog.slice(0,20),
    config: {
      autoExecuteSignals: cfg.signals.autoExecute,
      autoExecuteArb:     cfg.arb.autoExecute,
      minScore:           cfg.signals.minScore,
      leverage:           cfg.signals.defaultLeverage,
      maxPositionUSD:     cfg.risk.maxPositionSizeUSD,
      maxDailyLoss:       cfg.risk.maxDailyLoss,
    },
  });
});

// Log de ordens
app.get("/api/trades", auth, (req,res) => {
  res.json({ trades: executor.tradeLog });
});

// Health check
app.get("/health", (req,res) => res.json({
  ok: true, uptime: Math.floor(process.uptime())+"s",
  signals: state.signals.length, arb: state.arb.length,
  memory: Math.round(process.memoryUsage().heapUsed/1024/1024)+"MB",
}));

// Frontend
app.get("/", (req,res) => res.sendFile(path.join(__dirname, "dashboard.html")));

// ── Inicialização ──────────────────────────────────────────────────────
server.listen(cfg.port, () => {
  console.log(`\n╔═══════════════════════════════════════╗`);
  console.log(`║  ACS Trading Bot — rodando na :${cfg.port}  ║`);
  console.log(`╠═══════════════════════════════════════╣`);
  console.log(`║  Exchanges: Bybit · Binance · Novadex ║`);
  console.log(`║  Auto-scan: ${cfg.signals.autoExecute?"ATIVO":"desativado"} (sinais)           ║`);
  console.log(`║  Auto-arb:  ${cfg.arb.autoExecute?"ATIVO":"desativado"} (arbitragem)      ║`);
  console.log(`╚═══════════════════════════════════════╝\n`);

  // Inicia monitor de posições
  executor.startMonitor();

  // Scan automático a cada 15 minutos se habilitado
  if (process.env.AUTO_SCAN_START === "true") {
    setTimeout(() => {
      scanner.startMonitor({ onSignal, onScanDone: r => broadcast("scan_done", r), intervalMs: 15*60*1000 });
      console.log("[BOT] Auto-scan iniciado (15 min)");
    }, 3000);
  }
});

module.exports = { app, server };
