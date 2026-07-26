# ACS Trading Bot — Sistema de Operações Automáticas

## Stack
- **Node.js** + Express + WebSocket
- **CEX:** Bybit (futuros perpétuos) + Binance (futuros)
- **DEX:** Novadex / Hyperliquid L1

## Deploy no Railway
1. Crie novo repositório GitHub com todos os arquivos
2. Railway → New Project → Deploy from GitHub
3. Adicione as variáveis do `.env.example` em Variables
4. Start command: `node index.js`

## Segurança — IMPORTANTE
- Comece com `BYBIT_TESTNET=true` para testar
- Mantenha `SIG_AUTO_EXECUTE=false` até validar os sinais
- Use chaves API com permissão apenas de Trading (nunca Saque)
- `MAX_DAILY_LOSS=3` é recomendado para começar

## Rotas da API (requer x-admin-key no header)
```
POST /api/scan/start        → inicia scan de sinais
POST /api/scan/auto         → ativa auto-scan a cada 15min
POST /api/arb/scan          → scan de arbitragem
GET  /api/signals           → lista sinais detectados
GET  /api/arb               → lista oportunidades de arb
POST /api/execute/signal    → executa sinal manualmente
POST /api/execute/arb       → executa arb manualmente
GET  /api/analyze/:symbol   → analisa um par específico
GET  /api/balances          → saldo nas 3 exchanges
GET  /api/positions         → posições abertas
GET  /api/status            → status geral + risco
GET  /api/trades            → log de operações
```

## Tipos de operação detectados
| Tipo | Descrição |
|------|-----------|
| Scanner de sinais | RSI + MACD + Wyckoff + SMC + Elliott + Volume + MTF |
| Cross-exchange arb | Mesmo par com preços diferentes nas 3 exchanges |
| Triangular arb | BTC→ETH→ALT→BTC dentro da Bybit |
| Funding rate arb | Diferencial de funding entre exchanges |
| Basis arb | Spot vs perpetual, Bybit vs Novadex |

## Gerenciamento de risco automático
- Trailing stop em todas as posições
- Limite de perda diária configurável
- Máximo de posições simultâneas
- Stop loss automático via ATR × 1.8
- Fechamento parcial em cada alvo (TP1/TP2/TP3)
