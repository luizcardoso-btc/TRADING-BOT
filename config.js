/**
 * config.js — Configurações centrais do bot
 * Todas as chaves vêm de variáveis de ambiente (.env)
 */
"use strict";
require("dotenv").config();

module.exports = {
  // ── CEX: Bybit ────────────────────────────────────────
  bybit: {
    apiKey:    process.env.BYBIT_API_KEY    || "",
    apiSecret: process.env.BYBIT_API_SECRET || "",
    testnet:   process.env.BYBIT_TESTNET === "true",
    baseURL:   process.env.BYBIT_TESTNET === "true"
      ? "https://api-testnet.bybit.com"
      : "https://api.bybit.com",
    wssURL:    "wss://stream.bybit.com/v5/public/linear",
  },

  // ── CEX: Binance ──────────────────────────────────────
  binance: {
    apiKey:    process.env.BINANCE_API_KEY    || "",
    apiSecret: process.env.BINANCE_API_SECRET || "",
    baseURL:   "https://api.binance.com",
    fBaseURL:  "https://fapi.binance.com",
  },

  // ── DEX: Novadex (Hyperliquid L1 / EVM) ──────────────
  // Novadex é uma DEX perpétua na rede Hyperliquid
  novadex: {
    privateKey:   process.env.NOVADEX_PRIVATE_KEY || "",
    walletAddress:process.env.NOVADEX_WALLET      || "",
    rpcURL:       process.env.NOVADEX_RPC          || "https://rpc.hyperliquid.xyz/evm",
    apiURL:       "https://api.hyperliquid.xyz",   // API REST da Hyperliquid
    chainId:      999,                              // Hyperliquid EVM
  },

  // ── ARBITRAGEM ────────────────────────────────────────
  arb: {
    minProfitPct:  parseFloat(process.env.ARB_MIN_PROFIT || "0.15"), // % mínimo após taxas
    maxPositionUSD:parseFloat(process.env.ARB_MAX_POS    || "500"),  // tamanho máximo por operação
    takerFee:      0.001,   // 0.1% por lado
    gasPadding:    0.05,    // 5% de margem para gas/slippage DEX
    autoExecute:   process.env.ARB_AUTO_EXECUTE === "true",
  },

  // ── SINAIS AUTOMÁTICOS ────────────────────────────────
  signals: {
    pairs: [
      "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT",
      "DOGEUSDT","AVAXUSDT","LINKUSDT","NEARUSDT","INJUSDT",
      "APTUSDT","ARBUSDT","OPUSDT","SUIUSDT","TIAUSDT",
      "WLDUSDT","FETUSDT","TAOUSDT","RUNEUSDT","JUPUSDT",
    ],
    timeframes:    ["15","60","240"],       // 15min, 1h, 4h
    minScore:      8,                       // score mínimo /26 para emitir sinal
    minConfidence: 60,                      // % mínimo de confiança
    maxRisk:       2,                       // % máx da banca por operação
    autoExecute:   process.env.SIG_AUTO_EXECUTE === "true",
    defaultLeverage: parseInt(process.env.DEFAULT_LEVERAGE || "5"),
    defaultExchange: process.env.DEFAULT_EXCHANGE || "bybit",
  },

  // ── RISCO GLOBAL ──────────────────────────────────────
  risk: {
    maxDailyLoss:      parseFloat(process.env.MAX_DAILY_LOSS || "5"),   // % da banca
    maxOpenPositions:  parseInt(process.env.MAX_POSITIONS    || "5"),
    maxPositionSizeUSD:parseFloat(process.env.MAX_POS_USD    || "500"),
    stopLossMultiplier:1.8,   // ATR × este valor = stop loss
    takeProfitRatios:  [1.5, 3.0, 5.0], // TP1, TP2, TP3 em múltiplos de ATR
    trailingStop:      true,
    trailingStopPct:   0.8,   // % de recuo do pico para ativar trailing
  },

  // ── SERVIDOR ──────────────────────────────────────────
  port:      parseInt(process.env.PORT || "3002"),
  adminKey:  process.env.ADMIN_KEY || "acs@Admin2026!",
  logLevel:  process.env.LOG_LEVEL || "info",
};
