User@DESKTOP-FB4ENC6 MINGW64 ~/TRADING-BOT (main)
$ node -e "require('dotenv').config();const s=require('./scanner');s.fullScan({onSignal:r=>console.log('SINAL:',r.symbol,r.dir,r.score),onProgress:p=>{if(p.done%20===0)console.log('Progresso:',p.done+'/'+p.total)},exchange:'bybit'}).then(r=>console.log('FIM - sinais:',r.signals,'total:',r.total)).catch(e=>console.log('ERRO:',e.message))"
Progresso: 20/100
Progresso: 40/100
Progresso: 60/100
Progresso: 80/100
Progresso: 100/100
FIM - sinais: 0 total: 100
