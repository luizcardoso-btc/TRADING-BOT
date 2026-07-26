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
    <input class="login-input" id="loginUrl" placeholder="URL do bot (https://...railway.app)" type="url"/>
    <input class="login-input" id="loginKey" placeholder="Admin Key..." type="password" onkeydown="if(event.key==='Enter')doLogin()"/>
    <button class="login-btn" onclick="doLogin()" id="loginBtn">CONECTAR AO BOT</button>
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
  const url = document.getElementById('loginUrl').value.trim().replace(/\\/$/,'');
  const key = document.getElementById('loginKey').value.trim();
  const err = document.getElementById('loginErr');
  const btn = document.getElementById('loginBtn');
  if (!url||!key) { err.textContent='Preencha a URL e a Admin Key.'; return; }
  err.textContent=''; btn.disabled=true; btn.textContent='Conectando...';
  try {
    const r = await fetch(url+'/health');
    if (!r.ok) throw new Error('Bot não respondeu ('+r.status+')');
    const r2 = await fetch(url+'/api/status', { headers:{'x-admin-key':key} });
    if (!r2.ok) throw new Error('Admin Key inválida');
    BOT_URL=url; ADMIN_KEY=key;
    localStorage.setItem('acs_bot_url', url);
    localStorage.setItem('acs_bot_key', key);
    document.getElementById('loginScreen').style.display='none';
    document.getElementById('app').style.display='flex';
    initApp();
  } catch(e) { err.textContent='Erro: '+e.message; }
  btn.disabled=false; btn.textContent='CONECTAR AO BOT';
}

function doLogout() {
  localStorage.removeItem('acs_bot_url'); localStorage.removeItem('acs_bot_key');
  BOT_URL=''; ADMIN_KEY=''; if(ws)ws.close();
  document.getElementById('loginScreen').style.display='flex';
  document.getElementById('app').style.display='none';
}

(async () => {
  const url = localStorage.getItem('acs_bot_url');
  const key = localStorage.getItem('acs_bot_key');
  if (!url||!key) return;
  document.getElementById('loginUrl').value=url;
  document.getElementById('loginKey').value=key;
  BOT_URL=url; ADMIN_KEY=key;
  try {
    const r = await fetch(url+'/api/status', { headers:{'x-admin-key':key} });
    if (r.ok) {
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
      case 'scan_progress':
        const pct = Math.round((msg.data.done/msg.data.total)*100);
        document.getElementById('progFill').style.width=pct+'%';
        document.getElementById('scanLbl').textContent=\`\${msg.data.done}/\${msg.data.total} analisados · \${msg.data.signals} sinais\`;
        break;
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
const api = (path, method='GET', body=null) =>
  fetch(BOT_URL+path, {
    method,
    headers: { 'x-admin-key':ADMIN_KEY, 'Content-Type':'application/json' },
    ...(body ? { body:JSON.stringify(body) } : {}),
  }).then(r=>r.json());

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
  const ex=document.getElementById('cfgEx')?.value||'bybit';
  await api('/api/scan/start','POST',{mode,exchange:ex});
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
