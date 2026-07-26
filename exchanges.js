/**
 * exchanges.js — Conectores CEX (Bybit + Binance) e DEX (Novadex/Hyperliquid)
 * Suporta: ticker, orderbook, candles, ordens autenticadas, posições abertas
 */
"use strict";

const crypto  = require("crypto");
const https   = require("https");
const http    = require("http");
const cfg     = require("./config");

// ── Proxy para contornar bloqueios de IP (Bybit/CloudFront) ──────────
// Configure HTTPS_PROXY nas variáveis do Railway
// Ex: HTTPS_PROXY=http://user:pass@proxy.example.com:8080
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || null;
let proxyAgent  = null;
if (PROXY_URL) {
  try {
    const { HttpsProxyAgent } = require("https-proxy-agent");
    proxyAgent = new HttpsProxyAgent(PROXY_URL);
    console.log("[PROXY] Usando proxy:", PROXY_URL.replace(/:[^:@]+@/, ":***@"));
  } catch(e) {
    console.warn("[PROXY] Erro ao inicializar proxy:", e.message);
  }
}

// ── HTTP helper com suporte a proxy ───────────────────────────────────
function request(url, opts = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u    = new URL(url);
    const data = body ? JSON.stringify(body) : null;

    const options = {
      hostname: u.hostname,
      port:     u.port || (u.protocol === "https:" ? 443 : 80),
      path:     u.pathname + u.search,
      method:   data ? "POST" : "GET",
      headers: {
        "User-Agent":   "Mozilla/5.0 (compatible; ACS-Bot/1.0)",
        "Content-Type": "application/json",
        "Accept":       "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
        ...opts.headers,
      },
      timeout: opts.timeout || 10000,
      // Usa proxy se configurado
      ...(proxyAgent ? { agent: proxyAgent } : {}),
    };

    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(options, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0,150)}`));
        try { resolve(JSON.parse(d)); } catch(e) { reject(new Error(`JSON: ${d.slice(0,80)}`)); }
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
    req.on("error",   reject);
    if (data) req.write(data);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════════
// BYBIT
// ══════════════════════════════════════════════════════════════════════
const Bybit = {
  name: "Bybit",
  // Endpoints alternativos — rotaciona se CloudFront bloquear
  ENDPOINTS: [
    cfg.bybit.baseURL,
    "https://api.bytick.com",      // endpoint alternativo oficial Bybit
    "https://api.bybit.com",       // fallback direto
  ],
  BASE: cfg.bybit.baseURL,

  _sign(params, ts) {
    const str = ts + cfg.bybit.apiKey + "5000" +
      (typeof params === "string" ? params : new URLSearchParams(params).toString());
    return crypto.createHmac("sha256", cfg.bybit.apiSecret).update(str).digest("hex");
  },

  _headers(params) {
    const ts = Date.now().toString();
    return {
      "X-BAPI-API-KEY":      cfg.bybit.apiKey,
      "X-BAPI-TIMESTAMP":    ts,
      "X-BAPI-RECV-WINDOW":  "5000",
      "X-BAPI-SIGN":         this._sign(params, ts),
      "X-BAPI-BROKER-ID":    "",
    };
  },

  // Testa autenticação e detecta o erro exato
  async testAuth() {
    try {
      const qs = "accountType=UNIFIED";
      const d  = await this._get(`/v5/account/wallet-balance?${qs}`);
      return { ok: true, data: d };
    } catch(e) {
      // Tenta com conta CONTRACT
      try {
        const qs = "accountType=CONTRACT";
        const ts = Date.now().toString();
        const sig = this._sign(qs, ts);
        const d = await request(`${this.BASE}/v5/account/wallet-balance?${qs}`, {
          headers: {
            "X-BAPI-API-KEY": cfg.bybit.apiKey,
            "X-BAPI-TIMESTAMP": ts,
            "X-BAPI-RECV-WINDOW": "5000",
            "X-BAPI-SIGN": sig,
          }
        });
        return { ok: true, type: "CONTRACT", data: d };
      } catch(e2) {
        return { ok: false, error: e.message, error2: e2.message };
      }
    }
  },

  // Tenta endpoints em sequência até um funcionar
  async _get(path) {
    let lastErr;
    for (const base of this.ENDPOINTS) {
      try {
        const d = await request(`${base}${path}`);
        this.BASE = base; // atualiza para o que funcionou
        return d;
      } catch(e) {
        lastErr = e;
        if (!e.message.includes("403") && !e.message.includes("CloudFront")) throw e;
        // Se for 403/CloudFront, tenta o próximo endpoint
      }
    }
    throw lastErr;
  },

  // Dados públicos
  async ticker(symbol, cat = "linear") {
    const d = await this._get(`/v5/market/tickers?category=${cat}&symbol=${symbol}`);
    const t = d?.result?.list?.[0];
    if (!t) throw new Error(`Bybit ticker não encontrado: ${symbol}`);
    return {
      exchange:"Bybit", symbol,
      bid: +t.bid1Price, ask: +t.ask1Price, last: +t.lastPrice,
      vol24h: +t.volume24h, fundingRate: +t.fundingRate || 0,
      openInterest: +t.openInterest || 0, ts: Date.now(),
    };
  },

  async candles(symbol, interval = "60", limit = 250, cat = "linear") {
    const d = await this._get(`/v5/market/kline?category=${cat}&symbol=${symbol}&interval=${interval}&limit=${limit}`);
    return (d.result?.list || []).reverse()
      .map(c => ({ t:+c[0], o:+c[1], h:+c[2], l:+c[3], c:+c[4], v:+c[5] }));
  },

  async orderbook(symbol, limit = 10, cat = "linear") {
    const d = await this._get(`/v5/market/orderbook?category=${cat}&symbol=${symbol}&limit=${limit}`);
    const r = d?.result;
    return {
      exchange:"Bybit", symbol,
      bids: (r?.b||[]).map(([p,q])=>({ price:+p, qty:+q })),
      asks: (r?.a||[]).map(([p,q])=>({ price:+p, qty:+q })),
      ts: Date.now(),
    };
  },

  async fundingRate(symbol = "BTCUSDT") {
    const d = await this._get(`/v5/market/funding/history?category=linear&symbol=${symbol}&limit=1`);
    return +(d?.result?.list?.[0]?.fundingRate || 0);
  },

  // Conta (requer chaves)
  async balance() {
    const qs  = "accountType=UNIFIED";
    const ts  = Date.now().toString();
    const sig = crypto.createHmac("sha256", cfg.bybit.apiSecret)
      .update(ts + cfg.bybit.apiKey + "5000" + qs).digest("hex");
    const d   = await request(`${this.BASE}/v5/account/wallet-balance?${qs}`, {
      headers: {
        "X-BAPI-API-KEY":     cfg.bybit.apiKey,
        "X-BAPI-TIMESTAMP":   ts,
        "X-BAPI-RECV-WINDOW": "5000",
        "X-BAPI-SIGN":        sig,
      }
    });
    const acc   = d?.result?.list?.[0];
    const avail = parseFloat(acc?.totalAvailableBalance || 0)
      || parseFloat(acc?.totalWalletBalance || 0)
      || parseFloat(acc?.totalEquity || 0);
    return {
      totalEquity:      +(acc?.totalEquity       || 0),
      availableBalance: +avail.toFixed(4),
      walletBalance:    +(acc?.totalWalletBalance || 0),
      unrealisedPnl:    +(acc?.totalPerpUPL       || acc?.totalUnrealisedPnl || 0),
      coins: (acc?.coin || [])
        .filter(c => parseFloat(c.equity || 0) > 0)
        .map(c => ({ coin: c.coin, equity: +c.equity, available: +(c.availableToWithdraw || c.equity || 0) })),
    };
  },

  async positions(symbol = "") {
    const qs  = new URLSearchParams({ category:"linear", symbol, settleCoin:"USDT" }).toString();
    const ts  = Date.now().toString();
    const sig = crypto.createHmac("sha256", cfg.bybit.apiSecret)
      .update(ts + cfg.bybit.apiKey + "5000" + qs).digest("hex");
    const d  = await request(`${this.BASE}/v5/position/list?${qs}`, {
      headers: {
        "X-BAPI-API-KEY":     cfg.bybit.apiKey,
        "X-BAPI-TIMESTAMP":   ts,
        "X-BAPI-RECV-WINDOW": "5000",
        "X-BAPI-SIGN":        sig,
      }
    });
    return (d?.result?.list || [])
      .filter(p => parseFloat(p.size) > 0)
      .map(p => ({
        exchange:"Bybit", symbol: p.symbol, side: p.side,
        size: +p.size, entryPrice: +p.avgPrice,
        unrealisedPnl: +p.unrealisedPnl, liqPrice: +p.liqPrice,
        leverage: +p.leverage, stopLoss: +p.stopLoss || 0,
        takeProfit: +p.takeProfit || 0,
      }));
  },

  async placeOrder({ symbol, side, qty, price=null, sl=null, tp=null, leverage=5, cat="linear", orderType=null }) {
    await this.setLeverage(symbol, leverage, cat);
    const body = {
      category: cat, symbol, side,
      orderType: orderType || (price ? "Limit" : "Market"),
      qty: String(qty),
      ...(price ? { price: String(price) } : {}),
      ...(sl    ? { stopLoss: String(sl), slTriggerBy:"MarkPrice" } : {}),
      ...(tp    ? { takeProfit: String(tp), tpTriggerBy:"MarkPrice" } : {}),
      timeInForce: "GTC",
    };
    const ts  = Date.now().toString();
    const sig = this._sign(JSON.stringify(body), ts);
    return await request(`${this.BASE}/v5/order/create`, {
      headers: { "X-BAPI-API-KEY":cfg.bybit.apiKey, "X-BAPI-TIMESTAMP":ts, "X-BAPI-RECV-WINDOW":"5000", "X-BAPI-SIGN":sig },
    }, body);
  },

  async setLeverage(symbol, leverage, cat = "linear") {
    const body = { category:cat, symbol, buyLeverage:String(leverage), sellLeverage:String(leverage) };
    const ts   = Date.now().toString();
    const sig  = this._sign(JSON.stringify(body), ts);
    try {
      return await request(`${this.BASE}/v5/position/set-leverage`, {
        headers: { "X-BAPI-API-KEY":cfg.bybit.apiKey, "X-BAPI-TIMESTAMP":ts, "X-BAPI-RECV-WINDOW":"5000", "X-BAPI-SIGN":sig },
      }, body);
    } catch(e) { /* ignora se leverage já está configurada */ }
  },

  async cancelOrder(symbol, orderId, cat = "linear") {
    const body = { category:cat, symbol, orderId };
    const ts   = Date.now().toString();
    const sig  = this._sign(JSON.stringify(body), ts);
    return await request(`${this.BASE}/v5/order/cancel`, {
      headers: { "X-BAPI-API-KEY":cfg.bybit.apiKey, "X-BAPI-TIMESTAMP":ts, "X-BAPI-RECV-WINDOW":"5000", "X-BAPI-SIGN":sig },
    }, body);
  },

  async closePosition(symbol, side, qty, cat = "linear") {
    return this.placeOrder({ symbol, side: side==="Buy"?"Sell":"Buy", qty, cat, orderType:"Market", reduceOnly:true });
  },
};

// ══════════════════════════════════════════════════════════════════════
// BINANCE
// ══════════════════════════════════════════════════════════════════════
const Binance = {
  name: "Binance",
  BASE:  cfg.binance.baseURL,
  FBASE: cfg.binance.fBaseURL,

  _sign(qs) {
    return crypto.createHmac("sha256", cfg.binance.apiSecret).update(qs).digest("hex");
  },

  _headers() { return { "X-MBX-APIKEY": cfg.binance.apiKey }; },

  async ticker(symbol) {
    const [book, price] = await Promise.all([
      request(`${this.BASE}/api/v3/ticker/bookTicker?symbol=${symbol}`),
      request(`${this.BASE}/api/v3/ticker/price?symbol=${symbol}`),
    ]);
    return {
      exchange:"Binance", symbol,
      bid: +book.bidPrice, ask: +book.askPrice,
      last: +price.price, ts: Date.now(),
    };
  },

  async candles(symbol, interval = "1h", limit = 250) {
    const map = { "15":"15m", "60":"1h", "240":"4h", "D":"1d" };
    const tf  = map[interval] || interval;
    const d   = await request(`${this.BASE}/api/v3/klines?symbol=${symbol}&interval=${tf}&limit=${limit}`);
    return d.map(c => ({ t:+c[0], o:+c[1], h:+c[2], l:+c[3], c:+c[4], v:+c[5] }));
  },

  async orderbook(symbol, limit = 10) {
    const d = await request(`${this.BASE}/api/v3/depth?symbol=${symbol}&limit=${limit}`);
    return {
      exchange:"Binance", symbol,
      bids: (d.bids||[]).map(([p,q])=>({ price:+p, qty:+q })),
      asks: (d.asks||[]).map(([p,q])=>({ price:+p, qty:+q })),
      ts: Date.now(),
    };
  },

  async fundingRate(symbol = "BTCUSDT") {
    const d = await request(`${this.FBASE}/fapi/v1/premiumIndex?symbol=${symbol}`);
    return +(d?.lastFundingRate || 0);
  },

  async balance() {
    const ts  = Date.now();
    const qs  = `timestamp=${ts}`;
    const sig = this._sign(qs);
    const d   = await request(`${this.FBASE}/fapi/v2/balance?${qs}&signature=${sig}`, { headers: this._headers() });
    const usdt = (Array.isArray(d) ? d : []).find(b => b.asset === "USDT") || {};
    return {
      totalEquity:      +(usdt.marginBalance || 0),
      availableBalance: +(usdt.availableBalance || 0),
      unrealisedPnl:    +(usdt.unrealizedProfit || 0),
    };
  },

  async positions() {
    const ts  = Date.now();
    const qs  = `timestamp=${ts}`;
    const sig = this._sign(qs);
    const d   = await request(`${this.FBASE}/fapi/v2/positionRisk?${qs}&signature=${sig}`, { headers: this._headers() });
    return (Array.isArray(d) ? d : [])
      .filter(p => Math.abs(+p.positionAmt) > 0)
      .map(p => ({
        exchange:"Binance", symbol: p.symbol,
        side: +p.positionAmt > 0 ? "Buy" : "Sell",
        size: Math.abs(+p.positionAmt), entryPrice: +p.entryPrice,
        unrealisedPnl: +p.unRealizedProfit, liqPrice: +p.liquidationPrice,
        leverage: +p.leverage,
      }));
  },

  async placeOrder({ symbol, side, qty, price=null, sl=null, tp=null, leverage=5 }) {
    // Define alavancagem
    const ts0 = Date.now();
    const qs0 = `symbol=${symbol}&leverage=${leverage}&timestamp=${ts0}`;
    await request(`${this.FBASE}/fapi/v1/leverage?${qs0}&signature=${this._sign(qs0)}`, { headers: this._headers() }, {}).catch(()=>{});

    const ts  = Date.now();
    let params = `symbol=${symbol}&side=${side}&type=${price?"LIMIT":"MARKET"}&quantity=${qty}&timestamp=${ts}&recvWindow=5000`;
    if (price)  params += `&price=${price}&timeInForce=GTC`;
    if (sl)     params += `&stopLoss=${sl}`;
    if (tp)     params += `&takeProfit=${tp}`;
    params += `&signature=${this._sign(params)}`;
    return await request(`${this.FBASE}/fapi/v1/order?${params}`, { headers: this._headers() }, {});
  },
};

// ══════════════════════════════════════════════════════════════════════
// NOVADEX / HYPERLIQUID DEX
// Novadex é uma DEX de perpetuais construída sobre a Hyperliquid L1
// ══════════════════════════════════════════════════════════════════════
const Novadex = {
  name:   "Novadex",
  API:    cfg.novadex.apiURL,
  wallet: cfg.novadex.walletAddress,

  // Assina requisições para a Hyperliquid
  async _sign(action) {
    if (!cfg.novadex.privateKey) throw new Error("NOVADEX_PRIVATE_KEY não configurada");
    const { ethers } = require("ethers");
    const signer     = new ethers.Wallet(cfg.novadex.privateKey);
    const msgHash    = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(action)));
    const sig        = await signer.signMessage(ethers.getBytes(msgHash));
    return sig;
  },

  // Ticker (preço de mercado da Hyperliquid)
  async ticker(symbol) {
    const coin = symbol.replace("USDT","");
    const d    = await request(`${this.API}/info`, {}, { type:"metaAndAssetCtxs" });
    const meta = d?.[0]?.universe?.find(u => u.name === coin);
    const ctx  = d?.[1]?.[d[0].universe.findIndex(u=>u.name===coin)];
    if (!ctx) throw new Error(`Novadex: ${coin} não encontrado`);
    return {
      exchange: "Novadex", symbol,
      bid:  +ctx.midPx * 0.9999,
      ask:  +ctx.midPx * 1.0001,
      last: +ctx.midPx,
      fundingRate: +ctx.funding || 0,
      openInterest: +ctx.openInterest || 0,
      ts: Date.now(),
    };
  },

  // Candles via Hyperliquid
  async candles(symbol, interval = "60", limit = 250) {
    const coin      = symbol.replace("USDT","");
    const endTime   = Date.now();
    const startTime = endTime - limit * parseInt(interval) * 60 * 1000;
    const d = await request(`${this.API}/info`, {}, {
      type: "candleSnapshot",
      req:  { coin, interval: interval+"m", startTime, endTime },
    });
    return (d || []).map(c => ({ t:+c.t, o:+c.o, h:+c.h, l:+c.l, c:+c.c, v:+c.v }));
  },

  // Orderbook
  async orderbook(symbol) {
    const coin = symbol.replace("USDT","");
    const d    = await request(`${this.API}/info`, {}, { type:"l2Book", coin });
    return {
      exchange:"Novadex", symbol,
      bids: (d?.levels?.[0]||[]).slice(0,10).map(l=>({ price:+l.px, qty:+l.sz })),
      asks: (d?.levels?.[1]||[]).slice(0,10).map(l=>({ price:+l.px, qty:+l.sz })),
      ts: Date.now(),
    };
  },

  // Saldo da carteira
  async balance() {
    if (!this.wallet) return { totalEquity:0, availableBalance:0, unrealisedPnl:0 };
    const d = await request(`${this.API}/info`, {}, { type:"clearinghouseState", user: this.wallet });
    return {
      totalEquity:      +(d?.marginSummary?.accountValue   || 0),
      availableBalance: +(d?.withdrawable                  || 0),
      unrealisedPnl:    +(d?.marginSummary?.totalUnrealizedPnl || 0),
    };
  },

  // Posições abertas
  async positions() {
    if (!this.wallet) return [];
    const d = await request(`${this.API}/info`, {}, { type:"clearinghouseState", user: this.wallet });
    return (d?.assetPositions || [])
      .filter(p => parseFloat(p.position?.szi) !== 0)
      .map(p => ({
        exchange:"Novadex",
        symbol:  p.position.coin + "USDT",
        side:    +p.position.szi > 0 ? "Buy" : "Sell",
        size:    Math.abs(+p.position.szi),
        entryPrice:    +p.position.entryPx,
        unrealisedPnl: +p.position.unrealizedPnl,
        leverage:      +p.position.leverage?.value || 1,
      }));
  },

  // Ordem de mercado na Hyperliquid
  async placeOrder({ symbol, side, qty, price=null, sl=null, leverage=5 }) {
    if (!cfg.novadex.privateKey) throw new Error("NOVADEX_PRIVATE_KEY não configurada");
    const { ethers } = require("ethers");
    const coin       = symbol.replace("USDT","");
    const isBuy      = side === "Buy";
    const px         = price ? String(price) : "0";
    const action = {
      type: "order",
      orders: [{
        a:  0,               // asset index (simplificado — usar mapa real em produção)
        b:  isBuy,
        p:  px,
        s:  String(qty),
        r:  false,           // reduceOnly
        t:  { limit: { tif: price ? "Gtc" : "Ioc" } },
      }],
      grouping: "na",
    };
    const signer   = new ethers.Wallet(cfg.novadex.privateKey);
    const msgBytes = ethers.toUtf8Bytes(JSON.stringify(action));
    const hash     = ethers.keccak256(msgBytes);
    const sig      = await signer.signMessage(ethers.getBytes(hash));
    return await request(`${this.API}/exchange`, {}, {
      action,
      nonce: Date.now(),
      signature: { r: sig.slice(0,66), s:"0x"+sig.slice(66,130), v: parseInt(sig.slice(130,132),16) },
    });
  },
};


// ── Testa qual endpoint está disponível ──────────────────────────────
async function testBybitConnectivity() {
  const endpoints = [
    "https://api.bytick.com",
    "https://api.bybit.com",
  ];
  for (const base of endpoints) {
    try {
      const d = await request(`${base}/v5/market/tickers?category=linear&symbol=BTCUSDT`);
      if (d?.result?.list?.[0]) {
        console.log(`[BYBIT] Conectado via ${base}`);
        Bybit.BASE = base;
        Bybit.ENDPOINTS.unshift(base); // prioriza este
        return base;
      }
    } catch(e) {
      console.warn(`[BYBIT] ${base} bloqueado: ${e.message.slice(0,60)}`);
    }
  }
  console.error("[BYBIT] Todos os endpoints bloqueados");
  return null;
}

module.exports = { Bybit, Binance, Novadex, testBybitConnectivity };
