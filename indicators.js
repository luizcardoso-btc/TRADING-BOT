/**
 * indicators.js — Indicadores técnicos calculados localmente
 * RSI, EMA, MACD, Bollinger, ATR, StochRSI, Volume
 */
"use strict";

const ema = (arr, p) => {
  const k = 2/(p+1); let e = arr[0];
  return arr.map(v => (e = v*k + e*(1-k)));
};

const sma = (arr, p) =>
  arr.map((_, i) => i < p-1 ? null : arr.slice(i-p+1,i+1).reduce((a,b)=>a+b,0)/p);

const rsi = (closes, p = 14) => {
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i-1];
    d > 0 ? g+=d : l-=d;
  }
  let ag = g/p, al = l/p;
  for (let i = p+1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag*(p-1) + (d>0?d:0)) / p;
    al = (al*(p-1) + (d<0?-d:0)) / p;
  }
  return al === 0 ? 100 : 100 - 100/(1 + ag/al);
};

const macd = closes => {
  const m  = ema(closes,12).map((v,i) => v - ema(closes,26)[i]);
  const s  = ema(m, 9);
  const h  = m.map((v,i) => v - s[i]);
  return { macd:m.at(-1), signal:s.at(-1), hist:h.at(-1), histPrev:h.at(-2), bullish: h.at(-1) > 0 };
};

const atr = (candles, p = 14) => {
  const tr = candles.slice(1).map((c,i) => Math.max(
    c.h - c.l,
    Math.abs(c.h - candles[i].c),
    Math.abs(c.l - candles[i].c)
  ));
  return tr.slice(-p).reduce((a,b)=>a+b,0) / p;
};

const bollinger = (closes, p = 20, mul = 2) => {
  const m   = sma(closes, p).at(-1);
  const std = Math.sqrt(closes.slice(-p).reduce((a,v)=>(a+(v-m)**2),0)/p);
  return { upper: m+mul*std, lower: m-mul*std, mid: m, std, bw: (std*2*mul)/m };
};

const volumeAnalysis = (candles, p = 20) => {
  const v   = candles.map(c => c.v);
  const avg = v.slice(-p).reduce((a,b)=>a+b,0) / p;
  const cur = v.at(-1);
  const trend = v.slice(-5).every((vi,i,a) => i===0 || vi>=a[i-1]);
  return { cur, avg, ratio: cur/avg, spike: cur > avg*2, upTrend: trend };
};

// Wyckoff
const wyckoff = (candles, closes) => {
  const e200 = ema(closes, 200).at(-1);
  const e50  = ema(closes, 50).at(-1);
  const cur  = closes.at(-1);
  const rHigh = Math.max(...candles.slice(-60).map(c=>c.h));
  const rLow  = Math.min(...candles.slice(-60).map(c=>c.l));
  const pos   = (cur - rLow) / (rHigh - rLow || 1);
  const vol   = candles.map(c=>c.v);
  const vAvg  = vol.slice(-20).reduce((a,b)=>a+b,0) / 20;
  const vDec  = vol.slice(-5).reduce((a,b)=>a+b,0)/5 < vAvg * 0.8;

  const spring   = candles.slice(-10).some((c,i,a) => i>0 && c.l<a[i-1].l && c.c>a[i-1].l && pos<0.3 && c.v>vAvg*1.2);
  const sos      = candles.slice(-5).some(c => (c.c-c.o)/c.o > 0.015 && c.v > vAvg*1.5);
  const upthrust = candles.slice(-10).some((c,i,a) => i>0 && c.h>a[i-1].h && c.c<a[i-1].h && pos>0.7);
  const sow      = candles.slice(-5).some(c => (c.o-c.c)/c.o > 0.015 && c.v > vAvg*1.5);

  let phase = "INDEFINIDA";
  if      (pos<0.3 && rsi(closes)<45 && vDec) phase = "ACUMULAÇÃO";
  else if (cur>e200 && cur>e50 && pos>0.4)    phase = "MARKUP";
  else if (pos>0.7 && vDec)                   phase = "DISTRIBUIÇÃO";
  else if (cur<e200 && cur<e50 && pos<0.5)    phase = "MARKDOWN";

  return { phase, spring, sos, upthrust, sow, pos, e200, e50 };
};

// SMC
const smc = (candles, closes) => {
  const a = atr(candles);
  let obBull = null, obBear = null;
  for (let i = candles.length-3; i >= Math.max(0, candles.length-40); i--) {
    const nx = candles[i+1];
    if (!nx) continue;
    if (!obBull && candles[i].c < candles[i].o && nx.c > nx.o && (nx.c-nx.o) > a*1.2)
      obBull = { h: Math.max(candles[i].o, candles[i].c), l: Math.min(candles[i].o, candles[i].c) };
    if (!obBear && candles[i].c > candles[i].o && nx.c < nx.o && (nx.o-nx.c) > a*1.2)
      obBear = { h: Math.max(candles[i].o, candles[i].c), l: Math.min(candles[i].o, candles[i].c) };
  }
  const rH = Math.max(...candles.slice(-20).map(c=>c.h));
  const rL  = Math.min(...candles.slice(-20).map(c=>c.l));
  const cur = closes.at(-1);
  return {
    obBull, obBear,
    bosBull: cur > rH,
    bosBear: cur < rL,
    fvgBull: candles.slice(-25).some((_,i,a) => i>1 && a[i].l > a[i-2].h),
    fvgBear: candles.slice(-25).some((_,i,a) => i>1 && a[i].h < a[i-2].l),
  };
};

// Score quantitativo
const quantScore = (closes, candles) => {
  const r   = rsi(closes);
  const m   = macd(closes);
  const bb  = bollinger(closes);
  const vol = volumeAnalysis(candles);
  const wy  = wyckoff(candles, closes);
  const s   = smc(candles, closes);
  const cur = closes.at(-1);
  const e200= ema(closes,200).at(-1);

  let score = 0, factors = [];

  // Wyckoff
  if (wy.phase==="ACUMULAÇÃO") { score+=3; factors.push("Wyckoff Acumulação"); }
  else if (wy.phase==="MARKUP"){ score+=2; factors.push("Wyckoff Markup"); }
  else if (wy.phase==="DISTRIBUIÇÃO") { score-=2; }
  else if (wy.phase==="MARKDOWN")     { score-=3; }
  if (wy.spring)   { score+=3; factors.push("Spring"); }
  if (wy.sos)      { score+=2; factors.push("SOS"); }
  if (wy.upthrust) { score-=3; }
  if (wy.sow)      { score-=2; }

  // SMC
  if (s.obBull && !s.obBear) { score+=2; factors.push("OB Bullish"); }
  if (s.obBear && !s.obBull) { score-=2; }
  if (s.bosBull) { score+=2; factors.push("BOS Bull"); }
  if (s.bosBear) { score-=2; }
  if (s.fvgBull) { score+=1; factors.push("FVG Bull"); }
  if (s.fvgBear) { score-=1; }

  // RSI
  if (r < 30) { score+=3; factors.push("RSI Oversold "+r.toFixed(0)); }
  else if (r < 40) { score+=1; }
  else if (r > 70) { score-=3; }
  else if (r > 60) { score-=1; }

  // MACD
  if (m.hist > 0 && m.hist > m.histPrev) { score+=2; factors.push("MACD Bull↑"); }
  else if (m.hist > 0) { score+=1; }
  else if (m.hist < 0 && m.hist < m.histPrev) { score-=2; }
  else { score-=1; }

  // Volume
  if (vol.spike)       { score+=3; factors.push("Volume Spike"); }
  else if (vol.ratio>1.5) { score+=2; factors.push("Volume Alto"); }
  else if (vol.ratio>1.2) { score+=1; }
  else if (vol.ratio<0.6) { score-=1; }

  // Bollinger
  if (cur < bb.lower) { score+=2; factors.push("Abaixo BB"); }
  else if (cur > bb.upper) { score-=2; }

  // EMA200
  if (cur > e200) { score+=2; factors.push("Acima EMA200"); }
  else { score-=2; }

  const pct  = Math.max(-26, Math.min(26, score));
  const prob = Math.round(50 + (pct/26)*45);
  const dir  = score >= 4 ? "LONG" : score <= -4 ? "SHORT" : "NEUTRO";

  return { score, prob, dir, factors, rsi:r, macd:m, bb, vol, wy, smc:s, e200, cur };
};

// Fibonacci
const fibonacci = (candles, n = 100) => {
  const sl = candles.slice(-n);
  const H  = Math.max(...sl.map(c=>c.h));
  const L  = Math.min(...sl.map(c=>c.l));
  const d  = H - L;
  return { H, L, f236:H-d*.236, f382:H-d*.382, f500:H-d*.5, f618:H-d*.618, f786:H-d*.786, ext161:L-d*.618 };
};

// Calcula níveis operacionais (entrada, SL, TPs)
const levels = (cur, dir, atrVal, cfg_risk) => {
  const isLong  = dir === "LONG";
  const slMult  = cfg_risk.stopLossMultiplier;
  const tpR     = cfg_risk.takeProfitRatios;
  const sl      = isLong ? cur - atrVal*slMult : cur + atrVal*slMult;
  return {
    entry: cur,
    sl,
    tp1: isLong ? cur + atrVal*tpR[0] : cur - atrVal*tpR[0],
    tp2: isLong ? cur + atrVal*tpR[1] : cur - atrVal*tpR[1],
    tp3: isLong ? cur + atrVal*tpR[2] : cur - atrVal*tpR[2],
    rr:  Math.abs((cur + atrVal*tpR[1]) - cur) / Math.abs(cur - sl),
    riskPct: Math.abs(cur - sl) / cur * 100,
  };
};

module.exports = { ema, sma, rsi, macd, atr, bollinger, volumeAnalysis, wyckoff, smc, quantScore, fibonacci, levels };
