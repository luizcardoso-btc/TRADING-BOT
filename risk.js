/**
 * risk.js — Gerenciador de risco global
 * Controla tamanho de posição, P&L diário, posições abertas e trailing stop
 */
"use strict";

const cfg = require("./config");

class RiskManager {
  constructor() {
    this.dailyPnl       = 0;
    this.dailyStart     = Date.now();
    this.openPositions  = new Map(); // symbol → position
    this.executedToday  = 0;
    this.blockedReason  = null;
  }

  resetDaily() {
    const now = Date.now();
    if (now - this.dailyStart > 86400000) {
      this.dailyPnl      = 0;
      this.dailyStart    = now;
      this.executedToday = 0;
      this.blockedReason = null;
    }
  }

  // Verifica se pode operar
  canTrade(signal, balance) {
    this.resetDaily();

    if (this.blockedReason)
      return { ok:false, reason: this.blockedReason };

    if (this.openPositions.size >= cfg.risk.maxOpenPositions)
      return { ok:false, reason:`Limite de ${cfg.risk.maxOpenPositions} posições abertas atingido` };

    if (this.openPositions.has(signal.symbol))
      return { ok:false, reason:`Já existe posição aberta em ${signal.symbol}` };

    const dailyLossPct = balance > 0 ? (-this.dailyPnl / balance) * 100 : 0;
    if (dailyLossPct >= cfg.risk.maxDailyLoss) {
      this.blockedReason = `Limite de perda diária ${cfg.risk.maxDailyLoss}% atingido`;
      return { ok:false, reason: this.blockedReason };
    }

    if (signal.riskPct > cfg.risk.maxPositionSizeUSD / balance * 100 + 1)
      return { ok:false, reason:"Risco por operação excede o limite" };

    return { ok:true };
  }

  // Calcula tamanho da posição (Kelly Criterion simplificado)
  positionSize(signal, balance) {
    const riskUSD    = Math.min(balance * cfg.risk.maxPositionSizeUSD / 10000, cfg.risk.maxPositionSizeUSD);
    const stopDist   = Math.abs(signal.entry - signal.sl);
    if (stopDist <= 0) return 0;
    const contracts  = riskUSD / stopDist;
    const notional   = contracts * signal.entry;
    // Limita ao tamanho máximo de posição
    const maxContracts = cfg.risk.maxPositionSizeUSD / signal.entry;
    return +Math.min(contracts, maxContracts).toFixed(6);
  }

  // Registra posição aberta
  addPosition(symbol, pos) {
    this.openPositions.set(symbol, { ...pos, openAt: Date.now(), peak: pos.entryPrice });
    this.executedToday++;
  }

  // Atualiza preço atual e verifica trailing stop
  updatePosition(symbol, currentPrice) {
    const pos = this.openPositions.get(symbol);
    if (!pos) return null;
    const isLong = pos.side === "Buy";
    // Atualiza pico
    if (isLong  && currentPrice > pos.peak) pos.peak = currentPrice;
    if (!isLong && currentPrice < pos.peak) pos.peak = currentPrice;

    // Trailing stop
    if (cfg.risk.trailingStop) {
      const trailDist  = pos.peak * cfg.risk.trailingStopPct / 100;
      const trailPrice = isLong ? pos.peak - trailDist : pos.peak + trailDist;
      const triggered  = isLong ? currentPrice <= trailPrice : currentPrice >= trailPrice;
      if (triggered) return { action:"close", reason:"trailing_stop", pos };
    }

    // TP check
    const unrealPnl = isLong
      ? (currentPrice - pos.entryPrice) / pos.entryPrice * 100
      : (pos.entryPrice - currentPrice) / pos.entryPrice * 100;

    // TP1, TP2, TP3
    if (pos.tpHit < 3) {
      const tp = [pos.tp1, pos.tp2, pos.tp3][pos.tpHit];
      const tpReached = isLong ? currentPrice >= tp : currentPrice <= tp;
      if (tpReached) {
        pos.tpHit++;
        return { action:"partial_close", tp: pos.tpHit, closeQty: pos.qty * 0.33, pos };
      }
    }

    // SL check
    const slHit = isLong ? currentPrice <= pos.sl : currentPrice >= pos.sl;
    if (slHit) return { action:"close", reason:"stop_loss", pos };

    return { action:"hold", unrealPnl, pos };
  }

  // Fecha posição e registra P&L
  closePosition(symbol, closePnl = 0) {
    const pos = this.openPositions.get(symbol);
    if (!pos) return null;
    this.dailyPnl += closePnl;
    this.openPositions.delete(symbol);
    return { ...pos, closePnl, closedAt: Date.now() };
  }

  status() {
    this.resetDaily();
    return {
      dailyPnl:       +this.dailyPnl.toFixed(4),
      openCount:      this.openPositions.size,
      executedToday:  this.executedToday,
      blocked:        !!this.blockedReason,
      blockedReason:  this.blockedReason,
      positions:      [...this.openPositions.entries()].map(([sym,p])=>({ sym,...p })),
    };
  }
}

module.exports = new RiskManager(); // singleton
