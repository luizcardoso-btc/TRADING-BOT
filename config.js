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
    // Top 100 pares por volume — priorizados por liquidez para execução precisa
    pairs: [
      // Tier 1 — Liquidez máxima (sempre operar)
      "BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT",
      "DOGEUSDT","ADAUSDT","AVAXUSDT","TRXUSDT","LINKUSDT",
      // Tier 2 — Alta liquidez
      "DOTUSDT","LTCUSDT","BCHUSDT","ATOMUSDT","NEARUSDT",
      "APTUSDT","ARBUSDT","OPUSDT","INJUSDT","SUIUSDT",
      "MATICUSDT","XLMUSDT","VETUSDT","HBARUSDT","ALGOUSDT",
      "FILUSDT","ICPUSDT","ETCUSDT","STXUSDT","TONUSDT",
      // DeFi
      "AAVEUSDT","UNIUSDT","MKRUSDT","CRVUSDT","SNXUSDT",
      "GMXUSDT","DYDXUSDT","LDOUSDT","RUNEUSDT","JUPUSDT",
      // Layer 2
      "IMXUSDT","STRKUSDT","ZROUSDT","MANTAUSDT","ALTUSDT",
      "MNTUSDT","LRCUSDT","ENAUSDT","EIGENUSDT","ETHFIUSDT",
      // AI
      "FETUSDT","TAOUSDT","RENDERUSDT","WLDUSDT","GRTUSDT",
      "AGIXUSDT","OCEANUSDT","MOVEUSDT","WOOUSDT","MASKUSDT",
      // Gaming
      "SANDUSDT","MANAUSDT","AXSUSDT","GALAUSDT","ENJUSDT",
      "MAGICUSDT","APEUSDT","ORDIUSDT","CHZUSDT","FTMUSDT",
      // Memecoins líquidas
      "PEPEUSDT","FLOKIUSDT","BONKUSDT","WIFUSDT","SHIBUSDT",
      "MEMEUSDT","POPCATUSDT","NEIROUSDT","BOMEUSDT","TURBOUSDT",
      // Infra
      "STORJUSDT","CKBUSDT","ANKRUSDT","BATUSDT","ZECUSDT",
      "ROSEUSDT","KAVAUSDT","COMPUSDT","BALUSDT","1INCHUSDT",
      // Cross-chain
      "DYMUSDT","PYTHUSDT","TIAUSDT","SEIUSDT","EGLDUSDT",
      "TAOUSDT","RUNEUSDT","JUPUSDT","LDOUSDT","WLDUSDT",
    ],
    timeframes:    ["60","240"],            // 1H e 4H — mais confiáveis, menos ruído
    minScore:      14,                      // Score alto = só os melhores setups
    minConfidence: 72,                      // 72%+ de confiança
    maxRisk:       1.5,                     // 1.5% da banca por operação
    autoExecute:   process.env.SIG_AUTO_EXECUTE === "true",
    defaultLeverage: parseInt(process.env.DEFAULT_LEVERAGE || "5"),
    defaultExchange: process.env.DEFAULT_EXCHANGE || "bybit",

    // ── FILTROS PREMIUM — só entra se tudo estiver alinhado ──────────
    filters: {
      requireWyckoff:    true,   // Exige fase Wyckoff favorável (Acumulação ou Markup)
      requireOB:         true,   // Exige Order Block ativo na direção do trade
      requireMTFAlign:   true,   // Exige alinhamento em pelo menos 2 timeframes
      requireVolume:     true,   // Exige volume acima da média (ratio > 1.2x)
      requireSpring:     false,  // Spring é bônus — não obrigatório
      minRR:             2.0,    // R/R mínimo de 2:1
      maxSpreadPct:      0.15,   // Spread máximo 0.15% para garantir execução
      blacklistPhases:   ["DISTRIBUIÇÃO","MARKDOWN"], // Nunca LONG em distribuição
      requireBOSConfirm: false,  // BOS é bônus
    },
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
