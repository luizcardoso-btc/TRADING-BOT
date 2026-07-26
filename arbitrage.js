/**
 * arbitrage.js — Motor de arbitragem CEX + DEX
 * Detecta: cross-exchange, triangular, funding rate, basis spot-perp
 */
"use strict";

const { Bybit, Binance, Novadex } = require("./exchanges");
const cfg = require("./config");

const EXCHANGES = [
  { id:"bybit",   ex: Bybit   },
  { id:"binance", ex: Binance },
  { id:"novadex", ex: Novadex },
];

const NET_FEE = cfg.arb.takerFee * 2 + cfg.arb.gasPadding; // custo total estimado

// ── 1. ARBITRAGEM CROSS-EXCHANGE ──────────────────────────────────────
async function crossExchange(symbol) {
  const tickers = await Promise.allSettled(
    EXCHANGES.map(({ id, ex }) => ex.ticker(symbol).then(t => ({ ...t, id })).catch(() => null))
  );
  const valid = tickers.map(r => r.value).filter(Boolean);
  if (valid.length < 2) return null;

  let best = null;
  for (const buy  of valid) {
    for (const sell of valid) {
      if (buy.id === sell.id) continue;
      const gross = (sell.bid - buy.ask) / buy.ask * 100;
      const net   = gross - NET_FEE * 100;
      if (net > cfg.arb.minProfitPct && (!best || net > best.profitNet)) {
        best = {
          type:        "cross",
          symbol,
          buyExchange:  buy.id,
          sellExchange: sell.id,
          buyPrice:    buy.ask,
          sellPrice:   sell.bid,
          profitGross: +gross.toFixed(4),
          profitNet:   +net.toFixed(4),
          estimatedUSD: (net/100) * cfg.arb.maxPositionUSD,
          tickers:     valid,
          ts: Date.now(),
        };
      }
    }
  }
  return best;
}

// ── 2. ARBITRAGEM TRIANGULAR (dentro da Bybit) ────────────────────────
async function triangular() {
  const triangles = [
    { pairs:["BTCUSDT","ETHUSDT","ETHBTC"],  startCoin:"USDT", via:"BTC",  end:"ETH" },
    { pairs:["BTCUSDT","SOLUSDT","SOLBTC"],  startCoin:"USDT", via:"BTC",  end:"SOL" },
    { pairs:["ETHUSDT","BNBUSDT","BNBETH"],  startCoin:"USDT", via:"ETH",  end:"BNB" },
  ];

  const results = [];
  for (const tri of triangles) {
    try {
      const tickers = await Promise.all(tri.pairs.map(p => Bybit.ticker(p, "spot").catch(()=>null)));
      if (tickers.some(t=>!t)) continue;
      const [t1, t2, t3] = tickers;

      // Ciclo: USDT → via → end → USDT
      let bal = 1000;
      bal = bal / t1.ask;         // USDT → BTC (ou ETH)
      bal = bal * t3.bid;         // BTC → ETH (via cross pair)
      bal = bal * t2.bid;         // ETH → USDT
      const gross = (bal - 1000) / 10;
      const net   = gross - NET_FEE * 100 * 3;

      if (net > cfg.arb.minProfitPct) {
        results.push({
          type:        "triangular",
          exchange:    "bybit",
          path:        tri.pairs.join(" → "),
          profitGross: +gross.toFixed(4),
          profitNet:   +net.toFixed(4),
          startUSDT:   1000,
          endUSDT:     +bal.toFixed(4),
          ts: Date.now(),
        });
      }
    } catch {}
  }
  return results;
}

// ── 3. FUNDING RATE ARBITRAGEM ────────────────────────────────────────
async function fundingArb(symbol = "BTCUSDT") {
  const [bybitF, binanceF, novadexF] = await Promise.all([
    Bybit.fundingRate(symbol).catch(()=>null),
    Binance.fundingRate(symbol).catch(()=>null),
    Novadex.ticker(symbol).then(t=>t.fundingRate).catch(()=>null),
  ]);

  const named = [
    { ex:"bybit",   rate: bybitF   },
    { ex:"binance", rate: binanceF },
    { ex:"novadex", rate: novadexF },
  ].filter(x => x.rate !== null && x.rate !== undefined);

  const opps = [];
  for (let i = 0; i < named.length; i++) {
    for (let j = 0; j < named.length; j++) {
      if (i === j) continue;
      const diff = named[i].rate - named[j].rate;
      if (Math.abs(diff) * 100 > 0.02) {
        opps.push({
          type:      "funding",
          symbol,
          longAt:    diff < 0 ? named[i].ex : named[j].ex,
          shortAt:   diff < 0 ? named[j].ex : named[i].ex,
          longRate:  +(diff < 0 ? named[i].rate : named[j].rate) * 100,
          shortRate: +(diff < 0 ? named[j].rate : named[i].rate) * 100,
          diffPct:   +(Math.abs(diff) * 100).toFixed(4),
          annualized:+(Math.abs(diff) * 100 * 3 * 365).toFixed(2),
          neutral:   true, // delta neutro — sem exposição direcional
          ts: Date.now(),
        });
      }
    }
  }
  return opps;
}

// ── 4. BASIS SPOT-PERP ────────────────────────────────────────────────
async function basisArb(symbol = "BTCUSDT") {
  const [spot, perp, dex] = await Promise.all([
    Bybit.ticker(symbol, "spot").catch(()=>null),
    Bybit.ticker(symbol, "linear").catch(()=>null),
    Novadex.ticker(symbol).catch(()=>null),
  ]);
  const results = [];

  // Bybit spot vs perp
  if (spot && perp) {
    const basis    = (perp.last - spot.last) / spot.last * 100;
    const net      = Math.abs(basis) - NET_FEE * 100;
    if (net > cfg.arb.minProfitPct) {
      results.push({
        type:      "basis",
        symbol,
        spotEx:    "bybit_spot",
        perpEx:    "bybit_linear",
        spotPrice: spot.last,
        perpPrice: perp.last,
        basis:     +basis.toFixed(4),
        profitNet: +net.toFixed(4),
        annualized:+(net * 365/30).toFixed(2),
        direction: basis > 0 ? "Short Perp / Long Spot" : "Long Perp / Short Spot",
        ts: Date.now(),
      });
    }
  }

  // Bybit perp vs Novadex DEX
  if (perp && dex) {
    const basis    = (dex.last - perp.last) / perp.last * 100;
    const net      = Math.abs(basis) - NET_FEE * 100;
    if (net > cfg.arb.minProfitPct) {
      results.push({
        type:      "basis",
        symbol,
        spotEx:    "bybit_linear",
        perpEx:    "novadex",
        spotPrice: perp.last,
        perpPrice: dex.last,
        basis:     +basis.toFixed(4),
        profitNet: +net.toFixed(4),
        direction: basis > 0 ? "Short Novadex / Long Bybit" : "Long Novadex / Short Bybit",
        ts: Date.now(),
      });
    }
  }

  return results;
}

// ── SCAN COMPLETO ─────────────────────────────────────────────────────
const TOP_PAIRS = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","LINKUSDT","AVAXUSDT","DOTUSDT"];

async function fullArbScan(onOpp) {
  const start = Date.now();
  let found   = 0;

  // Cross-exchange
  const crossResults = await Promise.allSettled(TOP_PAIRS.map(p => crossExchange(p)));
  crossResults.forEach(r => { if (r.value) { found++; onOpp(r.value); } });

  // Triangular
  const triResults = await triangular();
  triResults.forEach(t => { found++; onOpp(t); });

  // Funding
  const fundResults = await Promise.allSettled(["BTCUSDT","ETHUSDT","SOLUSDT"].map(s => fundingArb(s)));
  fundResults.forEach(r => { (r.value||[]).forEach(o => { found++; onOpp(o); }); });

  // Basis
  const basisResults = await Promise.allSettled(["BTCUSDT","ETHUSDT"].map(s => basisArb(s)));
  basisResults.forEach(r => { (r.value||[]).forEach(o => { found++; onOpp(o); }); });

  return { found, total: TOP_PAIRS.length, ms: Date.now() - start };
}

module.exports = { crossExchange, triangular, fundingArb, basisArb, fullArbScan, TOP_PAIRS };
