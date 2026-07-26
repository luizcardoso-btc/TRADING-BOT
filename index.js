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
const { Bybit, Binance, Novadex, testBybitConnectivity } = require("./exchanges");

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
        onProgress:   p  => broadcast("scan_progress", p),
        onPairResult: pr => broadcast("pair_result",   pr),
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


// Scanner ao vivo — visualizador animado
const SCANNER_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>ACS · Scanner PRO</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Space+Grotesk:wght@400;500;600;700&family=Orbitron:wght@700;800;900&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
:root{
  --bg:#010308;--bg2:#04070F;--bg3:#080D1A;--bg4:#0D1425;
  --green:#00FF88;--green2:#00CC6A;--red:#FF2D55;--gold:#FFB800;
  --blue:#0EA5E9;--blue2:#38BDF8;--purple:#8B5CF6;--cyan:#06B6D4;
  --orange:#F97316;--pink:#EC4899;
  --text:#94A3B8;--dim:#334155;--dim2:#1E293B;
  --line:rgba(255,255,255,.04);--line2:rgba(255,255,255,.08);
  --mono:'JetBrains Mono',monospace;
  --disp:'Orbitron',monospace;
  --body:'Space Grotesk',sans-serif;
  --glow-g:0 0 20px rgba(0,255,136,.3);
  --glow-b:0 0 20px rgba(14,165,233,.3);
}
body{background:var(--bg);color:var(--text);font-family:var(--body);min-height:100vh;overflow-x:hidden;}

/* GRID LINES BG */
body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(0,255,136,.015) 1px,transparent 1px),linear-gradient(90deg,rgba(0,255,136,.015) 1px,transparent 1px);background-size:40px 40px;pointer-events:none;z-index:0;}

/* CANVAS PARTICLES */
#canvas{position:fixed;inset:0;pointer-events:none;z-index:1;}

/* TOPBAR */
.topbar{position:sticky;top:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:10px 20px;background:rgba(1,3,8,.95);border-bottom:1px solid var(--line2);backdrop-filter:blur(20px);}
.tb-logo{display:flex;align-items:center;gap:10px;}
.tb-logo-text{font-family:var(--disp);font-size:14px;font-weight:900;color:#fff;letter-spacing:2px;}
.tb-logo-text span{color:var(--green);}
.tb-live{display:flex;align-items:center;gap:6px;background:rgba(0,255,136,.06);border:1px solid rgba(0,255,136,.2);border-radius:4px;padding:4px 10px;font-family:var(--mono);font-size:8px;color:var(--green);letter-spacing:2px;}
.tb-live-dot{width:5px;height:5px;border-radius:50%;background:var(--green);animation:glow 1.5s infinite;}
@keyframes glow{0%,100%{box-shadow:0 0 4px var(--green)}50%{box-shadow:0 0 16px var(--green),0 0 32px rgba(0,255,136,.5)}}
.tb-center{display:flex;gap:8px;}
.tb-stat{font-family:var(--mono);font-size:9px;background:var(--bg3);border:1px solid var(--line2);border-radius:4px;padding:3px 10px;color:var(--dim);}
.tb-stat b{color:#fff;}
.tb-right{display:flex;align-items:center;gap:10px;}
.ws-ind{width:8px;height:8px;border-radius:50%;background:var(--red);transition:.3s;}
.ws-ind.on{background:var(--green);box-shadow:var(--glow-g);}
.btn-sm{padding:6px 14px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;border:none;font-family:var(--mono);transition:.15s;letter-spacing:.5px;}
.btn-connect{background:var(--green);color:#000;}
.btn-connect:hover{background:var(--green2);}
.btn-scan{background:rgba(0,255,136,.1);color:var(--green);border:1px solid rgba(0,255,136,.25);}
.btn-scan:hover{background:rgba(0,255,136,.18);}
.btn-scan:disabled{opacity:.35;cursor:not-allowed;}
.btn-auto{background:rgba(14,165,233,.1);color:var(--blue2);border:1px solid rgba(14,165,233,.25);}
.btn-auto.active{background:rgba(255,45,85,.1);color:var(--red);border-color:rgba(255,45,85,.25);}

/* CONNECT MODAL */
#connectModal{position:fixed;inset:0;background:rgba(1,3,8,.92);z-index:200;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);}
.modal-card{background:var(--bg2);border:1px solid var(--line2);border-radius:16px;padding:36px;width:420px;position:relative;}
.modal-card::before{content:'';position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,var(--green),transparent);}
.modal-title{font-family:var(--disp);font-size:16px;font-weight:900;color:#fff;letter-spacing:2px;margin-bottom:6px;}
.modal-sub{font-size:12px;color:var(--dim);margin-bottom:24px;line-height:1.6;}
.modal-label{font-family:var(--mono);font-size:8px;color:var(--dim);letter-spacing:1.5px;margin-bottom:5px;display:block;}
.modal-input{width:100%;background:var(--bg3);border:1px solid var(--line2);border-radius:8px;padding:10px 14px;color:#fff;font-family:var(--mono);font-size:12px;outline:none;margin-bottom:12px;transition:.2s;}
.modal-input:focus{border-color:rgba(0,255,136,.4);}
.modal-btn{width:100%;background:linear-gradient(135deg,var(--green),var(--blue));color:#000;border:none;border-radius:8px;padding:12px;font-weight:700;font-size:13px;cursor:pointer;font-family:var(--body);letter-spacing:.5px;transition:.15s;margin-top:4px;}
.modal-btn:hover{filter:brightness(1.1);}
.modal-err{font-family:var(--mono);font-size:10px;color:var(--red);min-height:14px;margin-top:4px;}
.modal-skip{font-family:var(--mono);font-size:9px;color:var(--dim);text-align:center;margin-top:10px;cursor:pointer;text-decoration:underline;}
.modal-skip:hover{color:var(--text);}

/* MAIN LAYOUT */
.main{position:relative;z-index:5;display:grid;grid-template-columns:1fr 1fr 360px;gap:12px;padding:14px 18px;height:calc(100vh - 52px);}

/* LEFT: MAP + PROGRESS */
.left-col{display:flex;flex-direction:column;gap:12px;overflow:hidden;}

/* SCAN PROGRESS */
.prog-panel{background:var(--bg2);border:1px solid var(--line2);border-radius:12px;padding:14px;display:none;flex-shrink:0;}
.prog-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
.prog-title{font-family:var(--mono);font-size:8px;color:var(--dim);letter-spacing:2px;}
.prog-pct{font-family:var(--disp);font-size:22px;font-weight:900;color:var(--green);}
.prog-bar-wrap{height:3px;background:var(--dim2);border-radius:2px;overflow:hidden;margin-bottom:8px;position:relative;}
.prog-bar-fill{height:100%;background:linear-gradient(90deg,var(--green),var(--cyan),var(--blue));border-radius:2px;transition:width .4s ease;position:relative;}
.prog-bar-fill::after{content:'';position:absolute;right:-4px;top:-4px;width:10px;height:10px;border-radius:50%;background:var(--green);box-shadow:var(--glow-g);}
.prog-stats{display:flex;gap:16px;}
.prog-stat{font-family:var(--mono);font-size:9px;color:var(--dim);}
.prog-stat b{color:#fff;}
.prog-scanning{display:flex;gap:4px;flex-wrap:wrap;margin-top:8px;}
.scan-chip{font-family:var(--mono);font-size:8px;background:rgba(0,255,136,.05);border:1px solid rgba(0,255,136,.2);color:var(--green);padding:2px 7px;border-radius:3px;animation:chipPulse .7s infinite alternate;}
@keyframes chipPulse{from{opacity:.5;border-color:rgba(0,255,136,.15)}to{opacity:1;border-color:rgba(0,255,136,.5)}}

/* PAIR MAP */
.map-panel{background:var(--bg2);border:1px solid var(--line2);border-radius:12px;overflow:hidden;flex:1;display:flex;flex-direction:column;min-height:0;}
.map-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--line);flex-shrink:0;}
.map-title{font-family:var(--mono);font-size:8px;color:var(--dim);letter-spacing:2px;}
.map-legend{display:flex;gap:10px;}
.ml-item{display:flex;align-items:center;gap:4px;font-family:var(--mono);font-size:7px;color:var(--dim);}
.ml-dot{width:6px;height:6px;border-radius:50%;}
/* Heatmap */
.heatmap{display:flex;gap:2px;padding:6px 14px;align-items:flex-end;height:36px;flex-shrink:0;border-bottom:1px solid var(--line);}
.hm-col{flex:1;border-radius:2px 2px 0 0;transition:all .5s;cursor:pointer;min-width:4px;}
/* Filter row */
.filter-row{display:flex;gap:4px;padding:6px 14px;border-bottom:1px solid var(--line);flex-shrink:0;}
.fr-btn{font-family:var(--mono);font-size:8px;padding:2px 8px;border-radius:3px;border:1px solid var(--line2);color:var(--dim);cursor:pointer;background:transparent;transition:.15s;}
.fr-btn.on{background:rgba(14,165,233,.1);border-color:rgba(14,165,233,.3);color:var(--blue2);}
/* Grid */
.pair-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:5px;padding:10px;overflow-y:auto;flex:1;scrollbar-width:thin;scrollbar-color:var(--dim2) transparent;}

/* PAIR CARD */
.pc{background:var(--bg3);border:1px solid var(--line);border-radius:7px;padding:8px;cursor:pointer;transition:all .25s;position:relative;overflow:hidden;}
.pc::before{content:'';position:absolute;top:0;left:0;right:0;height:1.5px;background:transparent;transition:.3s;}
.pc:hover{transform:scale(1.05);z-index:3;border-color:var(--line2);}
.pc.s-long::before{background:var(--green);}
.pc.s-short::before{background:var(--red);}
.pc.s-hot::before{background:var(--gold);}
.pc.s-long{border-color:rgba(0,255,136,.2);background:rgba(0,255,136,.03);}
.pc.s-short{border-color:rgba(255,45,85,.2);background:rgba(255,45,85,.03);}
.pc.s-hot{border-color:rgba(255,184,0,.35);background:rgba(255,184,0,.05);box-shadow:0 0 12px rgba(255,184,0,.1);}
.pc.s-scan{border-color:rgba(0,255,136,.5);animation:scanGlow .5s infinite alternate;}
@keyframes scanGlow{from{box-shadow:0 0 0 rgba(0,255,136,0)}to{box-shadow:0 0 14px rgba(0,255,136,.4)}}
.pc.s-idle{opacity:.5;}
.pc-name{font-family:var(--mono);font-size:9px;font-weight:700;color:#fff;margin-bottom:2px;}
.pc-price{font-family:var(--mono);font-size:7px;color:var(--dim);margin-bottom:4px;}
.pc-score{font-family:var(--disp);font-size:13px;font-weight:900;line-height:1;}
.pc-dir{font-family:var(--mono);font-size:7px;margin-top:1px;}
.pc-bar{height:2px;background:var(--dim2);border-radius:1px;margin-top:5px;overflow:hidden;}
.pc-bar-fill{height:100%;border-radius:1px;transition:width .5s;}
.pc-tags{display:flex;gap:2px;flex-wrap:wrap;margin-top:4px;}
.pc-tag{font-size:6px;padding:1px 3px;border-radius:2px;}
.t-wy{background:rgba(139,92,246,.12);color:var(--purple);}
.t-ob{background:rgba(0,255,136,.1);color:var(--green);}
.t-sp{background:rgba(249,115,22,.12);color:var(--orange);}
.t-bos{background:rgba(14,165,233,.12);color:var(--blue2);}
.t-hot{background:rgba(255,184,0,.12);color:var(--gold);}
/* Scan spinner */
.spin-wrap{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,255,136,.04);}
.spinner{width:16px;height:16px;border:1.5px solid rgba(0,255,136,.2);border-top-color:var(--green);border-radius:50%;animation:spin .5s linear infinite;}
@keyframes spin{to{transform:rotate(360deg)}}

/* CENTER: CHART PANEL */
.center-col{display:flex;flex-direction:column;gap:12px;overflow:hidden;}
.chart-panel{background:var(--bg2);border:1px solid var(--line2);border-radius:12px;overflow:hidden;flex:1;display:flex;flex-direction:column;}
.chart-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border-bottom:1px solid var(--line);flex-shrink:0;}
.chart-pair{font-family:var(--disp);font-size:16px;font-weight:900;color:#fff;}
.chart-price{font-family:var(--mono);font-size:11px;color:var(--dim);margin-top:2px;}
.chart-badges{display:flex;gap:5px;}
.badge{font-family:var(--mono);font-size:8px;font-weight:700;padding:3px 8px;border-radius:3px;border:1px solid;}
.b-long{background:rgba(0,255,136,.08);color:var(--green);border-color:rgba(0,255,136,.2);}
.b-short{background:rgba(255,45,85,.08);color:var(--red);border-color:rgba(255,45,85,.2);}
.b-wy{background:rgba(139,92,246,.08);color:var(--purple);border-color:rgba(139,92,246,.2);}
.b-hot{background:rgba(255,184,0,.08);color:var(--gold);border-color:rgba(255,184,0,.2);}
.b-neu{background:rgba(255,255,255,.04);color:var(--dim);border-color:var(--line);}
.chart-tf{display:flex;gap:3px;}
.tf-btn{font-family:var(--mono);font-size:8px;padding:2px 7px;border-radius:3px;border:1px solid var(--line);color:var(--dim);cursor:pointer;background:transparent;transition:.15s;}
.tf-btn.on{background:rgba(14,165,233,.1);border-color:rgba(14,165,233,.3);color:var(--blue2);}
/* Canvas chart */
#chartCanvas{display:block;width:100%;background:#04070F;cursor:crosshair;}
.chart-legend{display:flex;gap:10px;padding:4px 14px;border-top:1px solid var(--line);flex-shrink:0;flex-wrap:wrap;}
.cl-i{font-family:var(--mono);font-size:8px;color:var(--dim);display:flex;align-items:center;gap:3px;}
.cl-line{width:14px;height:2px;border-radius:1px;}
/* Tooltip */
#chartTip{position:absolute;background:rgba(4,7,15,.95);border:1px solid var(--line2);border-radius:6px;padding:6px 10px;font-family:var(--mono);font-size:9px;pointer-events:none;display:none;z-index:20;white-space:nowrap;color:#fff;}

/* LEVELS */
.levels-row{display:grid;grid-template-columns:repeat(5,1fr);gap:5px;flex-shrink:0;}
.lv{background:var(--bg3);border:1px solid var(--line);border-radius:7px;padding:8px;text-align:center;}
.lv-lbl{font-family:var(--mono);font-size:6px;color:var(--dim);letter-spacing:.5px;margin-bottom:4px;}
.lv-val{font-family:var(--mono);font-size:10px;font-weight:700;}
.lv-pct{font-family:var(--mono);font-size:7px;margin-top:2px;}

/* RIGHT: SIGNALS + INDICATORS */
.right-col{display:flex;flex-direction:column;gap:10px;overflow:hidden;}

/* SCORE GAUGE */
.score-card{background:var(--bg2);border:1px solid var(--line2);border-radius:12px;padding:14px;flex-shrink:0;}
.score-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;}
.score-pair{font-family:var(--disp);font-size:18px;font-weight:900;color:#fff;}
.score-val{text-align:right;}
.score-num{font-family:var(--disp);font-size:36px;font-weight:900;line-height:1;}
.score-lbl{font-family:var(--mono);font-size:7px;color:var(--dim);letter-spacing:1px;}
.score-bar-wrap{height:6px;background:var(--dim2);border-radius:3px;overflow:hidden;margin-bottom:8px;}
.score-bar-fill{height:100%;border-radius:3px;transition:width .6s ease;}
.score-meta{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;}
.sm-item{background:var(--bg3);border:1px solid var(--line);border-radius:6px;padding:7px;text-align:center;}
.sm-val{font-family:var(--mono);font-size:11px;font-weight:700;}
.sm-lbl{font-family:var(--mono);font-size:7px;color:var(--dim);margin-top:2px;}

/* INDICATORS */
.ind-card{background:var(--bg2);border:1px solid var(--line2);border-radius:12px;overflow:hidden;flex-shrink:0;}
.card-head{padding:8px 12px;border-bottom:1px solid var(--line);font-family:var(--mono);font-size:8px;color:var(--dim);letter-spacing:1.5px;}
.card-body{padding:10px 12px;}
.ind-grid{display:grid;grid-template-columns:1fr 1fr;gap:5px;}
.ind-item{background:var(--bg3);border:1px solid var(--line);border-radius:6px;padding:7px;}
.ind-lbl{font-family:var(--mono);font-size:7px;color:var(--dim);margin-bottom:3px;}
.ind-val{font-family:var(--mono);font-size:12px;font-weight:700;}
.ind-sub{font-family:var(--mono);font-size:7px;color:var(--dim);margin-top:1px;}

/* FACTORS */
.factors-wrap{display:flex;gap:3px;flex-wrap:wrap;padding:8px 12px;border-top:1px solid var(--line);}
.factor{font-family:var(--mono);font-size:8px;background:rgba(0,255,136,.06);border:1px solid rgba(0,255,136,.15);color:var(--green);padding:2px 6px;border-radius:3px;}

/* SIGNAL FEED */
.feed-card{background:var(--bg2);border:1px solid var(--line2);border-radius:12px;overflow:hidden;flex:1;display:flex;flex-direction:column;min-height:0;}
.feed-head{padding:8px 12px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;flex-shrink:0;}
.feed-title{font-family:var(--mono);font-size:8px;color:var(--dim);letter-spacing:1.5px;}
.feed-badge{font-family:var(--mono);font-size:8px;color:var(--green);background:rgba(0,255,136,.06);border:1px solid rgba(0,255,136,.15);padding:2px 7px;border-radius:3px;}
.feed-list{overflow-y:auto;flex:1;scrollbar-width:thin;scrollbar-color:var(--dim2) transparent;}
.sig-item{padding:10px 12px;border-bottom:1px solid var(--line);cursor:pointer;transition:.15s;position:relative;}
.sig-item:hover{background:rgba(255,255,255,.015);}
.sig-item.new{animation:newFlash .4s ease;}
@keyframes newFlash{0%{background:rgba(0,255,136,.1)}100%{background:transparent}}
.si-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px;}
.si-pair{font-family:var(--mono);font-size:12px;font-weight:700;color:#fff;}
.si-score{font-family:var(--disp);font-size:18px;font-weight:900;}
.si-meta{display:flex;gap:3px;flex-wrap:wrap;margin-bottom:6px;}
.si-chip{font-family:var(--mono);font-size:7px;background:var(--bg4);border:1px solid var(--line);padding:1px 5px;border-radius:2px;}
.si-lvls{display:grid;grid-template-columns:1fr 1fr 1fr;gap:3px;margin-bottom:5px;}
.si-lv{background:var(--bg3);border:1px solid var(--line);border-radius:4px;padding:4px;text-align:center;}
.si-lv-l{font-family:var(--mono);font-size:6px;color:var(--dim);margin-bottom:1px;}
.si-lv-v{font-family:var(--mono);font-size:8px;font-weight:700;}
.si-time{font-family:var(--mono);font-size:7px;color:var(--dim);margin-bottom:5px;}
.btn-exec{width:100%;background:rgba(0,255,136,.08);border:1px solid rgba(0,255,136,.2);color:var(--green);border-radius:5px;padding:5px;font-family:var(--mono);font-size:9px;cursor:pointer;transition:.15s;font-weight:700;letter-spacing:.5px;}
.btn-exec:hover{background:rgba(0,255,136,.15);}
.hot-badge{position:absolute;top:8px;right:8px;font-family:var(--mono);font-size:7px;background:rgba(255,184,0,.1);border:1px solid rgba(255,184,0,.25);color:var(--gold);padding:1px 5px;border-radius:2px;letter-spacing:.5px;}

/* AI NARRATION */
.narr-card{background:var(--bg2);border:1px solid rgba(139,92,246,.15);border-radius:10px;padding:10px 12px;font-size:10px;line-height:1.7;color:var(--dim);flex-shrink:0;}
.narr-card b{color:var(--purple);}
.narr-card span{color:#fff;}
.narr-card em{color:var(--green);font-style:normal;}

/* EMPTY */
.empty-st{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:30px;gap:8px;color:var(--dim);text-align:center;}
.empty-icon{font-size:28px;}

/* TOAST */
#toast{position:fixed;bottom:18px;right:18px;background:var(--bg2);border:1px solid rgba(0,255,136,.25);border-radius:8px;padding:10px 16px;font-family:var(--mono);font-size:11px;color:var(--green);z-index:500;display:none;max-width:280px;box-shadow:0 4px 24px rgba(0,0,0,.6);}

@media(max-width:1100px){.main{grid-template-columns:1fr 1fr;}.right-col{display:none;}}
@media(max-width:700px){.main{grid-template-columns:1fr;height:auto;}}
</style>
</head>
<body>

<canvas id="canvas"></canvas>

<!-- CONNECT MODAL -->
<div id="connectModal">
  <div class="modal-card">
    <div class="modal-title">ACS SCANNER PRO</div>
    <div class="modal-sub">Conecte ao bot para iniciar análise em tempo real de 100 pares com IA</div>
    <label class="modal-label">URL DO BOT</label>
    <input class="modal-input" id="mUrl" placeholder="http://localhost:3002" value="http://localhost:3002"/>
    <label class="modal-label">ADMIN KEY</label>
    <input class="modal-input" id="mKey" placeholder="acs@Admin2026!" type="password" onkeydown="if(event.key==='Enter')doConnect()"/>
    <button class="modal-btn" onclick="doConnect()">⚡ CONECTAR E INICIAR</button>
    <div class="modal-err" id="mErr"></div>
    <div class="modal-skip" onclick="skipConnect()">Pular — usar localhost:3002</div>
  </div>
</div>

<!-- TOPBAR -->
<div class="topbar">
  <div class="tb-logo">
    <div class="tb-logo-text">ACS <span>PRO</span></div>
    <div class="tb-live"><div class="tb-live-dot"></div>AO VIVO</div>
  </div>
  <div class="tb-center">
    <div class="tb-stat">Analisados: <b id="tbAnal">0</b></div>
    <div class="tb-stat">Sinais: <b id="tbSig">0</b></div>
    <div class="tb-stat">HOT: <b id="tbHot" style="color:var(--gold)">0</b></div>
    <div class="tb-stat" id="tbClock">00:00:00</div>
  </div>
  <div class="tb-right">
    <div class="ws-ind" id="wsInd"></div>
    <button class="btn-sm btn-scan" id="btnScan" onclick="startScan()" disabled>📡 Scan</button>
    <button class="btn-sm btn-auto" id="btnAuto" onclick="toggleAuto()" disabled>🤖 Auto 15min</button>
    <button class="btn-sm btn-connect" onclick="document.getElementById('connectModal').style.display='flex'">⚙️</button>
  </div>
</div>

<!-- MAIN -->
<div class="main">

  <!-- LEFT -->
  <div class="left-col">
    <!-- Progress -->
    <div class="prog-panel" id="progPanel">
      <div class="prog-head">
        <div>
          <div class="prog-title">IA ANALISANDO</div>
          <div style="font-size:10px;color:var(--text);margin-top:2px" id="progLbl">Iniciando...</div>
        </div>
        <div class="prog-pct" id="progPct">0%</div>
      </div>
      <div class="prog-bar-wrap"><div class="prog-bar-fill" id="progFill" style="width:0%"></div></div>
      <div class="prog-stats">
        <div class="prog-stat">Pares: <b id="psDone">0</b>/<b id="psTotal">100</b></div>
        <div class="prog-stat">Sinais: <b id="psSig">0</b></div>
        <div class="prog-stat">HOT: <b id="psHot">0</b></div>
      </div>
      <div class="prog-scanning" id="progChips"></div>
    </div>

    <!-- Map -->
    <div class="map-panel">
      <div class="map-head">
        <div class="map-title">MAPA DE PARES — 100 PARES EM TEMPO REAL</div>
        <div class="map-legend">
          <div class="ml-item"><div class="ml-dot" style="background:var(--green)"></div>LONG</div>
          <div class="ml-item"><div class="ml-dot" style="background:var(--red)"></div>SHORT</div>
          <div class="ml-item"><div class="ml-dot" style="background:var(--gold)"></div>HOT</div>
          <div class="ml-item"><div class="ml-dot" style="background:var(--dim)"></div>Neutro</div>
        </div>
      </div>
      <div class="heatmap" id="heatmap"></div>
      <div class="filter-row">
        <button class="fr-btn on" onclick="setFilter('all',this)">Todos</button>
        <button class="fr-btn" onclick="setFilter('long',this)">🟢 LONG</button>
        <button class="fr-btn" onclick="setFilter('short',this)">🔴 SHORT</button>
        <button class="fr-btn" onclick="setFilter('hot',this)">🔥 HOT</button>
        <button class="fr-btn" onclick="setFilter('spring',this)">⚡ Spring</button>
        <button class="fr-btn" onclick="setFilter('ob',this)">📦 OB</button>
      </div>
      <div class="pair-grid" id="pairGrid"></div>
    </div>
  </div>

  <!-- CENTER -->
  <div class="center-col">
    <!-- Chart -->
    <div class="chart-panel">
      <div class="chart-head">
        <div>
          <div class="chart-pair" id="chartPair">Selecione um par</div>
          <div class="chart-price" id="chartPrice">Clique em qualquer par no mapa →</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px">
          <div class="chart-badges" id="chartBadges"></div>
          <div class="chart-tf">
            <button class="tf-btn" onclick="changeTF('15',this)">15M</button>
            <button class="tf-btn on" onclick="changeTF('60',this)">1H</button>
            <button class="tf-btn" onclick="changeTF('240',this)">4H</button>
            <button class="tf-btn" onclick="changeTF('D',this)">1D</button>
          </div>
        </div>
      </div>
      <div style="position:relative;flex:1;min-height:0">
        <canvas id="chartCanvas"></canvas>
        <div id="chartTip"></div>
      </div>
      <div class="chart-legend">
        <div class="cl-i"><div class="cl-line" style="background:rgba(139,92,246,.8)"></div>EMA21</div>
        <div class="cl-i"><div class="cl-line" style="background:rgba(14,165,233,.8)"></div>EMA50</div>
        <div class="cl-i"><div class="cl-line" style="background:rgba(255,184,0,.9)"></div>EMA200</div>
        <div class="cl-i"><div class="cl-line" style="background:rgba(255,45,85,.7);border-top:1.5px dashed var(--red)"></div>Stop Loss</div>
        <div class="cl-i"><div class="cl-line" style="background:rgba(0,255,136,.7);border-top:1.5px dashed var(--green)"></div>Alvos</div>
        <div class="cl-i"><div class="cl-line" style="background:rgba(139,92,246,.5)"></div>OB / POC</div>
      </div>
    </div>

    <!-- Levels -->
    <div class="levels-row" id="levelsRow">
      <div class="lv"><div class="lv-lbl">STOP LOSS</div><div class="lv-val" style="color:var(--red)" id="lvSL">—</div><div class="lv-pct" style="color:var(--red)" id="lvSLp"></div></div>
      <div class="lv"><div class="lv-lbl">ENTRADA</div><div class="lv-val" id="lvE">—</div></div>
      <div class="lv"><div class="lv-lbl">TP1</div><div class="lv-val" style="color:rgba(0,255,136,.6)" id="lvT1">—</div><div class="lv-pct" style="color:rgba(0,255,136,.6)" id="lvT1p"></div></div>
      <div class="lv"><div class="lv-lbl">TP2</div><div class="lv-val" style="color:rgba(0,255,136,.8)" id="lvT2">—</div><div class="lv-pct" style="color:rgba(0,255,136,.8)" id="lvT2p"></div></div>
      <div class="lv"><div class="lv-lbl">TP3</div><div class="lv-val" style="color:var(--green)" id="lvT3">—</div><div class="lv-pct" style="color:var(--green)" id="lvT3p"></div></div>
    </div>
  </div>

  <!-- RIGHT -->
  <div class="right-col">

    <!-- Score -->
    <div class="score-card">
      <div class="score-head">
        <div>
          <div class="score-pair" id="scPair">—</div>
          <div style="font-family:var(--mono);font-size:8px;color:var(--dim);margin-top:2px" id="scPhase">Aguardando seleção</div>
        </div>
        <div class="score-val">
          <div class="score-num" id="scNum" style="color:var(--dim)">—</div>
          <div class="score-lbl">SCORE /26</div>
        </div>
      </div>
      <div class="score-bar-wrap"><div class="score-bar-fill" id="scBar" style="width:50%;background:var(--dim)"></div></div>
      <div class="score-meta">
        <div class="sm-item"><div class="sm-val" id="scProb" style="color:var(--dim)">—</div><div class="sm-lbl">PROB.</div></div>
        <div class="sm-item"><div class="sm-val" id="scRR" style="color:var(--dim)">—</div><div class="sm-lbl">R/R</div></div>
        <div class="sm-item"><div class="sm-val" id="scDir" style="color:var(--dim)">—</div><div class="sm-lbl">DIREÇÃO</div></div>
      </div>
    </div>

    <!-- Indicators -->
    <div class="ind-card">
      <div class="card-head">INDICADORES</div>
      <div class="card-body">
        <div class="ind-grid">
          <div class="ind-item"><div class="ind-lbl">RSI 14</div><div class="ind-val" id="iRSI">—</div></div>
          <div class="ind-item"><div class="ind-lbl">MACD</div><div class="ind-val" id="iMACD">—</div></div>
          <div class="ind-item"><div class="ind-lbl">VOLUME</div><div class="ind-val" id="iVol">—</div></div>
          <div class="ind-item"><div class="ind-lbl">EMA200</div><div class="ind-val" id="iEMA">—</div></div>
          <div class="ind-item"><div class="ind-lbl">WYCKOFF</div><div class="ind-val" id="iWy" style="font-size:9px">—</div></div>
          <div class="ind-item"><div class="ind-lbl">ORDER BLOCK</div><div class="ind-val" id="iOB" style="font-size:9px">—</div></div>
          <div class="ind-item"><div class="ind-lbl">BOS / CHoCH</div><div class="ind-val" id="iBOS">—</div></div>
          <div class="ind-item"><div class="ind-lbl">MTF ALIGN</div><div class="ind-val" id="iMTF">—</div></div>
        </div>
      </div>
      <div class="factors-wrap" id="factors"></div>
    </div>

    <!-- AI Narration -->
    <div class="narr-card" id="narration">
      <b>IA:</b> Aguardando início do scan para analisar o mercado em tempo real...
    </div>

    <!-- Signal Feed -->
    <div class="feed-card">
      <div class="feed-head">
        <div class="feed-title">SINAIS APROVADOS</div>
        <div class="feed-badge" id="feedBadge">0 sinais</div>
      </div>
      <div class="feed-list" id="feedList">
        <div class="empty-st"><div class="empty-icon">🎯</div><div style="font-size:10px">Sinais aprovados aparecem aqui</div></div>
      </div>
    </div>

  </div>
</div>

<div id="toast"></div>

<script>
// ══ CANVAS PARTICLES ════════════════════════════════════════════════
const cvs=document.getElementById('canvas');
const pctx=cvs.getContext('2d');
cvs.width=window.innerWidth;cvs.height=window.innerHeight;
const particles=[];
for(let i=0;i<60;i++){
  particles.push({
    x:Math.random()*cvs.width,y:Math.random()*cvs.height,
    vx:(Math.random()-.5)*.3,vy:(Math.random()-.5)*.3,
    r:Math.random()*1.5+.5,
    col:['rgba(0,255,136,.4)','rgba(14,165,233,.4)','rgba(139,92,246,.4)','rgba(255,184,0,.3)'][Math.floor(Math.random()*4)],
    a:Math.random(),
  });
}
function animParticles(){
  pctx.clearRect(0,0,cvs.width,cvs.height);
  particles.forEach(p=>{
    p.x+=p.vx;p.y+=p.vy;p.a+=.005;
    if(p.x<0)p.x=cvs.width;if(p.x>cvs.width)p.x=0;
    if(p.y<0)p.y=cvs.height;if(p.y>cvs.height)p.y=0;
    pctx.beginPath();
    pctx.arc(p.x,p.y,p.r,0,Math.PI*2);
    pctx.fillStyle=p.col;
    pctx.fill();
  });
  requestAnimationFrame(animParticles);
}
animParticles();
window.addEventListener('resize',()=>{cvs.width=window.innerWidth;cvs.height=window.innerHeight;});

// ══ STATE ════════════════════════════════════════════════════════════
let ws=null,BOT_URL='',KEY='',autoOn=false,autoTimer=null;
let pairData={},signals=[],curPair=null,curTF='60';
let mapFilter='all',hotCount=0;
const ALL_PAIRS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','TRXUSDT','LINKUSDT','DOTUSDT','LTCUSDT','BCHUSDT','ATOMUSDT','NEARUSDT','APTUSDT','ARBUSDT','OPUSDT','INJUSDT','SUIUSDT','MATICUSDT','XLMUSDT','VETUSDT','HBARUSDT','ALGOUSDT','FILUSDT','ICPUSDT','ETCUSDT','STXUSDT','TONUSDT','AAVEUSDT','UNIUSDT','MKRUSDT','CRVUSDT','SNXUSDT','GMXUSDT','DYDXUSDT','LDOUSDT','RUNEUSDT','JUPUSDT','IMXUSDT','STRKUSDT','ZROUSDT','MANTAUSDT','ALTUSDT','MNTUSDT','LRCUSDT','ENAUSDT','EIGENUSDT','ETHFIUSDT','FETUSDT','TAOUSDT','RENDERUSDT','WLDUSDT','GRTUSDT','AGIXUSDT','OCEANUSDT','MOVEUSDT','WOOUSDT','MASKUSDT','SANDUSDT','MANAUSDT','AXSUSDT','GALAUSDT','ENJUSDT','MAGICUSDT','APEUSDT','ORDIUSDT','CHZUSDT','FTMUSDT','PEPEUSDT','FLOKIUSDT','BONKUSDT','WIFUSDT','SHIBUSDT','MEMEUSDT','POPCATUSDT','NEIROUSDT','BOMEUSDT','TURBOUSDT','STORJUSDT','CKBUSDT','ANKRUSDT','BATUSDT','ZECUSDT','ROSEUSDT','KAVAUSDT','COMPUSDT','BALUSDT','1INCHUSDT','DYMUSDT','PYTHUSDT','TIAUSDT','SEIUSDT','EGLDUSDT','SOLUSDT','RUNEUSDT','JUPUSDT','LDOUSDT','WLDUSDT'];

// ══ INIT ════════════════════════════════════════════════════════════
setInterval(()=>{ document.getElementById('tbClock').textContent=new Date().toLocaleTimeString('pt-BR'); },1000);

// Auto-restore
(()=>{
  const u=localStorage.getItem('acs_sl_url');
  const k=localStorage.getItem('acs_sl_key');
  if(u&&k){
    document.getElementById('mUrl').value=u;
    document.getElementById('mKey').value=k;
  }
})();

// ══ CONNECT ══════════════════════════════════════════════════════════
async function doConnect(){
  const url=(document.getElementById('mUrl').value||'').trim().replace(/\\/+$/,'');
  const key=(document.getElementById('mKey').value||'').trim();
  const err=document.getElementById('mErr');
  if(!url||!key){err.textContent='Preencha URL e Admin Key.';return;}
  err.textContent='Conectando...';
  try{
    const r=await fetch(url+'/health').catch(e=>{throw new Error('Bot não acessível: '+e.message)});
    if(!r.ok) throw new Error('HTTP '+r.status);
    const r2=await fetch(url+'/api/status',{headers:{'x-admin-key':key}});
    if(r2.status===401) throw new Error('Admin Key inválida');
    BOT_URL=url; KEY=key;
    localStorage.setItem('acs_sl_url',url);
    localStorage.setItem('acs_sl_key',key);
    document.getElementById('connectModal').style.display='none';
    connectWS();
    initGrid();
  }catch(e){err.textContent='❌ '+e.message;}
}
function skipConnect(){
  BOT_URL='http://localhost:3002'; KEY='acs@Admin2026!';
  document.getElementById('connectModal').style.display='none';
  connectWS();
  initGrid();
}

// ══ WEBSOCKET ════════════════════════════════════════════════════════
function connectWS(){
  if(ws)try{ws.close();}catch{}
  const proto=BOT_URL.startsWith('https')?'wss':'ws';
  ws=new WebSocket(proto+'://'+BOT_URL.replace(/^https?:\\/\\//,''));
  ws.onopen=()=>{
    setWS(true);
    document.getElementById('btnScan').disabled=false;
    document.getElementById('btnAuto').disabled=false;
    narrate('<b>IA:</b> Conectada ao bot. <em>Pronta para mapear 100 pares.</em>');
    toast('✅ Bot conectado');
  };
  ws.onclose=()=>{
    setWS(false);
    document.getElementById('btnScan').disabled=true;
    document.getElementById('btnAuto').disabled=true;
    if(BOT_URL) setTimeout(connectWS,4000);
  };
  ws.onerror=()=>ws.close();
  ws.onmessage=ev=>{
    const msg=JSON.parse(ev.data);
    switch(msg.type){
      case 'init':
        (msg.data.signals||[]).forEach(s=>addSignal(s,false));
        break;
      case 'scan_start':
        document.getElementById('progPanel').style.display='';
        document.getElementById('btnScan').disabled=true;
        document.getElementById('btnScan').textContent='⏳ Analisando...';
        narrate('<b>IA:</b> Scan iniciado — analisando <em>Wyckoff, SMC, Elliott, Volume</em> em 100 pares...');
        break;
      case 'scan_progress':
        const p=msg.data;
        const pct=p.pct||Math.round((p.done||0)/(p.total||100)*100);
        document.getElementById('progFill').style.width=pct+'%';
        document.getElementById('progPct').textContent=pct+'%';
        document.getElementById('progLbl').textContent=(p.done||0)+'/'+(p.total||100)+' analisados · '+(p.signals||0)+' sinais';
        document.getElementById('psDone').textContent=p.done||0;
        document.getElementById('psTotal').textContent=p.total||100;
        document.getElementById('psSig').textContent=p.signals||0;
        if(p.scanning&&p.scanning.length){
          document.getElementById('progChips').innerHTML=p.scanning.map(s=>\`<div class="scan-chip">⚡ \${s.replace('USDT','')}</div>\`).join('');
          p.scanning.forEach(markScanning);
        }
        break;
      case 'pair_result':
        pairData[msg.data.symbol]=msg.data;
        updateCard(msg.data);
        updateHeatmap();
        updateTopBar();
        if(msg.data.hot){
          hotCount++;
          document.getElementById('psHot').textContent=hotCount;
          narrate(\`<b>IA:</b> 🔥 <em>\${msg.data.symbol}</em> — Score <span>\${msg.data.score>0?'+':''}\${msg.data.score}</span> | \${msg.data.phase} | OB \${msg.data.obBull?'✅':msg.data.obBear?'🔴':'—'} | RSI \${msg.data.rsi} | Vol \${msg.data.volRatio}x\`);
        }
        break;
      case 'signal':
        addSignal(msg.data,true);
        if(msg.data.symbol===curPair?.symbol) showDetail(msg.data);
        break;
      case 'scan_done':
        document.getElementById('progPanel').style.display='none';
        document.getElementById('btnScan').disabled=false;
        document.getElementById('btnScan').textContent='📡 Scan';
        document.getElementById('progChips').innerHTML='';
        const vals=Object.values(pairData);
        const longs=vals.filter(v=>v.dir==='LONG').length;
        const shorts=vals.filter(v=>v.dir==='SHORT').length;
        const hots=vals.filter(v=>v.hot).length;
        narrate(\`<b>IA:</b> ✅ Scan concluído. <em>\${vals.length} pares</em> analisados — \${longs} LONG, \${shorts} SHORT, <span>\${hots} HOT SETUPS</span> aprovados nos filtros premium.\`);
        break;
      case 'scan_error':
        toast('❌ Erro: '+(msg.data.msg||'Falha no scan'));
        document.getElementById('btnScan').disabled=false;
        document.getElementById('btnScan').textContent='📡 Scan';
        break;
    }
  };
}
function setWS(on){
  const d=document.getElementById('wsInd');
  d.className='ws-ind'+(on?' on':'');
}

// ══ API ══════════════════════════════════════════════════════════════
const api=(path,method='GET',body=null)=>
  fetch(BOT_URL+path,{method,headers:{'x-admin-key':KEY,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})
  .then(r=>r.json()).catch(()=>null);

// ══ SCAN ═════════════════════════════════════════════════════════════
async function startScan(){
  hotCount=0;
  pairData={};
  initGrid();
  await api('/api/scan/start','POST',{mode:'full'});
}
function toggleAuto(){
  autoOn=!autoOn;
  const b=document.getElementById('btnAuto');
  b.textContent=autoOn?'⏹ Parar Auto':'🤖 Auto 15min';
  b.className='btn-sm btn-auto'+(autoOn?' active':'');
  if(autoOn){startScan();autoTimer=setInterval(startScan,15*60*1000);}
  else clearInterval(autoTimer);
  toast(autoOn?'Auto-scan ativado':'Auto-scan desativado');
}

// ══ PAIR GRID ════════════════════════════════════════════════════════
function initGrid(){
  const grid=document.getElementById('pairGrid');
  grid.innerHTML=ALL_PAIRS.map(sym=>\`
    <div class="pc s-idle" id="pc-\${sym}" onclick="selectPair('\${sym}')">
      <div class="pc-name">\${sym.replace('USDT','')}</div>
      <div class="pc-price" id="pp-\${sym}">—</div>
      <div class="pc-score" id="ps-\${sym}" style="color:var(--dim)">—</div>
      <div class="pc-dir" id="pd-\${sym}" style="color:var(--dim)">AGUARDANDO</div>
      <div class="pc-bar"><div class="pc-bar-fill" id="pb-\${sym}" style="width:50%;background:var(--dim)"></div></div>
      <div class="pc-tags" id="pt-\${sym}"></div>
    </div>\`).join('');
  updateHeatmap();
}

function markScanning(sym){
  const c=document.getElementById('pc-'+sym);
  if(!c) return;
  c.className='pc s-scan';
  const d=document.getElementById('pd-'+sym);
  if(d){d.textContent='ANALISANDO...';d.style.color='var(--green)';}
}

function updateCard(pr){
  const c=document.getElementById('pc-'+pr.symbol);
  if(!c) return;
  const sCol=pr.dir==='LONG'?'var(--green)':pr.dir==='SHORT'?'var(--red)':'var(--dim)';
  const cls=pr.hot?'s-hot':pr.dir==='LONG'?'s-long':pr.dir==='SHORT'?'s-short':'';
  c.className='pc '+cls;
  const p=document.getElementById('pp-'+pr.symbol);
  const s=document.getElementById('ps-'+pr.symbol);
  const d=document.getElementById('pd-'+pr.symbol);
  const b=document.getElementById('pb-'+pr.symbol);
  const t=document.getElementById('pt-'+pr.symbol);
  const pF=v=>!v?'—':v<0.001?v.toExponential(2):v<1?v.toFixed(4):v<100?v.toFixed(2):v.toFixed(0);
  if(p) p.textContent='$'+pF(pr.cur);
  if(s){s.textContent=(pr.score>0?'+':'')+pr.score;s.style.color=sCol;}
  if(d){d.textContent=pr.dir+(pr.hot?' 🔥':'');d.style.color=sCol;}
  const bp=Math.max(0,Math.min(100,(pr.score+26)/52*100));
  if(b){b.style.width=bp+'%';b.style.background=sCol;}
  if(t){
    const tags=[];
    if(pr.phase&&pr.phase!=='INDEFINIDA') tags.push(\`<span class="pc-tag t-wy">\${pr.phase.slice(0,4)}</span>\`);
    if(pr.obBull) tags.push('<span class="pc-tag t-ob">OB</span>');
    if(pr.spring) tags.push('<span class="pc-tag t-sp">⚡</span>');
    if(pr.bosBull||pr.bosBear) tags.push('<span class="pc-tag t-bos">BOS</span>');
    if(pr.hot) tags.push('<span class="pc-tag t-hot">HOT</span>');
    t.innerHTML=tags.join('');
  }
  applyFilter(c,pr);
}

// ══ FILTER ═══════════════════════════════════════════════════════════
function setFilter(f,btn){
  mapFilter=f;
  document.querySelectorAll('.fr-btn').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
  ALL_PAIRS.forEach(sym=>{
    const c=document.getElementById('pc-'+sym);
    const pr=pairData[sym];
    if(c) applyFilter(c,pr||null);
  });
}
function applyFilter(card,pr){
  const show=mapFilter==='all'?true
    :mapFilter==='long'  ?(pr?.dir==='LONG')
    :mapFilter==='short' ?(pr?.dir==='SHORT')
    :mapFilter==='hot'   ?(pr?.hot===true)
    :mapFilter==='spring'?(pr?.spring===true)
    :mapFilter==='ob'    ?(pr?.obBull||pr?.obBear)
    :true;
  card.style.opacity=show?'1':'0.18';
  card.style.pointerEvents=show?'':'none';
}

// ══ HEATMAP ══════════════════════════════════════════════════════════
function updateHeatmap(){
  const hm=document.getElementById('heatmap');
  hm.innerHTML=ALL_PAIRS.slice(0,80).map(sym=>{
    const pr=pairData[sym];
    const score=pr?.score||0;
    const col=score>=12?'#00FF88':score>=6?'rgba(0,255,136,.6)':score>=2?'rgba(0,255,136,.3)':score<=-12?'#FF2D55':score<=-6?'rgba(255,45,85,.6)':score<=-2?'rgba(255,45,85,.3)':'#1E293B';
    const h=Math.max(4,Math.min(28,Math.abs(score)*2.2+4));
    return \`<div class="hm-col" style="background:\${col};height:\${h}px" title="\${sym.replace('USDT','')}: \${score>0?'+':''}\${score}" onclick="selectPair('\${sym}')"></div>\`;
  }).join('');
}

// ══ TOPBAR STATS ═════════════════════════════════════════════════════
function updateTopBar(){
  const vals=Object.values(pairData);
  document.getElementById('tbAnal').textContent=vals.length;
  document.getElementById('tbSig').textContent=signals.length;
  document.getElementById('tbHot').textContent=vals.filter(v=>v.hot).length;
}

// ══ SELECT PAIR ══════════════════════════════════════════════════════
async function selectPair(sym){
  // Highlight card
  document.querySelectorAll('.pc').forEach(c=>c.style.outline='');
  const card=document.getElementById('pc-'+sym);
  if(card) card.style.outline='1.5px solid var(--green)';

  const pr=pairData[sym]||{symbol:sym,score:0,dir:'NEUTRO',prob:50};
  curPair=pr;

  // Update score panel
  const sCol=pr.dir==='LONG'?'var(--green)':pr.dir==='SHORT'?'var(--red)':'var(--dim)';
  document.getElementById('scPair').textContent=sym.replace('USDT','');
  document.getElementById('scPhase').textContent=pr.phase||'Analisando...';
  document.getElementById('scNum').textContent=(pr.score>0?'+':'')+pr.score;
  document.getElementById('scNum').style.color=sCol;
  document.getElementById('scProb').textContent=(pr.prob||50)+'%';
  document.getElementById('scProb').style.color=sCol;
  document.getElementById('scRR').textContent=pr.rr?(pr.rr.toFixed?pr.rr.toFixed(1)+'x':pr.rr+'x'):'—';
  document.getElementById('scDir').textContent=pr.dir||'—';
  document.getElementById('scDir').style.color=sCol;
  const bp=Math.max(0,Math.min(100,(pr.score+26)/52*100));
  document.getElementById('scBar').style.width=bp+'%';
  document.getElementById('scBar').style.background=sCol;

  // Indicators
  const setInd=(id,val,col)=>{const el=document.getElementById(id);if(el){el.textContent=val;if(col)el.style.color=col;}};
  setInd('iRSI',(pr.rsi||0).toFixed?pr.rsi.toFixed(1):pr.rsi||'—', pr.rsi>70?'var(--red)':pr.rsi<30?'var(--green)':'var(--text)');
  setInd('iMACD',pr.macdBull!==undefined?(pr.macdBull?'BULL ↑':'BEAR ↓'):'—', pr.macdBull?'var(--green)':'var(--red)');
  setInd('iVol',pr.volRatio?(pr.volRatio.toFixed?pr.volRatio.toFixed(2)+'x':pr.volRatio+'x'):'—', pr.volRatio>1.5?'var(--green)':pr.volRatio<0.7?'var(--red)':'var(--text)');
  setInd('iEMA',pr.cur&&pr.e200?(pr.cur>pr.e200?'▲ Acima':'▼ Abaixo'):'—', pr.cur>pr.e200?'var(--green)':'var(--red)');
  setInd('iWy',pr.phase||'—', pr.phase==='ACUMULAÇÃO'||pr.phase==='MARKUP'?'var(--green)':pr.phase==='DISTRIBUIÇÃO'||pr.phase==='MARKDOWN'?'var(--red)':'var(--dim)');
  setInd('iOB',pr.obBull?'BULL ✅':pr.obBear?'BEAR 🔴':'Neutro', pr.obBull?'var(--green)':pr.obBear?'var(--red)':'var(--dim)');
  setInd('iBOS',pr.bosBull?'BULL ✅':pr.bosBear?'BEAR 🔴':'—', pr.bosBull?'var(--green)':pr.bosBear?'var(--red)':'var(--dim)');
  setInd('iMTF',pr.mtfBull!==undefined?pr.mtfBull+'/'+(pr.mtfTotal||3):'—');

  // Factors
  const fEl=document.getElementById('factors');
  if(fEl) fEl.innerHTML=(pr.factors||[]).map(f=>\`<span class="factor">\${f}</span>\`).join('');

  // Chart badges
  const badges=document.getElementById('chartBadges');
  if(badges){
    const b=[];
    b.push(\`<span class="badge \${pr.dir==='LONG'?'b-long':pr.dir==='SHORT'?'b-short':'b-neu'}">\${pr.dir}</span>\`);
    if(pr.phase) b.push(\`<span class="badge b-wy">\${pr.phase}</span>\`);
    if(pr.hot)   b.push(\`<span class="badge b-hot">🔥 HOT</span>\`);
    badges.innerHTML=b.join('');
  }

  // Fetch full analysis for chart
  document.getElementById('chartPair').textContent=sym.replace('USDT','/USDT');
  document.getElementById('chartPrice').textContent='Carregando dados...';
  loadChart(sym, curTF);
}

// ══ CHART ════════════════════════════════════════════════════════════
let chartData=null,chartSym='',chartTF='60';
async function loadChart(sym,tf){
  chartSym=sym; chartTF=tf;
  try{
    const d=await api('/api/analyze/'+sym+'?tf='+tf+'&exchange=bybit');
    if(!d?.ok||!d?.analysis) return;
    const a=d.analysis;
    curPair={...curPair,...a};
    chartData=a;
    const pF=v=>!v?'—':v<0.001?v.toExponential(3):v<1?v.toFixed(5):v<100?v.toFixed(3):v.toFixed(2);
    document.getElementById('chartPrice').textContent='$'+pF(a.cur)+' · ATR $'+pF(a.atr)+' · Score '+(a.score>0?'+':'')+a.score;
    // Levels
    setLvl('SL',a.sl,a.entry,'var(--red)');
    setLvl('E',a.entry,null,null);
    setLvl('T1',a.tp1,a.entry,'rgba(0,255,136,.6)');
    setLvl('T2',a.tp2,a.entry,'rgba(0,255,136,.8)');
    setLvl('T3',a.tp3,a.entry,'var(--green)');
    // Draw
    drawChart(a);
  }catch(e){document.getElementById('chartPrice').textContent='Erro: '+e.message;}
}

function setLvl(id,price,ref,col){
  const pF=v=>!v?'—':v<0.001?v.toExponential(3):v<1?v.toFixed(5):v<100?v.toFixed(3):v.toFixed(2);
  const el=document.getElementById('lv'+id);
  if(el){el.textContent='$'+pF(price);if(col)el.style.color=col;}
  const elP=document.getElementById('lv'+id+'p');
  if(elP&&ref&&price){
    const pct=((price-ref)/ref*100);
    elP.textContent=(pct>=0?'+':'')+pct.toFixed(2)+'%';
  }
}

function changeTF(tf,btn){
  document.querySelectorAll('.tf-btn').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
  curTF=tf;
  if(curPair?.symbol) loadChart(curPair.symbol,tf);
}

// ══ CANVAS CHART ═════════════════════════════════════════════════════
function ema(arr,p){const k=2/(p+1);let e=arr[0];return arr.map(v=>(e=v*k+e*(1-k)));}

function drawChart(a){
  const canvas=document.getElementById('chartCanvas');
  if(!canvas||!a?.candles?.length) return;
  const parent=canvas.parentElement;
  const W=parent.clientWidth, H=parent.clientHeight;
  const DPR=window.devicePixelRatio||1;
  canvas.width=W*DPR; canvas.height=H*DPR;
  canvas.style.width=W+'px'; canvas.style.height=H+'px';
  const ctx=canvas.getContext('2d');
  ctx.scale(DPR,DPR);

  const candles=a.candles.slice(-80);
  const closes=candles.map(c=>c.c);
  const PL=8,PR=72,PT=16,PB=28;
  const cW=W-PL-PR, cH=H-PT-PB;
  const bW=Math.max(2,Math.floor(cW/candles.length)-1);

  // Price range with levels
  const lvls=[a.sl,a.entry,a.tp1,a.tp2,a.tp3].filter(Boolean);
  const allP=[...candles.map(c=>c.h),...candles.map(c=>c.l),...lvls];
  const minP=Math.min(...allP)*.999, maxP=Math.max(...allP)*1.001;
  const rng=maxP-minP||1;
  const toY=p=>PT+cH-((p-minP)/rng)*cH;
  const toX=i=>PL+(i/(candles.length-1))*cW;

  // Background
  ctx.fillStyle='#04070F';
  ctx.fillRect(0,0,W,H);

  // Grid
  for(let i=0;i<=5;i++){
    const y=PT+(cH/5)*i;
    const p=maxP-(rng/5)*i;
    ctx.strokeStyle='rgba(255,255,255,.04)';ctx.lineWidth=1;ctx.setLineDash([]);
    ctx.beginPath();ctx.moveTo(PL,y);ctx.lineTo(W-PR,y);ctx.stroke();
    ctx.fillStyle='rgba(100,116,139,.6)';ctx.font='7px JetBrains Mono';
    ctx.fillText('$'+(p<1?p.toFixed(5):p<100?p.toFixed(3):p.toFixed(0)),W-PR+4,y+3);
  }
  // Vertical grid
  [0,20,40,60,79].forEach(i=>{
    const x=toX(i);
    ctx.strokeStyle='rgba(255,255,255,.03)';ctx.setLineDash([]);
    ctx.beginPath();ctx.moveTo(x,PT);ctx.lineTo(x,H-PB);ctx.stroke();
    if(candles[i]){
      const dt=new Date(candles[i].t).toLocaleString('pt-BR',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
      ctx.fillStyle='rgba(100,116,139,.5)';ctx.font='6px JetBrains Mono';
      ctx.fillText(dt,x-18,H-12);
    }
  });

  // Order Blocks
  if(a.smc?.obBull){
    const ob=a.smc.obBull;
    if(ob.h>minP&&ob.l<maxP){
      ctx.fillStyle='rgba(0,255,136,.06)';
      ctx.strokeStyle='rgba(0,255,136,.3)';ctx.lineWidth=1;ctx.setLineDash([]);
      const y1=toY(ob.h),y2=toY(ob.l);
      ctx.fillRect(PL,y1,cW,y2-y1);ctx.strokeRect(PL,y1,cW,y2-y1);
      ctx.fillStyle='rgba(0,255,136,.7)';ctx.font='bold 7px JetBrains Mono';
      ctx.fillText('OB BULL',W-PR+4,y1+8);
    }
  }
  if(a.smc?.obBear){
    const ob=a.smc.obBear;
    if(ob.h>minP&&ob.l<maxP){
      ctx.fillStyle='rgba(255,45,85,.06)';
      ctx.strokeStyle='rgba(255,45,85,.3)';ctx.lineWidth=1;ctx.setLineDash([]);
      const y1=toY(ob.h),y2=toY(ob.l);
      ctx.fillRect(PL,y1,cW,y2-y1);ctx.strokeRect(PL,y1,cW,y2-y1);
      ctx.fillStyle='rgba(255,45,85,.7)';ctx.font='bold 7px JetBrains Mono';
      ctx.fillText('OB BEAR',W-PR+4,y1+8);
    }
  }

  // POC
  const poc=candles.reduce((mx,c)=>c.v>mx.v?c:mx,candles[0]);
  const pocY=toY((poc.h+poc.l)/2);
  ctx.strokeStyle='rgba(139,92,246,.6)';ctx.lineWidth=1;ctx.setLineDash([4,3]);
  ctx.beginPath();ctx.moveTo(PL,pocY);ctx.lineTo(W-PR,pocY);ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle='rgba(139,92,246,.8)';ctx.font='bold 7px JetBrains Mono';
  ctx.fillText('POC',W-PR+4,pocY-2);

  // Fibonacci
  if(a.fib){
    const fibLvls=[{v:a.fib.f618,l:'61.8%',c:'rgba(255,184,0,.6)'},{v:a.fib.f382,l:'38.2%',c:'rgba(255,184,0,.4)'}];
    fibLvls.forEach(fl=>{
      if(!fl.v||fl.v<minP||fl.v>maxP) return;
      const y=toY(fl.v);
      ctx.strokeStyle=fl.c;ctx.lineWidth=1;ctx.setLineDash([3,5]);
      ctx.beginPath();ctx.moveTo(PL,y);ctx.lineTo(W-PR-2,y);ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle=fl.c;ctx.font='7px JetBrains Mono';
      ctx.fillText('FIB '+fl.l,W-PR+4,y+3);
    });
    ctx.setLineDash([]);
  }

  // EMAs
  const allCloses=a.closes||closes;
  const drawEMA=(arr,col,lw)=>{
    const off=allCloses.length-80;
    ctx.strokeStyle=col;ctx.lineWidth=lw;ctx.setLineDash([]);
    ctx.beginPath();
    candles.forEach((_,i)=>{
      const v=arr[off+i];if(!v)return;
      const x=toX(i),y=toY(v);
      i===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
    });
    ctx.stroke();
  };
  if(allCloses.length>=21)  drawEMA(ema(allCloses,21),'rgba(139,92,246,.7)',1.5);
  if(allCloses.length>=50)  drawEMA(ema(allCloses,50),'rgba(14,165,233,.7)',1.5);
  if(allCloses.length>=200) drawEMA(ema(allCloses,200),'rgba(255,184,0,.85)',2);

  // Spring marker
  if(a.wy?.spring){
    candles.slice(-10).forEach((c,i,arr)=>{
      if(i>0&&c.l<arr[i-1].l&&c.c>arr[i-1].l){
        const xi=toX(candles.length-10+i);
        ctx.fillStyle='var(--orange)';ctx.font='bold 10px JetBrains Mono';
        ctx.fillText('⚡',xi-6,toY(c.l)+16);
        ctx.fillStyle='rgba(249,115,22,.7)';ctx.font='6px JetBrains Mono';
        ctx.fillText('SPRING',xi-12,toY(c.l)+25);
      }
    });
  }

  // BOS marker
  if(a.smc?.bosBull||a.smc?.bosBear){
    const x=toX(candles.length-5);
    ctx.strokeStyle=a.smc.bosBull?'rgba(0,255,136,.6)':'rgba(255,45,85,.6)';
    ctx.lineWidth=1.5;ctx.setLineDash([2,4]);
    ctx.beginPath();ctx.moveTo(x,PT);ctx.lineTo(x,H-PB);ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle=a.smc.bosBull?'rgba(0,255,136,.8)':'rgba(255,45,85,.8)';
    ctx.font='bold 7px JetBrains Mono';
    ctx.fillText('BOS',x-8,PT+10);
  }

  // Candles
  candles.forEach((c,i)=>{
    const x=toX(i),bull=c.c>=c.o;
    const col=bull?'#00FF88':'#FF2D55';
    const bodyT=Math.min(toY(c.o),toY(c.c));
    const bodyH=Math.max(1.5,Math.abs(toY(c.c)-toY(c.o)));
    ctx.strokeStyle=col;ctx.lineWidth=1;ctx.setLineDash([]);
    ctx.beginPath();ctx.moveTo(x,toY(c.h));ctx.lineTo(x,toY(c.l));ctx.stroke();
    ctx.fillStyle=bull?'rgba(0,255,136,.85)':'rgba(255,45,85,.85)';
    ctx.fillRect(x-bW/2,bodyT,bW,bodyH);
  });

  // Operational levels
  const drawLvl=(price,lbl,col,dash=[6,3],lw=1.5)=>{
    if(!price||price<minP||price>maxP) return;
    const y=toY(price);
    ctx.strokeStyle=col;ctx.lineWidth=lw;ctx.setLineDash(dash);
    ctx.beginPath();ctx.moveTo(PL,y);ctx.lineTo(W-PR-2,y);ctx.stroke();
    ctx.setLineDash([]);
    const lW=62,lH=15;
    ctx.fillStyle=col.replace('1)','0.12)').replace('0.9)','0.12)').replace(/rgba\\((\\d+),(\\d+),(\\d+),.+\\)/,(_,r,g,b)=>\`rgba(\${r},\${g},\${b},.12)\`);
    ctx.strokeStyle=col;ctx.lineWidth=1;
    ctx.beginPath();ctx.roundRect(W-PR+2,y-lH/2,lW,lH,3);ctx.fill();ctx.stroke();
    ctx.fillStyle=col;ctx.font='bold 7px JetBrains Mono';
    ctx.fillText(lbl,W-PR+6,y+2.5);
  };
  drawLvl(a.sl,    'STOP  ', '#FF2D55',[5,3],2);
  drawLvl(a.entry, 'ENTRADA','rgba(255,255,255,.9)',[],2);
  drawLvl(a.tp1,   'TP1   ','rgba(0,255,136,.55)',[5,3],1.5);
  drawLvl(a.tp2,   'TP2   ','rgba(0,255,136,.75)',[5,3],1.5);
  drawLvl(a.tp3,   'TP3   ','#00FF88',[5,3],2);

  // Current price tracker
  const cur=candles.at(-1)?.c||0;
  if(cur>=minP&&cur<=maxP){
    const y=toY(cur);
    ctx.strokeStyle='rgba(255,255,255,.2)';ctx.lineWidth=1;ctx.setLineDash([2,5]);
    ctx.beginPath();ctx.moveTo(PL,y);ctx.lineTo(W-PR-2,y);ctx.stroke();
    ctx.setLineDash([]);
  }

  // Mode badge
  ctx.fillStyle='rgba(4,7,15,.8)';ctx.fillRect(PL+4,PT+4,86,14);
  ctx.fillStyle='rgba(0,255,136,.8)';ctx.font='bold 7px JetBrains Mono';
  ctx.fillText('📈 '+(a.dir==='LONG'?'LONG':'SHORT')+' · '+a.phase,PL+8,PT+13);

  // Tooltip
  canvas.onmousemove=(ev)=>{
    const rect=canvas.getBoundingClientRect();
    const mx=(ev.clientX-rect.left)*DPR;
    const idx=Math.round((mx/DPR-PL)/cW*(candles.length-1));
    if(idx<0||idx>=candles.length) return;
    const c2=candles[idx];
    if(!c2) return;
    const tip=document.getElementById('chartTip');
    const dt=new Date(c2.t).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
    const chg=((c2.c-c2.o)/c2.o*100).toFixed(2);
    tip.innerHTML=\`\${dt}<br>O: $\${c2.o.toFixed(2)} H: $\${c2.h.toFixed(2)}<br>L: $\${c2.l.toFixed(2)} C: $\${c2.c.toFixed(2)}<br>Vol: \${(c2.v/1000).toFixed(0)}K · \${chg>=0?'+':''}\${chg}%\`;
    tip.style.display='block';
    tip.style.left=(ev.offsetX+12)+'px';
    tip.style.top=Math.max(4,(ev.offsetY-50))+'px';
  };
  canvas.onmouseleave=()=>{document.getElementById('chartTip').style.display='none';};
}

// ══ SIGNALS ═════════════════════════════════════════════════════════
function addSignal(s,animate){
  if(!s||signals.find(x=>x.id===s.id)) return;
  signals.unshift(s);
  if(signals.length>100) signals.length=100;
  renderFeed();
  updateTopBar();
  if(animate){playBeep();toast('🔥 '+s.symbol+' '+s.dir+' · Score '+(s.score>0?'+':'')+s.score+' · '+s.prob+'%');}
}

function renderFeed(){
  const list=document.getElementById('feedList');
  document.getElementById('feedBadge').textContent=signals.length+' sinais';
  if(!signals.length){
    list.innerHTML='<div class="empty-st"><div class="empty-icon">🎯</div><div style="font-size:10px">Nenhum sinal ainda</div></div>';
    return;
  }
  const pF=v=>!v?'—':v<0.001?v.toExponential(3):v<1?v.toFixed(4):v<100?v.toFixed(2):v.toFixed(0);
  list.innerHTML=signals.slice(0,30).map((s,i)=>{
    const sCol=s.dir==='LONG'?'var(--green)':'var(--red)';
    return \`<div class="sig-item\${i===0?' new':''}" onclick="selectPair('\${s.symbol}')">
      <div class="hot-badge">🔥 HOT</div>
      <div class="si-top">
        <div><div class="si-pair">\${s.symbol.replace('USDT','/USDT')}</div></div>
        <div class="si-score" style="color:\${sCol}">\${s.score>0?'+':''}\${s.score}</div>
      </div>
      <div class="si-meta">
        <span class="si-chip">\${s.dir}</span>
        <span class="si-chip">\${s.prob}%</span>
        <span class="si-chip">\${s.phase||'—'}</span>
        <span class="si-chip">RSI \${(s.rsi||0).toFixed?s.rsi.toFixed(0):s.rsi}</span>
        <span class="si-chip">Vol \${(s.volRatio||0).toFixed?s.volRatio.toFixed(1):s.volRatio}x</span>
        <span class="si-chip">R/R \${(s.rr||0).toFixed?s.rr.toFixed(1):s.rr}:1</span>
      </div>
      <div class="si-lvls">
        <div class="si-lv"><div class="si-lv-l">STOP</div><div class="si-lv-v" style="color:var(--red)">$\${pF(s.sl)}</div></div>
        <div class="si-lv"><div class="si-lv-l">ENTRADA</div><div class="si-lv-v">$\${pF(s.entry)}</div></div>
        <div class="si-lv"><div class="si-lv-l">TP2</div><div class="si-lv-v" style="color:var(--green)">$\${pF(s.tp2)}</div></div>
      </div>
      <div class="si-time">\${new Date(s.ts||Date.now()).toLocaleTimeString('pt-BR')}</div>
      <button class="btn-exec" onclick="execSig(\${s.id},event)">⚡ EXECUTAR OPERAÇÃO</button>
    </div>\`;
  }).join('');
}

async function execSig(id,ev){
  ev.stopPropagation();
  const s=signals.find(x=>x.id===id);
  if(!s) return;
  const bal=await api('/api/balances').then(d=>d?.bybit?.availableBalance||1000).catch(()=>1000);
  const r=await api('/api/execute/signal','POST',{signalId:id,balanceUSD:bal});
  toast(r?.ok?'✅ Ordem enviada: '+s.symbol:'❌ '+(r?.error||'Erro'));
}

function showDetail(a){
  selectPair(a.symbol);
}

// ══ AI NARRATION ════════════════════════════════════════════════════
function narrate(html){
  document.getElementById('narration').innerHTML=html;
}

// ══ AUDIO ═══════════════════════════════════════════════════════════
let actx=null;
function playBeep(){
  try{
    if(!actx) actx=new(window.AudioContext||window.webkitAudioContext)();
    const o=actx.createOscillator(),g=actx.createGain();
    o.connect(g);g.connect(actx.destination);
    o.frequency.value=880;
    g.gain.setValueAtTime(.15,actx.currentTime);
    g.gain.exponentialRampToValueAtTime(.001,actx.currentTime+.4);
    o.start();o.stop(actx.currentTime+.4);
  }catch{}
}

// ══ TOAST ═══════════════════════════════════════════════════════════
let tt;
function toast(msg){
  const el=document.getElementById('toast');
  el.textContent=msg;el.style.display='block';
  clearTimeout(tt);tt=setTimeout(()=>el.style.display='none',4000);
}

// Init grid on load
window.addEventListener('load',initGrid);
</script>
</body>
</html>
`;

app.get("/scanner", (req,res) => {
  res.setHeader("Content-Type","text/html; charset=utf-8");
  res.send(SCANNER_HTML);
});

// Frontend — dashboard embutido diretamente no servidor
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>ACS Trading Bot — Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Syne:wght@700;800&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet"/>
<style>
:root{
  --bg:#03050A;--bg2:#07090F;--bg3:#0C0F1A;--bg4:#111827;
  --green:#00E676;--red:#FF3D6B;--gold:#F59E0B;--blue:#3B82F6;
  --blue2:#60A5FA;--purple:#A78BFA;--orange:#FB923C;--cyan:#22D3EE;
  --text:#C8D6E5;--dim:#4A5568;--dim2:#2D3748;--line:rgba(255,255,255,.06);
  --mono:'JetBrains Mono',monospace;--disp:'Syne',sans-serif;--body:'Inter',sans-serif;
}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:var(--bg);color:var(--text);font-family:var(--body);min-height:100vh;-webkit-font-smoothing:antialiased;}

/* LOGIN */
#loginScreen{display:flex;align-items:center;justify-content:center;min-height:100vh;background:radial-gradient(ellipse 80% 60% at 50% 0%,rgba(0,230,118,.05),transparent 70%);}
.login-card{background:var(--bg2);border:1px solid var(--line);border-radius:20px;padding:40px 32px;width:100%;max-width:380px;display:flex;flex-direction:column;gap:14px;}
.login-logo{display:flex;align-items:center;gap:12px;}
.login-brand{font-family:var(--disp);font-size:18px;font-weight:800;color:#fff;}
.login-brand span{color:var(--green);}
.login-sub{font-family:var(--mono);font-size:9px;color:var(--dim);letter-spacing:2px;}
.login-input{background:var(--bg3);border:1px solid var(--line);border-radius:10px;padding:12px 16px;color:#fff;font-family:var(--mono);font-size:13px;outline:none;transition:.2s;}
.login-input:focus{border-color:rgba(0,230,118,.4);}
.login-btn{background:linear-gradient(135deg,var(--green),#00B0FF);color:#000;border:none;border-radius:10px;padding:13px;font-weight:800;font-size:14px;cursor:pointer;transition:.15s;}
.login-btn:hover{opacity:.88;}
.login-err{font-family:var(--mono);font-size:11px;color:var(--red);min-height:14px;}

/* APP */
#app{display:none;flex-direction:column;min-height:100vh;}

/* TOPBAR */
.topbar{display:flex;align-items:center;justify-content:space-between;padding:10px 20px;border-bottom:1px solid var(--line);background:rgba(3,5,10,.97);position:sticky;top:0;z-index:100;flex-wrap:wrap;gap:8px;}
.tb-brand{font-family:var(--disp);font-size:15px;font-weight:800;color:#fff;display:flex;align-items:center;gap:10px;}
.tb-brand span{color:var(--green);}
.ws-pill{display:flex;align-items:center;gap:5px;font-family:var(--mono);font-size:9px;padding:3px 10px;border-radius:5px;border:1px solid var(--line);}
.ws-pill.conn{background:rgba(0,230,118,.08);border-color:rgba(0,230,118,.2);color:var(--green);}
.ws-pill.disc{background:rgba(255,61,107,.08);border-color:rgba(255,61,107,.2);color:var(--red);}
.ws-dot{width:5px;height:5px;border-radius:50%;animation:blink 2s infinite;}
.conn .ws-dot{background:var(--green);box-shadow:0 0 6px var(--green);}
.disc .ws-dot{background:var(--red);}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
.tb-stats{display:flex;gap:6px;flex-wrap:wrap;}
.tb-stat{font-family:var(--mono);font-size:10px;background:var(--bg3);border:1px solid var(--line);border-radius:5px;padding:3px 9px;color:var(--dim);}
.tb-stat b{color:#fff;}
.tb-clock{font-family:var(--mono);font-size:11px;color:var(--dim);}

/* TABS */
.tabs{display:flex;border-bottom:1px solid var(--line);background:var(--bg2);padding:0 20px;overflow-x:auto;}
.tab{padding:13px 18px;font-size:13px;font-weight:600;color:var(--dim);cursor:pointer;border-bottom:2px solid transparent;transition:.15s;white-space:nowrap;flex-shrink:0;}
.tab.on{color:#fff;border-bottom-color:var(--green);}

/* MAIN */
.main{padding:20px;max-width:1400px;margin:0 auto;width:100%;}

/* GRID STATS */
.stats-row{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:20px;}
.stat-card{background:var(--bg2);border:1px solid var(--line);border-radius:12px;padding:14px 16px;}
.stat-val{font-family:var(--disp);font-size:26px;font-weight:800;color:#fff;line-height:1;}
.stat-lbl{font-family:var(--mono);font-size:8px;color:var(--dim);letter-spacing:1px;margin-top:4px;}
.stat-sub{font-family:var(--mono);font-size:9px;margin-top:2px;}

/* LAYOUT */
.layout2{display:grid;grid-template-columns:1fr 360px;gap:16px;}
.layout3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:16px;}

/* CARD */
.card{background:var(--bg2);border:1px solid var(--line);border-radius:14px;overflow:hidden;margin-bottom:14px;}
.card-head{display:flex;align-items:center;justify-content:space-between;padding:11px 16px;border-bottom:1px solid var(--line);}
.card-title{font-family:var(--mono);font-size:9px;color:var(--dim);letter-spacing:1.5px;}
.card-body{padding:14px 16px;}

/* BUTTONS */
.btn{padding:8px 16px;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;border:none;font-family:var(--body);transition:.15s;display:inline-flex;align-items:center;gap:6px;}
.btn-green{background:linear-gradient(135deg,var(--green),#00B0FF);color:#000;}
.btn-green:hover{filter:brightness(1.08);}
.btn-ghost{background:transparent;color:var(--text);border:1px solid var(--line);}
.btn-ghost:hover{border-color:rgba(255,255,255,.2);}
.btn-red{background:rgba(255,61,107,.12);color:var(--red);border:1px solid rgba(255,61,107,.2);}
.btn-gold{background:rgba(245,158,11,.12);color:var(--gold);border:1px solid rgba(245,158,11,.2);}
.btn-purple{background:rgba(167,139,250,.12);color:var(--purple);border:1px solid rgba(167,139,250,.2);}
.btn:disabled{opacity:.4;cursor:not-allowed;}

/* SIGNAL CARD */
.sig-card{background:var(--bg3);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:8px;position:relative;overflow:hidden;cursor:pointer;transition:.15s;}
.sig-card:hover{border-color:rgba(255,255,255,.1);}
.sig-card.long::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--green);}
.sig-card.short::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--red);}
.sig-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;}
.sig-pair{font-size:16px;font-weight:700;color:#fff;}
.sig-dir{font-family:var(--mono);font-size:10px;font-weight:800;padding:3px 10px;border-radius:4px;}
.dir-long{background:rgba(0,230,118,.1);color:var(--green);border:1px solid rgba(0,230,118,.25);}
.dir-short{background:rgba(255,61,107,.1);color:var(--red);border:1px solid rgba(255,61,107,.25);}
.sig-meta{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;}
.sig-chip{font-family:var(--mono);font-size:9px;background:var(--bg4);border:1px solid var(--line);border-radius:4px;padding:2px 7px;color:var(--text);}
.sig-levels{display:grid;grid-template-columns:1fr 1fr 1fr 1fr 1fr;gap:4px;margin-top:8px;}
.sig-lvl{background:var(--bg2);border:1px solid var(--line);border-radius:6px;padding:5px;text-align:center;}
.sig-lvl-lbl{font-family:var(--mono);font-size:7px;color:var(--dim);letter-spacing:.5px;}
.sig-lvl-val{font-family:var(--mono);font-size:10px;font-weight:700;margin-top:2px;}
.sig-factors{display:flex;gap:4px;flex-wrap:wrap;margin-top:8px;}
.sig-factor{font-family:var(--mono);font-size:8px;background:rgba(0,230,118,.08);border:1px solid rgba(0,230,118,.15);color:var(--green);padding:2px 6px;border-radius:3px;}
.sig-time{font-family:var(--mono);font-size:8px;color:var(--dim);margin-top:6px;}
.btn-exec-sig{position:absolute;top:10px;right:10px;font-family:var(--mono);font-size:9px;background:var(--green);color:#000;border:none;border-radius:5px;padding:4px 10px;cursor:pointer;font-weight:700;}

/* ARB CARD */
.arb-card{background:var(--bg3);border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:8px;position:relative;}
.arb-card.cross::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--green);}
.arb-card.triangular::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--blue2);}
.arb-card.funding::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--gold);}
.arb-card.basis::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--purple);}
.arb-profit{font-family:var(--disp);font-size:20px;font-weight:800;color:var(--green);}
.arb-type{font-family:var(--mono);font-size:8px;color:var(--dim);letter-spacing:1px;}
.arb-chips{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px;}
.arb-chip{font-family:var(--mono);font-size:9px;padding:2px 7px;border-radius:3px;border:1px solid;}
.chip-buy{background:rgba(0,230,118,.08);color:var(--green);border-color:rgba(0,230,118,.2);}
.chip-sell{background:rgba(255,61,107,.08);color:var(--red);border-color:rgba(255,61,107,.2);}
.chip-ex{background:rgba(59,130,246,.08);color:var(--blue2);border-color:rgba(59,130,246,.2);}
.btn-exec-arb{font-family:var(--mono);font-size:9px;background:rgba(0,230,118,.1);border:1px solid rgba(0,230,118,.2);color:var(--green);border-radius:5px;padding:4px 10px;cursor:pointer;margin-top:8px;font-weight:700;}

/* POSITION CARD */
.pos-card{background:var(--bg3);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:8px;}
.pos-card.profit-pos{border-left:3px solid var(--green);}
.pos-card.profit-neg{border-left:3px solid var(--red);}
.pos-head{display:flex;justify-content:space-between;margin-bottom:8px;}
.pos-pair{font-size:15px;font-weight:700;color:#fff;}
.pos-pnl{font-family:var(--disp);font-size:20px;font-weight:800;}
.pos-data{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;}
.pos-field label{font-family:var(--mono);font-size:8px;color:var(--dim);display:block;margin-bottom:2px;}
.pos-field span{font-family:var(--mono);font-size:12px;color:#fff;}

/* BALANCE CARD */
.bal-row{display:flex;align-items:center;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.04);}
.bal-row:last-child{border:none;}
.bal-ex{font-family:var(--mono);font-size:11px;font-weight:700;min-width:80px;}
.bal-val{font-family:var(--disp);font-size:18px;font-weight:800;color:#fff;flex:1;}
.bal-sub{font-family:var(--mono);font-size:9px;color:var(--dim);}

/* RISK GAUGE */
.risk-bar{height:8px;background:var(--bg4);border-radius:4px;overflow:hidden;margin:6px 0;}
.risk-fill{height:100%;border-radius:4px;transition:width .5s;}
.risk-ok{background:var(--green);}
.risk-warn{background:var(--gold);}
.risk-danger{background:var(--red);}

/* TRADE LOG */
.log-item{padding:8px 0;border-bottom:1px solid rgba(255,255,255,.04);font-family:var(--mono);font-size:10px;display:flex;align-items:center;gap:8px;}
.log-item:last-child{border:none;}
.log-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;}
.log-type{min-width:70px;font-weight:700;}
.log-sym{color:#fff;min-width:80px;}
.log-detail{color:var(--dim);flex:1;}
.log-time{color:var(--dim);font-size:9px;}

/* ANALYZE PANEL */
.analyze-form{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;}
.ana-input{background:var(--bg3);border:1px solid var(--line);border-radius:8px;padding:8px 12px;color:#fff;font-family:var(--mono);font-size:12px;outline:none;width:130px;}
.ana-sel{background:var(--bg3);border:1px solid var(--line);border-radius:8px;padding:8px 12px;color:#fff;font-family:var(--mono);font-size:12px;outline:none;}
.analyze-result{background:var(--bg3);border:1px solid var(--line);border-radius:10px;padding:16px;}
.ar-score-wrap{display:flex;align-items:center;gap:12px;margin-bottom:12px;}
.ar-score{font-family:var(--disp);font-size:48px;font-weight:800;line-height:1;}
.ar-prob{font-family:var(--mono);font-size:14px;margin-top:4px;}
.ar-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px;}
.ar-item{background:var(--bg2);border:1px solid var(--line);border-radius:8px;padding:10px;}
.ar-lbl{font-family:var(--mono);font-size:8px;color:var(--dim);letter-spacing:.5px;margin-bottom:3px;}
.ar-val{font-family:var(--mono);font-size:12px;font-weight:700;}
.ar-factors{display:flex;gap:4px;flex-wrap:wrap;}
.ar-factor{font-family:var(--mono);font-size:9px;background:rgba(0,230,118,.08);border:1px solid rgba(0,230,118,.15);color:var(--green);padding:2px 7px;border-radius:3px;}

/* SCAN PROGRESS */
.scan-prog{background:var(--bg3);border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin-bottom:10px;display:none;}
.prog-bar{height:4px;background:var(--bg4);border-radius:2px;overflow:hidden;margin-top:6px;}
.prog-fill{height:100%;background:linear-gradient(90deg,var(--green),var(--blue));border-radius:2px;transition:width .3s;}
.prog-lbl{font-family:var(--mono);font-size:9px;color:var(--dim);}

/* EMPTY */
.empty{text-align:center;padding:32px 20px;color:var(--dim);}
.empty-icon{font-size:32px;margin-bottom:8px;}
.empty-txt{font-family:var(--mono);font-size:10px;line-height:1.8;}

/* NEW badge */
.new-badge{position:absolute;top:8px;right:48px;font-family:var(--mono);font-size:8px;background:rgba(0,230,118,.15);border:1px solid rgba(0,230,118,.3);color:var(--green);padding:1px 6px;border-radius:3px;animation:fadeOut 5s forwards;}
@keyframes fadeOut{0%,60%{opacity:1}100%{opacity:0}}

/* TOAST */
#toast{position:fixed;bottom:20px;right:20px;background:var(--bg2);border:1px solid rgba(0,230,118,.3);border-radius:10px;padding:12px 18px;font-family:var(--mono);font-size:12px;color:var(--green);z-index:999;display:none;max-width:320px;box-shadow:0 4px 20px rgba(0,0,0,.5);}

::-webkit-scrollbar{width:4px;} ::-webkit-scrollbar-thumb{background:var(--dim2);border-radius:2px;}
@media(max-width:900px){.stats-row{grid-template-columns:repeat(3,1fr);}.layout2{grid-template-columns:1fr;}.layout3{grid-template-columns:1fr;}}
</style>
</head>
<body>

<!-- LOGIN -->
<div id="loginScreen">
  <div class="login-card">
    <div class="login-logo">
      <svg width="36" height="36" viewBox="0 0 200 200" fill="none">
        <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#00E676"/><stop offset="100%" stop-color="#00B0FF"/></linearGradient></defs>
        <circle cx="100" cy="100" r="77" stroke="url(#lg)" stroke-width="9" fill="none"/>
        <polyline points="55,148 100,52 145,148" stroke="url(#lg)" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      </svg>
      <div>
        <div class="login-brand">ACS <span>Trading Bot</span></div>
        <div class="login-sub">CEX + DEX · AUTO OPERATIONS</div>
      </div>
    </div>
    <div style="font-family:var(--mono);font-size:10px;color:var(--dim);background:var(--bg3);border:1px solid var(--line);border-radius:8px;padding:10px 14px;">
      🌐 <span id="detectedUrl" style="color:var(--green)"></span>
    </div>
    <input class="login-input" id="loginKey" placeholder="Admin Key..." type="password" onkeydown="if(event.key==='Enter')doLogin()"/>
    <button class="login-btn" onclick="doLogin()" id="loginBtn">ACESSAR DASHBOARD</button>
    <div class="login-err" id="loginErr"></div>
  </div>
</div>

<!-- APP -->
<div id="app">
  <div class="topbar">
    <div class="tb-brand">
      <svg width="24" height="24" viewBox="0 0 200 200" fill="none"><defs><linearGradient id="lg2" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#00E676"/><stop offset="100%" stop-color="#00B0FF"/></linearGradient></defs><circle cx="100" cy="100" r="77" stroke="url(#lg2)" stroke-width="9" fill="none"/><polyline points="55,148 100,52 145,148" stroke="url(#lg2)" stroke-width="9" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
      ACS <span>Bot</span>
    </div>
    <div class="ws-pill disc" id="wsPill"><div class="ws-dot"></div><span id="wsLbl">Desconectado</span></div>
    <div class="tb-stats">
      <div class="tb-stat">Sinais: <b id="tbSig">0</b></div>
      <div class="tb-stat">Arb: <b id="tbArb">0</b></div>
      <div class="tb-stat">Trades: <b id="tbTrades">0</b></div>
      <div class="tb-stat">P&L: <b id="tbPnl" style="color:var(--green)">—</b></div>
    </div>
    <div class="tb-clock" id="clock">—</div>
    <button class="btn btn-ghost" style="font-size:11px" onclick="doLogout()">sair</button>
  </div>

  <div class="tabs">
    <div class="tab on" onclick="switchTab('overview',this)">📊 Overview</div>
    <div class="tab" onclick="switchTab('signals',this)">🎯 Sinais</div>
    <div class="tab" onclick="switchTab('arb',this)">⚡ Arbitragem</div>
    <div class="tab" onclick="switchTab('positions',this)">📈 Posições</div>
    <div class="tab" onclick="switchTab('analyze',this)">🔍 Analisar</div>
    <div class="tab" onclick="switchTab('logs',this)">📋 Log</div>
  </div>

  <!-- ════ OVERVIEW ════ -->
  <div id="tab-overview" class="main">
    <div class="stats-row">
      <div class="stat-card"><div class="stat-val" id="ovSig">0</div><div class="stat-lbl">SINAIS</div><div class="stat-sub" style="color:var(--dim)">detectados</div></div>
      <div class="stat-card"><div class="stat-val" id="ovArb" style="color:var(--blue2)">0</div><div class="stat-lbl">ARB OPP</div><div class="stat-sub" style="color:var(--dim)">lucrativas</div></div>
      <div class="stat-card"><div class="stat-val" id="ovTrades" style="color:var(--green)">0</div><div class="stat-lbl">TRADES</div><div class="stat-sub" style="color:var(--dim)">executados</div></div>
      <div class="stat-card"><div class="stat-val" id="ovPnl">—</div><div class="stat-lbl">P&L DIÁRIO</div><div class="stat-sub" style="color:var(--dim)">USDT</div></div>
      <div class="stat-card"><div class="stat-val" id="ovPos">0</div><div class="stat-lbl">POSIÇÕES</div><div class="stat-sub" style="color:var(--dim)">abertas</div></div>
      <div class="stat-card"><div class="stat-val" id="ovWR" style="color:var(--gold)">—</div><div class="stat-lbl">WIN RATE</div><div class="stat-sub" style="color:var(--dim)">histórico</div></div>
    </div>

    <!-- Controles principais -->
    <div class="card">
      <div class="card-head"><div class="card-title">CONTROLES DO BOT</div><span id="scanStatus" style="font-family:var(--mono);font-size:9px;color:var(--dim)">Aguardando...</span></div>
      <div class="card-body">
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
          <button class="btn btn-green" id="btnFullScan" onclick="startScan('full')">⚡ Scan Completo</button>
          <button class="btn btn-ghost" id="btnQuickScan" onclick="startScan('quick')">🔍 Scan Rápido</button>
          <button class="btn btn-gold" id="btnAutoScan" onclick="toggleAuto()">🤖 Auto Scan</button>
          <button class="btn btn-purple" id="btnArbScan" onclick="startArbScan()">💹 Scan Arb</button>
          <button class="btn btn-ghost" onclick="loadBalances()">💰 Atualizar saldo</button>
        </div>
        <div class="scan-prog" id="scanProg">
          <div class="prog-lbl" id="scanLbl">Iniciando...</div>
          <div class="prog-bar"><div class="prog-fill" id="progFill" style="width:0%"></div></div>
        </div>
        <!-- Config rápido -->
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
          <div><div style="font-family:var(--mono);font-size:8px;color:var(--dim);margin-bottom:4px">EXCHANGE</div>
            <select id="cfgEx" style="width:100%;background:var(--bg3);border:1px solid var(--line);border-radius:6px;padding:6px;color:#fff;font-family:var(--mono);font-size:11px;outline:none">
              <option value="bybit">Bybit</option><option value="binance">Binance</option><option value="novadex">Novadex</option>
            </select></div>
          <div><div style="font-family:var(--mono);font-size:8px;color:var(--dim);margin-bottom:4px">TIMEFRAME</div>
            <select id="cfgTF" style="width:100%;background:var(--bg3);border:1px solid var(--line);border-radius:6px;padding:6px;color:#fff;font-family:var(--mono);font-size:11px;outline:none">
              <option value="15">15M</option><option value="60" selected>1H</option><option value="240">4H</option>
            </select></div>
          <div><div style="font-family:var(--mono);font-size:8px;color:var(--dim);margin-bottom:4px">AUTO EXEC SINAIS</div>
            <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
              <div class="toggle-sw" id="swSignals" onclick="toggleExec('signals')" style="width:34px;height:18px;background:var(--bg4);border-radius:9px;position:relative;cursor:pointer;border:1px solid var(--line)">
                <div style="position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;transition:.2s" id="swSigKnob"></div>
              </div>
              <span id="swSigLbl" style="font-family:var(--mono);font-size:9px;color:var(--dim)">OFF</span>
            </div></div>
          <div><div style="font-family:var(--mono);font-size:8px;color:var(--dim);margin-bottom:4px">AUTO EXEC ARB</div>
            <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
              <div class="toggle-sw" id="swArb" onclick="toggleExec('arb')" style="width:34px;height:18px;background:var(--bg4);border-radius:9px;position:relative;cursor:pointer;border:1px solid var(--line)">
                <div style="position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;transition:.2s" id="swArbKnob"></div>
              </div>
              <span id="swArbLbl" style="font-family:var(--mono);font-size:9px;color:var(--dim)">OFF</span>
            </div></div>
        </div>
      </div>
    </div>

    <div class="layout2">
      <!-- Saldos -->
      <div>
        <div class="card">
          <div class="card-head"><div class="card-title">SALDO POR EXCHANGE</div></div>
          <div class="card-body" id="balances">
            <div class="empty"><div class="empty-icon">💰</div><div class="empty-txt">Clique em "Atualizar saldo"</div></div>
          </div>
        </div>
        <!-- Últimos sinais -->
        <div class="card">
          <div class="card-head"><div class="card-title">ÚLTIMOS SINAIS</div><button class="btn btn-ghost" style="font-size:10px;padding:4px 10px" onclick="switchTab('signals',document.querySelectorAll('.tab')[1])">Ver todos</button></div>
          <div class="card-body" id="ovSignalsFeed">
            <div class="empty"><div class="empty-icon">📡</div><div class="empty-txt">Inicie um scan para ver sinais</div></div>
          </div>
        </div>
      </div>

      <!-- Risk + ARB recente -->
      <div>
        <div class="card">
          <div class="card-head"><div class="card-title">RISCO GLOBAL</div></div>
          <div class="card-body" id="riskPanel">
            <div style="display:flex;justify-content:space-between;margin-bottom:4px"><span style="font-family:var(--mono);font-size:10px;color:var(--dim)">Perda diária</span><span id="riskPnl" style="font-family:var(--mono);font-size:10px">—</span></div>
            <div class="risk-bar"><div class="risk-fill risk-ok" id="riskBarPnl" style="width:0%"></div></div>
            <div style="display:flex;justify-content:space-between;margin-top:8px;margin-bottom:4px"><span style="font-family:var(--mono);font-size:10px;color:var(--dim)">Posições abertas</span><span id="riskPos" style="font-family:var(--mono);font-size:10px">0 / 5</span></div>
            <div class="risk-bar"><div class="risk-fill risk-ok" id="riskBarPos" style="width:0%"></div></div>
            <div id="riskBlocked" style="display:none;margin-top:10px;background:rgba(255,61,107,.08);border:1px solid rgba(255,61,107,.2);border-radius:6px;padding:8px;font-family:var(--mono);font-size:10px;color:var(--red)"></div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">ARB RECENTE</div><button class="btn btn-ghost" style="font-size:10px;padding:4px 10px" onclick="switchTab('arb',document.querySelectorAll('.tab')[2])">Ver todas</button></div>
          <div class="card-body" id="ovArbFeed">
            <div class="empty"><div class="empty-icon">⚡</div><div class="empty-txt">Scan de arbitragem não iniciado</div></div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">LOG RECENTE</div></div>
          <div class="card-body" id="ovLog" style="max-height:200px;overflow-y:auto">
            <div class="empty"><div class="empty-txt">Sem atividade</div></div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ════ SINAIS ════ -->
  <div id="tab-signals" class="main" style="display:none">
    <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
      <button class="btn btn-green" onclick="startScan('full')">⚡ Scan Completo</button>
      <button class="btn btn-ghost" onclick="startScan('quick')">🔍 Rápido</button>
      <select id="sigFilter" style="background:var(--bg3);border:1px solid var(--line);border-radius:8px;padding:8px;color:#fff;font-family:var(--mono);font-size:11px;outline:none" onchange="renderSignals()">
        <option value="">Todos</option><option value="LONG">Só LONG</option><option value="SHORT">Só SHORT</option>
      </select>
    </div>
    <div id="signalsFeed"><div class="empty"><div class="empty-icon">🎯</div><div class="empty-txt">Inicie um scan para ver sinais</div></div></div>
  </div>

  <!-- ════ ARB ════ -->
  <div id="tab-arb" class="main" style="display:none">
    <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
      <button class="btn btn-purple" onclick="startArbScan()">💹 Scan Arbitragem</button>
      <select id="arbFilter" style="background:var(--bg3);border:1px solid var(--line);border-radius:8px;padding:8px;color:#fff;font-family:var(--mono);font-size:11px;outline:none" onchange="renderArb()">
        <option value="">Todos os tipos</option><option value="cross">Cross-Exchange</option><option value="triangular">Triangular</option><option value="funding">Funding Rate</option><option value="basis">Basis</option>
      </select>
    </div>
    <div id="arbFeed"><div class="empty"><div class="empty-icon">⚡</div><div class="empty-txt">Clique em Scan Arbitragem para começar</div></div></div>
  </div>

  <!-- ════ POSIÇÕES ════ -->
  <div id="tab-positions" class="main" style="display:none">
    <div style="display:flex;gap:8px;margin-bottom:14px">
      <button class="btn btn-ghost" onclick="loadPositions()">🔄 Atualizar</button>
    </div>
    <div id="positionsFeed"><div class="empty"><div class="empty-icon">📈</div><div class="empty-txt">Sem posições abertas</div></div></div>
  </div>

  <!-- ════ ANALISAR ════ -->
  <div id="tab-analyze" class="main" style="display:none">
    <div class="analyze-form">
      <input class="ana-input" id="anaPair" placeholder="BTCUSDT" value="BTCUSDT" style="text-transform:uppercase"/>
      <select class="ana-sel" id="anaTF"><option value="15">15M</option><option value="60" selected>1H</option><option value="240">4H</option><option value="D">1D</option></select>
      <select class="ana-sel" id="anaEx"><option value="bybit">Bybit</option><option value="binance">Binance</option><option value="novadex">Novadex</option></select>
      <button class="btn btn-green" onclick="analyzePair()">🔍 Analisar</button>
    </div>
    <div id="analyzeResult" style="display:none" class="analyze-result">
      <div class="ar-score-wrap">
        <div><div class="ar-score" id="arScore">—</div><div style="font-family:var(--mono);font-size:9px;color:var(--dim)">SCORE /26</div></div>
        <div><div class="ar-prob" id="arProb">—</div><div style="font-family:var(--mono);font-size:9px;color:var(--dim)">PROBABILIDADE</div></div>
        <div><div id="arDir" style="font-family:var(--mono);font-size:20px;font-weight:800">—</div><div style="font-family:var(--mono);font-size:9px;color:var(--dim)">DIREÇÃO</div></div>
        <div style="margin-left:auto"><div id="arPhase" style="font-family:var(--mono);font-size:11px">—</div><div style="font-family:var(--mono);font-size:9px;color:var(--dim)">WYCKOFF</div></div>
      </div>
      <div class="ar-grid">
        <div class="ar-item"><div class="ar-lbl">ENTRADA</div><div class="ar-val" id="arEntry">—</div></div>
        <div class="ar-item"><div class="ar-lbl">STOP LOSS</div><div class="ar-val" style="color:var(--red)" id="arSL">—</div></div>
        <div class="ar-item"><div class="ar-lbl">TP1</div><div class="ar-val" style="color:rgba(0,230,118,.7)" id="arTP1">—</div></div>
        <div class="ar-item"><div class="ar-lbl">TP2</div><div class="ar-val" style="color:rgba(0,230,118,.85)" id="arTP2">—</div></div>
        <div class="ar-item"><div class="ar-lbl">TP3</div><div class="ar-val" style="color:var(--green)" id="arTP3">—</div></div>
        <div class="ar-item"><div class="ar-lbl">R/R</div><div class="ar-val" style="color:var(--gold)" id="arRR">—</div></div>
        <div class="ar-item"><div class="ar-lbl">RSI</div><div class="ar-val" id="arRSI">—</div></div>
        <div class="ar-item"><div class="ar-lbl">VOLUME</div><div class="ar-val" id="arVol">—</div></div>
        <div class="ar-item"><div class="ar-lbl">EMA200</div><div class="ar-val" id="arEMA">—</div></div>
      </div>
      <div class="ar-factors" id="arFactors"></div>
      <div style="margin-top:12px">
        <button class="btn btn-green" id="btnExecAnalysis" onclick="execFromAnalysis()">⚡ Executar esta operação</button>
      </div>
    </div>
  </div>

  <!-- ════ LOG ════ -->
  <div id="tab-logs" class="main" style="display:none">
    <div style="display:flex;gap:8px;margin-bottom:14px">
      <button class="btn btn-ghost" onclick="loadTrades()">🔄 Atualizar</button>
      <button class="btn btn-ghost" onclick="document.getElementById('tradeLog').innerHTML='<div class=empty><div class=empty-txt>Limpo</div></div>'">🗑 Limpar view</button>
    </div>
    <div class="card"><div class="card-body" id="tradeLog" style="max-height:600px;overflow-y:auto">
      <div class="empty"><div class="empty-txt">Sem atividade registrada</div></div>
    </div></div>
  </div>
</div>

<div id="toast"></div>

<script>
// ══ ESTADO ══════════════════════════════════════════════════════════
let BOT_URL='', ADMIN_KEY='', ws=null;
let signals=[], arbOpps=[], lastAnalysis=null;
let autoScanOn=false, autoSigExec=false, autoArbExec=false;

// ══ LOGIN ═══════════════════════════════════════════════════════════
async function doLogin() {
  // URL é sempre o próprio servidor — sem digitar nada
  const origin = window.location.origin;
  const keyEl  = document.getElementById('loginKey');
  const err    = document.getElementById('loginErr');
  const btn    = document.getElementById('loginBtn');

  const key = (keyEl ? keyEl.value : '').trim();
  if (!key) { if(err) err.textContent='Digite a Admin Key.'; return; }

  if(err) err.textContent='';
  if(btn) { btn.disabled=true; btn.textContent='Verificando...'; }

  try {
    const r = await fetch(origin+'/health');
    if (!r.ok) throw new Error('Servidor retornou '+r.status);
    const h = await r.json();
    if (!h.ok) throw new Error('Health check falhou');

    const r2 = await fetch(origin+'/api/status', {
      headers: { 'x-admin-key': key }
    });
    if (r2.status === 401) throw new Error('Admin Key incorreta');
    if (!r2.ok) throw new Error('Erro '+r2.status+' ao verificar chave');

    BOT_URL   = origin;
    ADMIN_KEY = key;
    localStorage.setItem('acs_bot_url', origin);
    localStorage.setItem('acs_bot_key', key);

    document.getElementById('loginScreen').style.display='none';
    document.getElementById('app').style.display='flex';
    initApp();

  } catch(e) {
    if(err) err.textContent='❌ '+e.message;
    console.error('[LOGIN]', e);
  }

  if(btn) { btn.disabled=false; btn.textContent='ACESSAR DASHBOARD'; }
}

function doLogout() {
  localStorage.removeItem('acs_bot_url'); localStorage.removeItem('acs_bot_key');
  BOT_URL=''; ADMIN_KEY=''; if(ws)ws.close();
  document.getElementById('loginScreen').style.display='flex';
  document.getElementById('app').style.display='none';
}

(async () => {
  // Mostra URL detectada na tela de login
  const el = document.getElementById('detectedUrl');
  if (el) el.textContent = window.location.origin;

  // Auto-login se já tem chave salva
  const savedKey = localStorage.getItem('acs_bot_key');
  const origin   = window.location.origin;
  if (!savedKey) return;

  const keyEl = document.getElementById('loginKey');
  if (keyEl) keyEl.value = savedKey;

  try {
    const r = await fetch(origin+'/api/status', {
      headers: { 'x-admin-key': savedKey }
    });
    if (r.ok) {
      BOT_URL   = origin;
      ADMIN_KEY = savedKey;
      document.getElementById('loginScreen').style.display='none';
      document.getElementById('app').style.display='flex';
      initApp();
    }
  } catch {}
})();

// ══ INIT ════════════════════════════════════════════════════════════
function initApp() {
  connectWS();
  setInterval(()=>{ document.getElementById('clock').textContent=new Date().toLocaleTimeString('pt-BR'); }, 1000);
  loadStatus();
  setInterval(loadStatus, 30000);
}

// ══ WEBSOCKET ════════════════════════════════════════════════════════
function connectWS() {
  const proto = BOT_URL.startsWith('https')?'wss':'ws';
  const wsURL = proto+'://'+BOT_URL.replace(/^https?:\\/\\//,'');
  ws = new WebSocket(wsURL);

  ws.onopen = () => setPill(true);
  ws.onclose = () => { setPill(false); setTimeout(connectWS, 3000); };
  ws.onerror = () => ws.close();

  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    switch(msg.type) {
      case 'init':
        signals  = msg.data.signals  || [];
        arbOpps  = msg.data.arb      || [];
        updateStats(msg.data.stats);
        updateRisk(msg.data.risk);
        renderSignals(); renderArb(); renderOvFeeds();
        break;
      case 'pair_result':
        // Atualiza contador de pares analisados no overview
        { const el=document.getElementById('ovSig'); if(el&&msg.data.hot) el.textContent=parseInt(el.textContent||0)+1; }
        break;
      case 'signal':
        signals.unshift(msg.data);
        if(signals.length>200) signals.length=200;
        renderSignals(); renderOvFeeds();
        updateTopBar();
        toast(\`🎯 \${msg.data.symbol} \${msg.data.dir} · Score \${msg.data.score} · \${msg.data.prob}%\`);
        break;
      case 'arb':
        arbOpps.unshift(msg.data);
        if(arbOpps.length>100) arbOpps.length=100;
        renderArb(); renderOvFeeds();
        updateTopBar();
        toast(\`⚡ ARB \${msg.data.symbol||msg.data.path||'—'} +\${msg.data.profitNet||msg.data.diffPct||'—'}%\`);
        break;
      case 'scan_start':
        document.getElementById('scanProg').style.display='';
        document.getElementById('btnFullScan').disabled=true;
        document.getElementById('scanStatus').textContent='Scanning...';
        break;
      case 'scan_progress': {
        const done  = msg.data.done  || 0;
        const total = msg.data.total || 100;
        const sigs  = msg.data.signals || 0;
        const pct   = Math.round((done/total)*100);
        const progFill = document.getElementById('progFill');
        const scanLbl  = document.getElementById('scanLbl');
        if(progFill) progFill.style.width=pct+'%';
        if(scanLbl)  scanLbl.textContent=done+'/'+total+' analisados · '+sigs+' sinais';
        break;
      }
      case 'scan_done':
        document.getElementById('scanProg').style.display='none';
        document.getElementById('btnFullScan').disabled=false;
        document.getElementById('scanStatus').textContent='Último: '+new Date().toLocaleTimeString('pt-BR');
        loadStatus();
        break;
      case 'arb_scan_start':
        document.getElementById('btnArbScan').disabled=true;
        document.getElementById('btnArbScan').textContent='⏳ Escaneando...';
        break;
      case 'arb_scan_done':
        document.getElementById('btnArbScan').disabled=false;
        document.getElementById('btnArbScan').textContent='💹 Scan Arb';
        break;
      case 'trade':
        addLog({ type:'trade', ...msg.data.signal, result:msg.data.result });
        if(msg.data.result?.ok) toast(\`✅ Ordem executada: \${msg.data.signal?.symbol}\`,'success');
        else toast(\`❌ Erro: \${msg.data.result?.error}\`,'error');
        break;
      case 'error':
        toast('❌ '+msg.data.msg,'error');
        break;
    }
  };
}

function setPill(on) {
  const p=document.getElementById('wsPill');
  p.className='ws-pill '+(on?'conn':'disc');
  document.getElementById('wsLbl').textContent=on?'Conectado':'Reconectando...';
}

// ══ API ═════════════════════════════════════════════════════════════
const api = (path, method='GET', body=null) => {
  const base = BOT_URL || window.location.origin;
  const key  = ADMIN_KEY || localStorage.getItem('acs_bot_key') || '';
  return fetch(base+path, {
    method,
    headers: { 'x-admin-key':key, 'Content-Type':'application/json' },
    ...(body ? { body:JSON.stringify(body) } : {}),
  }).then(r=>{
    if(!r.ok && r.status===401) throw new Error('Admin Key inválida');
    return r.json();
  }).catch(e=>{ console.error('[API]',path,e.message); return { ok:false, error:e.message }; });
};

async function loadStatus() {
  const d = await api('/api/status').catch(()=>null);
  if (!d) return;
  updateStats(d.stats);
  updateRisk(d.risk);
  addLogItems(d.tradeLog||[]);
}

async function loadBalances() {
  const d = await api('/api/balances').catch(()=>null);
  if (!d) return;
  const exColors = { bybit:'#F7A600', binance:'#F3BA2F', novadex:'#A78BFA' };
  document.getElementById('balances').innerHTML = ['bybit','binance','novadex'].map(ex=>{
    const b = d[ex];
    if (b?.error) return \`<div class="bal-row"><div class="bal-ex" style="color:\${exColors[ex]}">\${ex}</div><div style="font-family:var(--mono);font-size:10px;color:var(--red)">\${b.error.slice(0,40)}</div></div>\`;
    return \`<div class="bal-row">
      <div class="bal-ex" style="color:\${exColors[ex]}">\${ex}</div>
      <div class="bal-val">$\${(b?.totalEquity||0).toFixed(2)}</div>
      <div>
        <div class="bal-sub">Disponível: $\${(b?.availableBalance||0).toFixed(2)}</div>
        <div class="bal-sub" style="color:\${(b?.unrealisedPnl||0)>=0?'var(--green)':'var(--red)'}">P&L: \${(b?.unrealisedPnl||0)>=0?'+':''}\${(b?.unrealisedPnl||0).toFixed(2)}</div>
      </div>
    </div>\`;
  }).join('');
}

async function loadPositions() {
  const d = await api('/api/positions').catch(()=>null);
  if (!d) return;
  updateRisk(d.riskStatus);
  const feed=document.getElementById('positionsFeed');
  if(!d.positions?.length){feed.innerHTML='<div class="empty"><div class="empty-icon">📈</div><div class="empty-txt">Sem posições abertas</div></div>';return;}
  feed.innerHTML=d.positions.map(p=>{
    const pnl=p.unrealisedPnl||0;
    return \`<div class="pos-card \${pnl>=0?'profit-pos':'profit-neg'}">
      <div class="pos-head">
        <div><div class="pos-pair">\${p.symbol}</div><div style="font-family:var(--mono);font-size:9px;color:var(--dim)">\${p.exchange} · \${p.side} · \${p.leverage||'—'}x</div></div>
        <div class="pos-pnl" style="color:\${pnl>=0?'var(--green)':'var(--red)'}">\${pnl>=0?'+':''}$\${pnl.toFixed(2)}</div>
      </div>
      <div class="pos-data">
        <div class="pos-field"><label>ENTRADA</label><span>$\${p.entryPrice}</span></div>
        <div class="pos-field"><label>TAMANHO</label><span>\${p.size}</span></div>
        <div class="pos-field"><label>LIQ. PRICE</label><span style="color:var(--red)">$\${p.liqPrice||'—'}</span></div>
      </div>
    </div>\`;
  }).join('');
}

async function loadTrades() {
  const d = await api('/api/trades').catch(()=>null);
  if (!d?.trades) return;
  addLogItems(d.trades);
}

// ══ SCAN CONTROLS ════════════════════════════════════════════════════
async function startScan(mode='full') {
  const ex = document.getElementById('cfgEx')?.value || 'bybit';
  const btn = document.getElementById('btnFullScan');
  if(btn) btn.disabled=true;
  try {
    const r = await api('/api/scan/start','POST',{mode,exchange:ex});
    if(!r?.ok) {
      toast('❌ Erro ao iniciar scan: '+(r?.msg||'Verifique a Admin Key'),'error');
      if(btn) btn.disabled=false;
    }
  } catch(e) {
    toast('❌ '+e.message,'error');
    if(btn) btn.disabled=false;
  }
}

async function startArbScan() {
  document.getElementById('btnArbScan').disabled=true;
  document.getElementById('btnArbScan').textContent='⏳ Escaneando...';
  await api('/api/arb/scan','POST');
}

async function toggleAuto() {
  autoScanOn=!autoScanOn;
  const btn=document.getElementById('btnAutoScan');
  await api('/api/scan/auto','POST',{enable:autoScanOn,intervalMin:15});
  btn.textContent=autoScanOn?'⏹ Parar Auto':'🤖 Auto Scan';
  btn.className='btn '+(autoScanOn?'btn-red':'btn-gold');
  toast(autoScanOn?'Auto-scan ativado (15min)':'Auto-scan desativado');
}

function toggleExec(type) {
  if(type==='signals') {
    autoSigExec=!autoSigExec;
    document.getElementById('swSigKnob').style.left=autoSigExec?'18px':'2px';
    document.getElementById('swSignals').style.background=autoSigExec?'var(--green)':'var(--bg4)';
    document.getElementById('swSigLbl').textContent=autoSigExec?'ON':'OFF';
    toast(autoSigExec?'⚠️ Execução automática de sinais ATIVADA':'Execução automática desativada');
  } else {
    autoArbExec=!autoArbExec;
    document.getElementById('swArbKnob').style.left=autoArbExec?'18px':'2px';
    document.getElementById('swArb').style.background=autoArbExec?'var(--green)':'var(--bg4)';
    document.getElementById('swArbLbl').textContent=autoArbExec?'ON':'OFF';
  }
}

// ══ ANALISAR ════════════════════════════════════════════════════════
async function analyzePair() {
  const sym = document.getElementById('anaPair').value.trim().toUpperCase();
  const tf  = document.getElementById('anaTF').value;
  const ex  = document.getElementById('anaEx').value;
  if (!sym) return;
  const btn = document.querySelector('#tab-analyze .btn-green');
  btn.disabled=true; btn.textContent='Analisando...';
  const d = await api(\`/api/analyze/\${sym}?tf=\${tf}&exchange=\${ex}\`).catch(e=>({ ok:false, error:e.message }));
  btn.disabled=false; btn.textContent='🔍 Analisar';
  if (!d.ok) { toast('Erro: '+d.error,'error'); return; }
  const a = d.analysis;
  lastAnalysis = a;
  const pF = v=>v<1?v.toFixed(5):v<100?v.toFixed(3):v.toFixed(2);
  const sCol = a.score>=4?'var(--green)':a.score<=-4?'var(--red)':'var(--dim)';
  document.getElementById('arScore').textContent=(a.score>0?'+':'')+a.score;
  document.getElementById('arScore').style.color=sCol;
  document.getElementById('arProb').textContent=a.prob+'%';
  document.getElementById('arProb').style.color=sCol;
  document.getElementById('arDir').textContent=a.dir;
  document.getElementById('arDir').style.color=sCol;
  document.getElementById('arPhase').textContent=a.phase||'—';
  document.getElementById('arEntry').textContent='$'+pF(a.entry);
  document.getElementById('arSL').textContent='$'+pF(a.sl);
  document.getElementById('arTP1').textContent='$'+pF(a.tp1);
  document.getElementById('arTP2').textContent='$'+pF(a.tp2);
  document.getElementById('arTP3').textContent='$'+pF(a.tp3);
  document.getElementById('arRR').textContent=(a.rr||0).toFixed(2)+':1';
  document.getElementById('arRSI').textContent=(a.rsi||0).toFixed(1);
  document.getElementById('arRSI').style.color=a.rsi>70?'var(--red)':a.rsi<30?'var(--green)':'var(--text)';
  document.getElementById('arVol').textContent=(a.volRatio||0).toFixed(2)+'x';
  document.getElementById('arVol').style.color=a.volRatio>1.5?'var(--green)':a.volRatio<0.7?'var(--red)':'var(--text)';
  document.getElementById('arEMA').textContent=a.cur>a.e200?'Acima':'Abaixo';
  document.getElementById('arEMA').style.color=a.cur>a.e200?'var(--green)':'var(--red)';
  document.getElementById('arFactors').innerHTML=(a.factors||[]).map(f=>\`<span class="ar-factor">\${f}</span>\`).join('');
  document.getElementById('analyzeResult').style.display='';
}

async function execFromAnalysis() {
  if (!lastAnalysis) return;
  const bal = await api('/api/balances').then(d=>d.bybit?.availableBalance||1000).catch(()=>1000);
  const sig = { ...lastAnalysis, id: Date.now(), exchange: document.getElementById('anaEx').value };
  const d   = await api('/api/execute/signal','POST',{ signalId: sig.id, balanceUSD: bal });
  toast(d.ok?'✅ Ordem enviada!':'❌ '+d.error, d.ok?'success':'error');
}

// ══ RENDER ═══════════════════════════════════════════════════════════
function renderSignals() {
  const fil  = document.getElementById('sigFilter')?.value;
  let list   = signals;
  if (fil)   list = list.filter(s=>s.dir===fil);
  const feed = document.getElementById('signalsFeed');
  if (!feed) return;
  if (!list.length) { feed.innerHTML='<div class="empty"><div class="empty-icon">🎯</div><div class="empty-txt">Nenhum sinal ainda</div></div>'; return; }
  const pF = v=>!v?'—':v<1?v.toFixed(5):v<100?v.toFixed(3):v.toFixed(2);
  feed.innerHTML = list.slice(0,40).map((s,i) => {
    const isNew = Date.now()-s.ts < 5000;
    const sCol  = s.dir==='LONG'?'var(--green)':'var(--red)';
    return \`<div class="sig-card \${s.dir.toLowerCase()}" onclick="quickSelect(\${s.id})">
      \${isNew?'<div class="new-badge">NOVO</div>':''}
      <div class="sig-head">
        <div>
          <div class="sig-pair">\${s.symbol}</div>
          <div style="font-family:var(--mono);font-size:9px;color:var(--dim)">\${s.exchange||'bybit'} · \${s.tf||'1H'} · Score <b style="color:\${sCol}">\${s.score>0?'+':''}\${s.score}</b> · \${s.prob}%</div>
        </div>
        <div class="sig-dir \${s.dir==='LONG'?'dir-long':'dir-short'}">\${s.dir}</div>
      </div>
      <div class="sig-meta">
        <span class="sig-chip">RSI \${(s.rsi||0).toFixed(0)}</span>
        <span class="sig-chip">Vol \${(s.volRatio||0).toFixed(1)}x</span>
        <span class="sig-chip">\${s.phase||'—'}</span>
        \${s.spring?'<span class="sig-chip" style="color:var(--orange)">⚡ Spring</span>':''}
        \${s.bosBull||s.bosBear?'<span class="sig-chip" style="color:var(--blue2)">BOS</span>':''}
        <span class="sig-chip">R/R \${(s.rr||0).toFixed(1)}:1</span>
      </div>
      <div class="sig-levels">
        <div class="sig-lvl"><div class="sig-lvl-lbl">STOP</div><div class="sig-lvl-val" style="color:var(--red)">$\${pF(s.sl)}</div></div>
        <div class="sig-lvl"><div class="sig-lvl-lbl">ENTRADA</div><div class="sig-lvl-val">$\${pF(s.entry)}</div></div>
        <div class="sig-lvl"><div class="sig-lvl-lbl">TP1</div><div class="sig-lvl-val" style="color:rgba(0,230,118,.7)">$\${pF(s.tp1)}</div></div>
        <div class="sig-lvl"><div class="sig-lvl-lbl">TP2</div><div class="sig-lvl-val" style="color:rgba(0,230,118,.85)">$\${pF(s.tp2)}</div></div>
        <div class="sig-lvl"><div class="sig-lvl-lbl">TP3</div><div class="sig-lvl-val" style="color:var(--green)">$\${pF(s.tp3)}</div></div>
      </div>
      <div class="sig-factors">\${(s.factors||[]).slice(0,5).map(f=>\`<span class="sig-factor">\${f}</span>\`).join('')}</div>
      <div class="sig-time">\${new Date(s.ts||Date.now()).toLocaleString('pt-BR')}</div>
      <button class="btn-exec-sig" onclick="execSignal(\${s.id},event)">⚡ EXECUTAR</button>
    </div>\`;
  }).join('');
}

function renderArb() {
  const fil  = document.getElementById('arbFilter')?.value;
  let list   = arbOpps;
  if (fil)   list = list.filter(o=>o.type===fil);
  const feed = document.getElementById('arbFeed');
  if (!feed) return;
  if (!list.length) { feed.innerHTML='<div class="empty"><div class="empty-icon">⚡</div><div class="empty-txt">Nenhuma oportunidade encontrada</div></div>'; return; }
  feed.innerHTML = list.slice(0,30).map(o => {
    const profit = parseFloat(o.profitNet||o.diffPct||Math.abs(o.basis)||0);
    const typeCol = o.type==='cross'?'var(--green)':o.type==='triangular'?'var(--blue2)':o.type==='funding'?'var(--gold)':'var(--purple)';
    const typeLbl = o.type==='cross'?'CROSS-EXCHANGE':o.type==='triangular'?'TRIANGULAR':o.type==='funding'?'FUNDING ARB':'SPOT-FUTURES';
    let chips='';
    if(o.type==='cross') chips=\`<span class="arb-chip chip-buy">BUY \${o.buyExchange}</span><span class="arb-chip chip-sell">SELL \${o.sellExchange}</span><span class="arb-chip chip-ex">$\${parseFloat(o.buyPrice||0).toFixed(2)} → $\${parseFloat(o.sellPrice||0).toFixed(2)}</span>\`;
    else if(o.type==='triangular') chips=\`<span class="arb-chip chip-ex">\${o.path}</span>\`;
    else if(o.type==='funding') chips=\`<span class="arb-chip chip-buy">LONG \${o.longAt}</span><span class="arb-chip chip-sell">SHORT \${o.shortAt}</span><span class="arb-chip chip-ex">APY ~\${parseFloat(o.annualized||0).toFixed(1)}%</span>\`;
    else chips=\`<span class="arb-chip chip-ex">\${o.direction||'—'}</span>\`;
    return \`<div class="arb-card \${o.type}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <div class="arb-type" style="color:\${typeCol}">\${typeLbl}</div>
          <div style="font-size:15px;font-weight:700;color:#fff;margin-top:2px">\${o.symbol||o.path||'—'}</div>
        </div>
        <div class="arb-profit">+\${profit.toFixed(3)}%</div>
      </div>
      <div class="arb-chips">\${chips}</div>
      <div style="font-family:var(--mono);font-size:8px;color:var(--dim);margin-top:4px">\${new Date(o.ts||Date.now()).toLocaleTimeString('pt-BR')}</div>
      <button class="btn-exec-arb" onclick="execArb(\${o.id},event)">⚡ Executar arb</button>
    </div>\`;
  }).join('');
}

function renderOvFeeds() {
  const ovSig = document.getElementById('ovSignalsFeed');
  const ovArb = document.getElementById('ovArbFeed');
  if (!signals.length) {
    ovSig.innerHTML='<div class="empty"><div class="empty-icon">📡</div><div class="empty-txt">Inicie um scan</div></div>';
  } else {
    const pF = v=>!v?'—':v<100?v.toFixed(3):v.toFixed(2);
    ovSig.innerHTML = signals.slice(0,3).map(s=>{
      const sCol=s.dir==='LONG'?'var(--green)':'var(--red)';
      return \`<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.04)">
        <div><div style="font-size:13px;font-weight:700;color:#fff">\${s.symbol}</div><div style="font-family:var(--mono);font-size:8px;color:var(--dim)">\${s.phase||'—'} · \${new Date(s.ts).toLocaleTimeString('pt-BR')}</div></div>
        <div style="text-align:right"><div style="font-family:var(--mono);font-size:12px;color:\${sCol};font-weight:700">\${s.dir} \${s.prob}%</div><div style="font-family:var(--mono);font-size:9px;color:var(--dim)">SL $\${pF(s.sl)}</div></div>
      </div>\`;
    }).join('');
  }
  if (!arbOpps.length) {
    ovArb.innerHTML='<div class="empty"><div class="empty-icon">⚡</div><div class="empty-txt">Sem oportunidades</div></div>';
  } else {
    ovArb.innerHTML = arbOpps.slice(0,3).map(o=>{
      const profit=parseFloat(o.profitNet||o.diffPct||0);
      return \`<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.04)">
        <div><div style="font-size:13px;font-weight:700;color:#fff">\${o.symbol||o.path||'—'}</div><div style="font-family:var(--mono);font-size:8px;color:var(--dim)">\${o.type} · \${o.buyExchange||o.exchange||'—'}</div></div>
        <div style="font-family:var(--disp);font-size:16px;font-weight:800;color:var(--green)">+\${profit.toFixed(3)}%</div>
      </div>\`;
    }).join('');
  }
}

// ══ EXECUTE ══════════════════════════════════════════════════════════
async function execSignal(sigId, ev) {
  ev.stopPropagation();
  const s = signals.find(x=>x.id===sigId);
  if (!s) return;
  const bal = await api('/api/balances').then(d=>d.bybit?.availableBalance||1000).catch(()=>1000);
  const d   = await api('/api/execute/signal','POST',{ signalId:sigId, balanceUSD:bal });
  toast(d.ok?'✅ Ordem enviada: '+s.symbol:'❌ '+d.error, d.ok?'success':'error');
}

async function execArb(oppId, ev) {
  ev.stopPropagation();
  const d = await api('/api/execute/arb','POST',{ oppId });
  toast(d.ok?'✅ Arb executada!':'❌ '+d.error, d.ok?'success':'error');
}

function quickSelect(sigId) { /* selecionar sinal — expande detalhes futuramente */ }

// ══ STATS ══════════════════════════════════════════════════════════
function updateStats(s) {
  if (!s) return;
  document.getElementById('ovSig').textContent    = s.signalsSent||0;
  document.getElementById('ovArb').textContent    = s.arbFound||0;
  document.getElementById('ovTrades').textContent  = s.tradesExecuted||0;
  document.getElementById('tbSig').textContent    = s.signalsSent||0;
  document.getElementById('tbArb').textContent    = s.arbFound||0;
  document.getElementById('tbTrades').textContent  = s.tradesExecuted||0;
}

function updateRisk(r) {
  if (!r) return;
  document.getElementById('ovPos').textContent  = r.openCount||0;
  document.getElementById('riskPos').textContent = \`\${r.openCount||0} / 5\`;
  const posW = ((r.openCount||0)/5)*100;
  document.getElementById('riskBarPos').style.width=posW+'%';
  document.getElementById('riskBarPos').className='risk-fill '+(posW>=80?'risk-danger':posW>=60?'risk-warn':'risk-ok');
  if (r.blocked) {
    const el=document.getElementById('riskBlocked');
    el.style.display=''; el.textContent='🚫 '+r.blockedReason;
  } else {
    document.getElementById('riskBlocked').style.display='none';
  }
}

function updateTopBar() {
  document.getElementById('tbSig').textContent  = signals.length;
  document.getElementById('tbArb').textContent  = arbOpps.length;
}

// ══ LOG ══════════════════════════════════════════════════════════════
const logItems = [];
function addLog(item) {
  logItems.unshift(item);
  if (logItems.length>200) logItems.length=200;
  renderLog();
}
function addLogItems(items) {
  items.forEach(i => { if(!logItems.find(x=>x.ts===i.ts)) logItems.push(i); });
  logItems.sort((a,b)=>new Date(b.ts)-new Date(a.ts));
  if(logItems.length>200) logItems.length=200;
  renderLog();
}
function renderLog() {
  const cols = { opened:'var(--green)', closed:'var(--blue2)', arb:'var(--purple)', error:'var(--red)', blocked:'var(--gold)', trade:'var(--green)' };
  const html = logItems.slice(0,50).map(l=>{
    const col  = cols[l.type]||'var(--dim)';
    const dt   = new Date(l.ts).toLocaleTimeString('pt-BR');
    const det  = l.result?.ok===false ? l.result.error : l.symbol||l.path||l.reason||'—';
    return \`<div class="log-item">
      <div class="log-dot" style="background:\${col}"></div>
      <div class="log-type" style="color:\${col}">\${(l.type||'').toUpperCase()}</div>
      <div class="log-sym">\${l.symbol||l.type||'—'}</div>
      <div class="log-detail">\${det?.toString().slice(0,60)||''}</div>
      <div class="log-time">\${dt}</div>
    </div>\`;
  }).join('');
  ['ovLog','tradeLog'].forEach(id=>{
    const el=document.getElementById(id);
    if(el) el.innerHTML=html||'<div class="empty"><div class="empty-txt">Sem atividade</div></div>';
  });
}

// ══ TABS ═════════════════════════════════════════════════════════════
function switchTab(id, el) {
  document.querySelectorAll('.main').forEach(m=>m.style.display='none');
  document.getElementById('tab-'+id).style.display='';
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('on'));
  if(el) el.classList.add('on');
  if(id==='positions') loadPositions();
  if(id==='logs')      loadTrades();
}

// ══ TOAST ════════════════════════════════════════════════════════════
let tt;
function toast(msg, type='success') {
  const el=document.getElementById('toast');
  el.textContent=msg;
  el.style.display='block';
  el.style.borderColor=type==='error'?'rgba(255,61,107,.3)':'rgba(0,230,118,.3)';
  el.style.color=type==='error'?'var(--red)':'var(--green)';
  clearTimeout(tt); tt=setTimeout(()=>el.style.display='none',4000);
}
</script>
</body>
</html>
`;

app.get("/", (req,res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(DASHBOARD_HTML);
});

// ── Inicialização ──────────────────────────────────────────────────────

// ── Testa conectividade com as exchanges ─────────────────────────────
app.get("/api/ping", async (req,res) => {
  const results = {};
  await Promise.allSettled([
    Bybit.ticker("BTCUSDT","linear")
      .then(t => { results.bybit   = { ok:true, bid:t.bid, ask:t.ask }; })
      .catch(e => { results.bybit  = { ok:false, error:e.message.slice(0,150) }; }),
    Binance.ticker("BTCUSDT")
      .then(t => { results.binance = { ok:true, bid:t.bid, ask:t.ask }; })
      .catch(e => { results.binance= { ok:false, error:e.message.slice(0,150) }; }),
    Novadex.ticker("BTCUSDT")
      .then(t => { results.novadex = { ok:true, last:t.last }; })
      .catch(e => { results.novadex= { ok:false, error:e.message.slice(0,150) }; }),
  ]);
  const allOk = Object.values(results).every(r=>r.ok);
  res.json({ ok:allOk, results, region:process.env.RAILWAY_REGION||"unknown", ts:Date.now() });
});

server.listen(cfg.port, () => {
  console.log(`\n╔═══════════════════════════════════════╗`);
  console.log(`║  ACS Trading Bot — rodando na :${cfg.port}  ║`);
  console.log(`╠═══════════════════════════════════════╣`);
  console.log(`║  Exchanges: Bybit · Binance · Novadex ║`);
  console.log(`║  Auto-scan: ${cfg.signals.autoExecute?"ATIVO":"desativado"} (sinais)           ║`);
  console.log(`║  Auto-arb:  ${cfg.arb.autoExecute?"ATIVO":"desativado"} (arbitragem)      ║`);
  console.log(`╚═══════════════════════════════════════╝\n`);

  // Testa conectividade Bybit no boot
  if (typeof testBybitConnectivity === 'function') {
    testBybitConnectivity().then(endpoint => {
      if (endpoint) console.log(`[BOT] Bybit OK via ${endpoint}`);
      else console.warn("[BOT] ⚠️  Bybit bloqueada — verifique a região do servidor");
    }).catch(e => console.warn("[BOT] Bybit connectivity check:", e.message));
  }

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
