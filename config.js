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

  // ── ARBITRAGEM — Conservador para $100 real ──────────
  arb: {
    minProfitPct:  parseFloat(process.env.ARB_MIN_PROFIT || "0.25"), // 0.25% mínimo após taxas
    maxPositionUSD:parseFloat(process.env.ARB_MAX_POS    || "30"),   // $30 por operação de arb
    takerFee:      0.001,   // 0.1% por lado (Bybit VIP0)
    gasPadding:    0.05,    // 5% de margem para gas/slippage
    autoExecute:   process.env.ARB_AUTO_EXECUTE === "true",
  },

  // ── SINAIS AUTOMÁTICOS ────────────────────────────────
  signals: {
    // Pares mais líquidos — menor spread, melhor execução
    pairs: [
      "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT",
      "DOGEUSDT","AVAXUSDT","LINKUSDT","NEARUSDT","INJUSDT",
      "APTUSDT","ARBUSDT","OPUSDT","SUIUSDT","TIAUSDT",
      "WLDUSDT","FETUSDT","TAOUSDT","RUNEUSDT","JUPUSDT",
    ],
    timeframes:    ["60","240"],            // 1H e 4H — mais confiáveis para futuros
    minScore:      10,                      // score mínimo elevado para $100 real
    minConfidence: 65,                      // 65% mínimo de confiança
    maxRisk:       2,                       // 2% da banca por operação = $2 máx de perda
    autoExecute:   process.env.SIG_AUTO_EXECUTE === "true",
    defaultLeverage: parseInt(process.env.DEFAULT_LEVERAGE || "3"), // 3x conservador
    defaultExchange: process.env.DEFAULT_EXCHANGE || "bybit",
  },

  // ── RISCO GLOBAL — Configurado para $100 USDT real ──────
  risk: {
    maxDailyLoss:      parseFloat(process.env.MAX_DAILY_LOSS || "3"),   // 3% = max $3 de perda/dia
    maxOpenPositions:  parseInt(process.env.MAX_POSITIONS    || "2"),   // máx 2 posições simultâneas
    maxPositionSizeUSD:parseFloat(process.env.MAX_POS_USD    || "20"),  // $20 por operação (20% da banca)
    stopLossMultiplier:2.0,   // ATR × 2.0 = stop mais folgado para não stopar no ruído
    takeProfitRatios:  [1.5, 3.0, 5.0], // TP1 ~1.5%, TP2 ~3%, TP3 ~5%
    trailingStop:      true,
    trailingStopPct:   1.0,   // 1% de recuo do pico para ativar trailing
  },

  // ── SERVIDOR ──────────────────────────────────────────
  port:      parseInt(process.env.PORT || "3002"),
  adminKey:  process.env.ADMIN_KEY || "acs@Admin2026!",
  logLevel:  process.env.LOG_LEVEL || "info",
};
