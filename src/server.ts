import express from 'express';
import axios from 'axios';
import { EMA, RSI } from 'technicalindicators';

const app = express();
const PORT = 3000;

const TELEGRAM_TOKEN = '7679884492:AAEYrobefq0YYBV0P4h744gKpALjWin_hj0';
const TELEGRAM_CHAT_ID = '312345361';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'BNBUSDT', 'SOLUSDT', 'TRXUSDT', 'ADAUSDT', 'LINKUSDT', 'AVAXUSDT'];

const STRATEGY_INTERVAL = '15m';
const CONFIRMATION_INTERVAL = '1h';

interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

async function fetchPublicKlines(symbol: string, interval: string, limit = 100): Promise<Candle[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const response = await axios.get(url);
  return response.data.map((candle: any) => ({
    openTime: candle[0],
    open: parseFloat(candle[1]),
    high: parseFloat(candle[2]),
    low: parseFloat(candle[3]),
    close: parseFloat(candle[4]),
    volume: parseFloat(candle[5]),
    closeTime: candle[6]
  }));
}

async function sendTelegramAlert(message: string) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    });
  } catch (err: any) {
    console.error('Erro ao enviar alerta no Telegram:', err?.response?.data || err.message);
  }
}

function calculateIndicators(closes: number[], volumes: number[]) {
  const ema9 = EMA.calculate({ period: 9, values: closes });
  const ema21 = EMA.calculate({ period: 21, values: closes });
  const rsi = RSI.calculate({ period: 5, values: closes });
  const avgVolumeLast5 = volumes.slice(-7, -2).reduce((acc, v) => acc + v, 0) / 5;
  return { ema9, ema21, rsi, avgVolumeLast5 };
}

function getTrendFromEMA(ema9: number[], ema21: number[]): 'alta' | 'baixa' | 'lateral' {
  const lenEma9 = ema9.length;
  const lenEma21 = ema21.length;
  if (ema9[lenEma9 - 2] > ema21[lenEma21 - 2]) return 'alta';
  if (ema9[lenEma9 - 2] < ema21[lenEma21 - 2]) return 'baixa';
  return 'lateral';
}

async function analyzeStrategy(symbol: string, btcTrend: 'alta' | 'baixa' | 'lateral') {
  const candles15m = await fetchPublicKlines(symbol, STRATEGY_INTERVAL);
  const closes15m = candles15m.map(c => c.close);
  const volumes15m = candles15m.map(c => c.volume);
  const indicators15m = calculateIndicators(closes15m, volumes15m);
  const last15m = closes15m.length - 1;

  const trend15m = getTrendFromEMA(indicators15m.ema9, indicators15m.ema21);
  const rsi = indicators15m.rsi[indicators15m.rsi.length - 1];
  const volume = volumes15m[last15m];
  const volumeOk = volumes15m[last15m - 1] > indicators15m.avgVolumeLast5;
  const price = closes15m[last15m];

  const candles1h = await fetchPublicKlines(symbol, CONFIRMATION_INTERVAL);
  const closes1h = candles1h.map(c => c.close);
  const volumes1h = candles1h.map(c => c.volume);
  const indicators1h = calculateIndicators(closes1h, volumes1h);
  const trend1h = getTrendFromEMA(indicators1h.ema9, indicators1h.ema21);
  const trendConfirmada = trend1h === trend15m && trend15m !== 'lateral';

  let signal = '⛔ Nenhum sinal';
  const observandoLong = btcTrend === 'alta' && trend15m === 'alta' && rsi >= 30 && rsi < 35 && volumeOk && trendConfirmada;
  const observandoShort = btcTrend === 'baixa' && trend15m === 'baixa' && rsi <= 70 && rsi > 65 && volumeOk && trendConfirmada;

  if (observandoLong || observandoShort) {
    signal = '🔍 Em observação';
    await sendTelegramAlert(`🔍 *OBSERVAÇÃO* - ${symbol}\nPreço: $${price.toFixed(2)}\nRSI: ${rsi.toFixed(2)}\nTendência: ${trend15m} confirmada`);
  }

  if (btcTrend === 'alta' && trend15m === 'alta' && rsi < 30 && volumeOk && trendConfirmada) {
    signal = '✅ LONG';
    await sendTelegramAlert(`✅ *LONG* - ${symbol}\nPreço: $${price.toFixed(2)}\nRSI: ${rsi.toFixed(2)}\nTendência: Alta confirmada`);
  }

  if (btcTrend === 'baixa' && trend15m === 'baixa' && rsi > 70 && volumeOk && trendConfirmada) {
    signal = '✅ SHORT';
    await sendTelegramAlert(`✅ *SHORT* - ${symbol}\nPreço: $${price.toFixed(2)}\nRSI: ${rsi.toFixed(2)}\nTendência: Baixa confirmada`);
  }

  return {
    symbol,
    price: `$${price.toFixed(2)}`,
    rsi: `${rsi.toFixed(2)}`,
    volume: `${volume.toFixed(2)} (${volumeOk ? 'Acima da média' : 'Abaixo'})`,
    emaTrend: trend15m,
    trend1h,
    signal
  };
}

async function runFullAnalysis() {
  const btcCandles = await fetchPublicKlines('BTCUSDT', STRATEGY_INTERVAL);
  const btcCloses = btcCandles.map(c => c.close);
  const btcVolumes = btcCandles.map(c => c.volume);
  const btcIndicators = calculateIndicators(btcCloses, btcVolumes);
  const btcTrend = getTrendFromEMA(btcIndicators.ema9, btcIndicators.ema21);

  const results = [];
  for (const symbol of SYMBOLS) {
    if (symbol !== 'BTCUSDT') {
      const analysis = await analyzeStrategy(symbol, btcTrend);
      results.push(analysis);
    }
  }

  return {
    hora: new Date().toISOString(),
    tendenciaBTC: btcTrend,
    resultados: results
  };
}

app.get('/analyze', async (_req, res) => {
  try {
    const analysis = await runFullAnalysis();
    res.json(analysis);
  } catch (error: any) {
    res.status(500).json({ error: 'Erro ao executar análise', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});