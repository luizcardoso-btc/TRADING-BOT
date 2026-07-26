/**
 * executor.js — Executa ordens nas exchanges de forma segura
 * Valida risco, calcula tamanho, envia ordem e monitora posição
 */
"use strict";

const { Bybit, Binance, Novadex } = require("./exchanges");
const risk = require("./risk");
const cfg  = require("./config");

const EXCHANGES = { bybit: Bybit, binance: Binance, novadex: Novadex };

// Log de operações
const tradeLog = [];
function addLog(entry) {
  tradeLog.unshift({ ...entry, ts: new Date().toISOString() });
  if (tradeLog.length > 500) tradeLog.length = 500;
}

// ── EXECUTA SINAL ─────────────────────────────────────────────────────
async function executeSignal(signal, balanceUSD = 1000) {
  const ex = EXCHANGES[signal.exchange || cfg.signals.defaultExchange];
  if (!ex) return { ok:false, error:"Exchange não configurada" };
  if (!cfg.bybit.apiKey && signal.exchange !== "novadex")
    return { ok:false, error:"Chave API não configurada para " + (signal.exchange||"bybit") };

  // 1. Verificação de risco
  const check = risk.canTrade(signal, balanceUSD);
  if (!check.ok) {
    addLog({ type:"blocked", symbol:signal.symbol, reason:check.reason });
    return { ok:false, error:check.reason };
  }

  // 2. Tamanho da posição
  const qty = risk.positionSize(signal, balanceUSD);
  if (qty <= 0) return { ok:false, error:"Tamanho de posição calculado como zero" };

  // 3. Envia ordem
  try {
    const side   = signal.dir === "LONG" ? "Buy" : "Sell";
    const result = await ex.placeOrder({
      symbol:   signal.symbol,
      side,
      qty:      +qty.toFixed(3),
      sl:       +signal.sl.toFixed(4),
      tp:       +signal.tp2.toFixed(4), // TP2 como take profit principal
      leverage: cfg.signals.defaultLeverage,
    });

    const pos = {
      symbol:     signal.symbol,
      side,
      qty,
      entryPrice: signal.entry,
      sl:         signal.sl,
      tp1:        signal.tp1,
      tp2:        signal.tp2,
      tp3:        signal.tp3,
      tpHit:      0,
      exchange:   signal.exchange || cfg.signals.defaultExchange,
      score:      signal.score,
      orderId:    result?.result?.orderId || result?.orderId || "—",
    };

    risk.addPosition(signal.symbol, pos);
    addLog({ type:"opened", ...pos, result });
    return { ok:true, pos, orderId: pos.orderId };

  } catch(e) {
    addLog({ type:"error", symbol:signal.symbol, error:e.message });
    return { ok:false, error:e.message };
  }
}

// ── EXECUTA ARB ───────────────────────────────────────────────────────
async function executeArb(opp) {
  if (!cfg.arb.autoExecute)
    return { ok:false, error:"Execução automática de arb desativada (ARB_AUTO_EXECUTE=false)" };

  const buyEx  = EXCHANGES[opp.buyExchange];
  const sellEx = EXCHANGES[opp.sellExchange];
  if (!buyEx || !sellEx) return { ok:false, error:"Exchange não encontrada" };

  const qty = cfg.arb.maxPositionUSD / opp.buyPrice;

  try {
    const [buyResult, sellResult] = await Promise.all([
      buyEx.placeOrder({ symbol:opp.symbol, side:"Buy",  qty:+qty.toFixed(4) }),
      sellEx.placeOrder({ symbol:opp.symbol, side:"Sell", qty:+qty.toFixed(4) }),
    ]);
    const log = { type:"arb", symbol:opp.symbol, buy:opp.buyExchange, sell:opp.sellExchange, profitNet:opp.profitNet, qty, buyResult, sellResult };
    addLog(log);
    return { ok:true, log };
  } catch(e) {
    addLog({ type:"arb_error", symbol:opp.symbol, error:e.message });
    return { ok:false, error:e.message };
  }
}

// ── MONITORA POSIÇÕES ABERTAS ─────────────────────────────────────────
async function monitorPositions() {
  const status = risk.status();
  for (const pos of status.positions) {
    try {
      const ex = EXCHANGES[pos.exchange];
      if (!ex) continue;
      const ticker = await ex.ticker(pos.sym);
      const action = risk.updatePosition(pos.sym, ticker.last);
      if (!action) continue;

      if (action.action === "close" || action.action === "partial_close") {
        const closeQty  = action.closeQty || pos.qty;
        const closeSide = pos.side === "Buy" ? "Sell" : "Buy";
        await ex.placeOrder({ symbol:pos.sym, side:closeSide, qty:closeQty }).catch(()=>{});
        if (action.action === "close") {
          const pnl = (ticker.last - pos.entryPrice) * pos.qty * (pos.side==="Buy"?1:-1);
          risk.closePosition(pos.sym, pnl);
          addLog({ type:"closed", symbol:pos.sym, reason:action.reason, pnl });
        } else {
          addLog({ type:"partial_tp", symbol:pos.sym, tp:action.tp, closeQty });
        }
      }
    } catch(e) {
      console.warn(`[EXECUTOR] monitor ${pos.sym}:`, e.message);
    }
  }
}

// Inicia monitor a cada 30s
let monitorInterval = null;
function startMonitor() {
  if (monitorInterval) return;
  monitorInterval = setInterval(monitorPositions, 30000);
}
function stopMonitor() {
  if (monitorInterval) { clearInterval(monitorInterval); monitorInterval = null; }
}

module.exports = { executeSignal, executeArb, monitorPositions, startMonitor, stopMonitor, tradeLog };
