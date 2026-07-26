/**
 * config.js — Configurações centrais do bot
 */
"use strict";
require("dotenv").config();

module.exports = {
  bybit: {
    apiKey:    process.env.BYBIT_API_KEY    || "",
    apiSecret: process.env.BYBIT_API_SECRET || "",
    testnet:   process.env.BYBIT_TESTNET === "true",
    baseURL:   process.env.BYBIT_TESTNET === "true"
      ? "https://api-testnet.bybit.com"
      : "https://api.bybit.com",
    wssURL: "wss://stream.bybit.com/v5/public/linear",
  },

  binance: {
    apiKey:    process.env.BINANCE_API_KEY    || "",
    apiSecret: process.env.BINANCE_API_SECRET || "",
    baseURL:   "https://api.binance.com",
    fBaseURL:  "https://fapi.binance.com",
  },

  novadex: {
    privateKey:    process.env.NOVADEX_PRIVATE_KEY || "",
    walletAddress: process.env.NOVADEX_WALLET      || "",
    rpcURL:        process.env.NOVADEX_RPC || "https://rpc.hyperliquid.xyz/evm",
    apiURL:        "https://api.hyperliquid.xyz",
    chainId:       999,
  },

  arb: {
    minProfitPct:  parseFloat(process.env.ARB_MIN_PROFIT || "0.25"),
    maxPositionUSD:parseFloat(process.env.ARB_MAX_POS    || "30"),
    takerFee:      0.001,
    gasPadding:    0.05,
    autoExecute:   process.env.ARB_AUTO_EXECUTE === "true",
  },

  signals: {
    pairs: [
      "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT",
      "DOGEUSDT","ADAUSDT","AVAXUSDT","TRXUSDT","LINKUSDT",
      "DOTUSDT","LTCUSDT","BCHUSDT","ATOMUSDT","NEARUSDT",
      "APTUSDT","ARBUSDT","OPUSDT","INJUSDT","SUIUSDT",
      "MATICUSDT","XLMUSDT","VETUSDT","HBARUSDT","ALGOUSDT",
      "FILUSDT","ICPUSDT","ETCUSDT","STXUSDT","TONUSDT",
      "AAVEUSDT","UNIUSDT","MKRUSDT","CRVUSDT","SNXUSDT",
      "GMXUSDT","DYDXUSDT","LDOUSDT","RUNEUSDT","JUPUSDT",
      "IMXUSDT","STRKUSDT","ZROUSDT","MANTAUSDT","ALTUSDT",
      "MNTUSDT","LRCUSDT","ENAUSDT","EIGENUSDT","ETHFIUSDT",
      "FETUSDT","TAOUSDT","RENDERUSDT","WLDUSDT","GRTUSDT",
      "AGIXUSDT","OCEANUSDT","MOVEUSDT","WOOUSDT","MASKUSDT",
      "SANDUSDT","MANAUSDT","AXSUSDT","GALAUSDT","ENJUSDT",
      "MAGICUSDT","APEUSDT","ORDIUSDT","CHZUSDT","FTMUSDT",
      "PEPEUSDT","FLOKIUSDT","BONKUSDT","WIFUSDT","SHIBUSDT",
      "MEMEUSDT","POPCATUSDT","NEIROUSDT","BOMEUSDT","TURBOUSDT",
      "STORJUSDT","CKBUSDT","ANKRUSDT","BATUSDT","ZECUSDT",
      "ROSEUSDT","KAVAUSDT","COMPUSDT","BALUSDT","1INCHUSDT",
      "DYMUSDT","PYTHUSDT","TIAUSDT","SEIUSDT","EGLDUSDT",
      "ACHUSDT","HIFIUSDT","NKNUSDT","STGUSDT","RLCUSDT",
    ],
    timeframes:    ["60", "240"],
    minScore:      6,
    minConfidence: 60,
    maxRisk:       2,
    autoExecute:   process.env.SIG_AUTO_EXECUTE === "true",
    defaultLeverage: parseInt(process.env.DEFAULT_LEVERAGE || "3"),
    defaultExchange: process.env.DEFAULT_EXCHANGE || "bybit",

    filters: {
      requireWyckoff:    false,
      requireOB:         false,
      requireMTFAlign:   false,
      requireVolume:     true,
      requireSpring:     false,
      minRR:             1.5,
      maxSpreadPct:      0.15,
      blacklistPhases:   ["DISTRIBUIÇÃO", "MARKDOWN"],
      requireBOSConfirm: false,
    },
  },

  risk: {
    maxDailyLoss:      parseFloat(process.env.MAX_DAILY_LOSS || "3"),
    maxOpenPositions:  parseInt(process.env.MAX_POSITIONS    || "2"),
    maxPositionSizeUSD:parseFloat(process.env.MAX_POS_USD    || "20"),
    stopLossMultiplier:2.0,
    takeProfitRatios:  [1.5, 3.0, 5.0],
    trailingStop:      true,
    trailingStopPct:   1.0,
  },

  port:     parseInt(process.env.PORT || "3002"),
  adminKey: process.env.ADMIN_KEY || "acs@Admin2026!",
  logLevel: process.env.LOG_LEVEL || "info",
};
