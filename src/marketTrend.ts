import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

type Candle = [string, number, number, number, number, number];
type HistoricalFetcher = (path: string) => Promise<any>;

const IST_OFFSET_MS = 330 * 60 * 1000;

function istNow(): Date {
  return new Date(Date.now() + IST_OFFSET_MS);
}

function formatIst(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function shiftDays(date: Date, days: number): Date {
  return new Date(date.getTime() - days * 24 * 60 * 60 * 1000);
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : NaN;
}

function ema(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = Array(values.length).fill(null);
  if (values.length < period) return result;
  const multiplier = 2 / (period + 1);
  let current = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  result[period - 1] = current;
  for (let i = period; i < values.length; i++) {
    current = (values[i] - current) * multiplier + current;
    result[i] = current;
  }
  return result;
}

function calculateIndicators(candles: Candle[]) {
  const high = candles.map((c) => c[2]);
  const low = candles.map((c) => c[3]);
  const close = candles.map((c) => c[4]);
  const tr = candles.map((c, i) => {
    if (i === 0) return c[2] - c[3];
    return Math.max(c[2] - c[3], Math.abs(c[2] - close[i - 1]), Math.abs(c[3] - close[i - 1]));
  });

  const atr: Array<number | null> = Array(candles.length).fill(null);
  if (candles.length >= 10) {
    let current = tr.slice(0, 10).reduce((sum, value) => sum + value, 0) / 10;
    atr[9] = current;
    for (let i = 10; i < candles.length; i++) {
      current = (current * 9 + tr[i]) / 10;
      atr[i] = current;
    }
  }

  const basicUpper = candles.map((c, i) => atr[i] === null ? null : (c[2] + c[3]) / 2 + 3 * atr[i]!);
  const basicLower = candles.map((c, i) => atr[i] === null ? null : (c[2] + c[3]) / 2 - 3 * atr[i]!);
  const finalUpper: Array<number | null> = Array(candles.length).fill(null);
  const finalLower: Array<number | null> = Array(candles.length).fill(null);
  const supertrend: Array<number | null> = Array(candles.length).fill(null);
  const direction: Array<"BULLISH" | "BEARISH" | null> = Array(candles.length).fill(null);

  for (let i = 9; i < candles.length; i++) {
    const prevClose = i > 0 ? close[i - 1] : close[i];
    finalUpper[i] = basicUpper[i] !== null
      ? (i === 9 || finalUpper[i - 1] === null || basicUpper[i]! < finalUpper[i - 1]! || prevClose > finalUpper[i - 1]!
        ? basicUpper[i] : finalUpper[i - 1])
      : null;
    finalLower[i] = basicLower[i] !== null
      ? (i === 9 || finalLower[i - 1] === null || basicLower[i]! > finalLower[i - 1]! || prevClose < finalLower[i - 1]!
        ? basicLower[i] : finalLower[i - 1])
      : null;

    if (i === 9) {
      direction[i] = close[i] >= (high[i] + low[i]) / 2 ? "BULLISH" : "BEARISH";
    } else if (direction[i - 1] === "BULLISH") {
      direction[i] = close[i] < finalLower[i]! ? "BEARISH" : "BULLISH";
    } else {
      direction[i] = close[i] > finalUpper[i]! ? "BULLISH" : "BEARISH";
    }
    supertrend[i] = direction[i] === "BULLISH" ? finalLower[i] : finalUpper[i];
  }

  const plusDm = Array(candles.length).fill(0);
  const minusDm = Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const up = high[i] - high[i - 1];
    const down = low[i - 1] - low[i];
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }

  const plusDi: Array<number | null> = Array(candles.length).fill(null);
  const minusDi: Array<number | null> = Array(candles.length).fill(null);
  const dx: Array<number | null> = Array(candles.length).fill(null);
  for (let i = 13; i < candles.length; i++) {
    const start = Math.max(1, i - 13);
    const trSum = tr.slice(start, i + 1).reduce((sum, value) => sum + value, 0);
    const plusSum = plusDm.slice(start, i + 1).reduce((sum, value) => sum + value, 0);
    const minusSum = minusDm.slice(start, i + 1).reduce((sum, value) => sum + value, 0);
    if (trSum > 0) {
      plusDi[i] = 100 * plusSum / trSum;
      minusDi[i] = 100 * minusSum / trSum;
      const denominator = plusDi[i]! + minusDi[i]!;
      dx[i] = denominator > 0 ? 100 * Math.abs(plusDi[i]! - minusDi[i]!) / denominator : 0;
    }
  }

  const adx: Array<number | null> = Array(candles.length).fill(null);
  const firstDx = dx.findIndex((value) => value !== null);
  if (firstDx >= 0 && candles.length >= firstDx + 14) {
    const seed = dx.slice(firstDx, firstDx + 14).filter((value): value is number => value !== null);
    if (seed.length === 14) {
      let current = seed.reduce((sum, value) => sum + value, 0) / 14;
      const seedIndex = firstDx + 13;
      adx[seedIndex] = current;
      for (let i = seedIndex + 1; i < candles.length; i++) {
        if (dx[i] !== null) {
          current = (current * 13 + dx[i]!) / 14;
          adx[i] = current;
        }
      }
    }
  }

  const ema20 = ema(close, 20);
  const ema50 = ema(close, 50);
  const i = candles.length - 1;
  const previousAdx = adx.slice(0, i).filter((value): value is number => value !== null).at(-1) ?? null;
  const currentAdx = adx[i] ?? null;
  const currentPlusDi = plusDi[i] ?? null;
  const currentMinusDi = minusDi[i] ?? null;
  const trend = direction[i] ?? "UNAVAILABLE";
  const emaAlignment = ema20[i] !== null && ema50[i] !== null
    ? (close[i] > ema20[i]! && ema20[i]! > ema50[i]! ? "BULLISH"
      : close[i] < ema20[i]! && ema20[i]! < ema50[i]! ? "BEARISH" : "MIXED")
    : "INSUFFICIENT_DATA";
  const dmiDirection = currentPlusDi === null || currentMinusDi === null
    ? "UNAVAILABLE"
    : currentPlusDi > currentMinusDi ? "BULLISH" : currentMinusDi > currentPlusDi ? "BEARISH" : "NEUTRAL";
  const strength = currentAdx === null ? "UNAVAILABLE"
    : currentAdx >= 25 ? "STRONG"
    : currentAdx >= 20 ? "DEVELOPING"
    : "WEAK / NON-TRENDING";
  const adxSlope = currentAdx === null || previousAdx === null ? "UNAVAILABLE"
    : currentAdx > previousAdx ? "RISING" : currentAdx < previousAdx ? "FALLING" : "FLAT";

  return {
    candle_time: candles[i][0],
    candles_used: candles.length,
    close: close[i],
    ema20: ema20[i] === null ? null : Number(ema20[i]!.toFixed(2)),
    ema50: ema50[i] === null ? null : Number(ema50[i]!.toFixed(2)),
    ema_alignment: emaAlignment,
    supertrend_10_3: supertrend[i] === null ? null : Number(supertrend[i]!.toFixed(2)),
    supertrend_direction: trend,
    plus_di_14: currentPlusDi === null ? null : Number(currentPlusDi.toFixed(2)),
    minus_di_14: currentMinusDi === null ? null : Number(currentMinusDi.toFixed(2)),
    adx_14: currentAdx === null ? null : Number(currentAdx.toFixed(2)),
    adx_strength: strength,
    adx_slope: adxSlope,
    dmi_direction: dmiDirection,
  };
}

function summarize(name: string, candles: Candle[], timeframe: string) {
  if (candles.length < 55) {
    throw new Error(name + " " + timeframe + " has only " + candles.length + " usable candles; at least 55 are required for EMA50 and DMI/ADX.");
  }
  return { instrument: name, timeframe, indicators: calculateIndicators(candles) };
}

function classify(daily: any, intraday: any): string {
  const scores = [daily.indicators.supertrend_direction, daily.indicators.ema_alignment, daily.indicators.dmi_direction,
    intraday.indicators.supertrend_direction, intraday.indicators.ema_alignment, intraday.indicators.dmi_direction];
  const bull = scores.filter((x) => x === "BULLISH").length;
  const bear = scores.filter((x) => x === "BEARISH").length;
  if (bull >= 5) return "BULLISH — strong multi-timeframe alignment";
  if (bear >= 5) return "BEARISH — strong multi-timeframe alignment";
  if (bull > bear && bull >= 3) return "BULLISH BIAS — confirmation incomplete";
  if (bear > bull && bear >= 3) return "BEARISH BIAS — confirmation incomplete";
  return "MIXED / SIDEWAYS — avoid forcing a directional credit spread";
}

export function registerMarketTrendTool(
  server: McpServer,
  fetchHistorical: HistoricalFetcher
) {
  server.registerTool(
    "market_trend_assessment",
    {
      description: "Read-only NIFTY 50 and BANK NIFTY market trend assessment using Zerodha historical candles. Calculates EMA20, EMA50, SuperTrend (10,3), DMI (+DI/-DI) and ADX(14) on completed daily and 60-minute candles. Identifies trend alignment, strength and weakening. No orders or positions are changed.",
      inputSchema: {
        lookback_days: z.number().int().min(100).max(350).optional(),
      },
    },
    async ({ lookback_days }) => {
      const now = istNow();
      const today = formatIst(now).slice(0, 10);
      const dailyFrom = formatIst(shiftDays(now, lookback_days ?? 300)).slice(0, 10) + " 00:00:00";
      const intradayFrom = formatIst(shiftDays(now, 31)).slice(0, 10) + " 09:15:00";
      const to = formatIst(now);
      const instruments = [
        { name: "NIFTY 50", token: 256265 },
        { name: "BANK NIFTY", token: 260105 },
      ];

      const assessments = await Promise.all(instruments.map(async (instrument) => {
        const [dailyResponse, hourlyResponse] = await Promise.all([
          fetchHistorical("/instruments/historical/" + instrument.token + "/day?" +
            new URLSearchParams({ from: dailyFrom, to }).toString()),
          fetchHistorical("/instruments/historical/" + instrument.token + "/60minute?" +
            new URLSearchParams({ from: intradayFrom, to }).toString()),
        ]);
        const dailyCandles: Candle[] = (Array.isArray(dailyResponse?.data?.candles) ? dailyResponse.data.candles : []).filter((c: Candle) => c[0].slice(0, 10) < today);
        const hourlyCandles: Candle[] = Array.isArray(hourlyResponse?.data?.candles) ? hourlyResponse.data.candles : [];
        // Exclude the current session from intraday aggregation so incomplete live candles cannot create false signals.
        const completedHourly = hourlyCandles.filter((c) => c[0].slice(0, 10) < today);
        const completedHourlyCandles = completedHourly;
        const daily = summarize(instrument.name, dailyCandles, "1D");
        const intraday = summarize(instrument.name, completedHourlyCandles, "60M (completed candles)");
        return {
          instrument: instrument.name,
          daily,
          intraday,
          overall_assessment: classify(daily, intraday),
        };
      }));

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "LIVE",
            dashboard: "Market Trend & Momentum Assessment",
            as_of: new Date().toISOString(),
            data_source: "Zerodha Kite Connect historical OHLC",
            methodology: {
              primary_trend: "SuperTrend (10,3)",
              moving_averages: ["EMA20", "EMA50"],
              trend_strength: "DMI / ADX(14); ADX >=25 strong, 20-25 developing, below 20 weak/non-trending",
              timeframes: ["Completed daily candles", "Completed 60-minute OHLC candles"],
              lookback_days: lookback_days ?? 300,
              current_session_intraday_candles_excluded: true,
            },
            assessments,
            interpretation: "ADX measures trend strength, not direction. +DI above -DI indicates positive directional pressure; -DI above +DI indicates negative directional pressure. Falling ADX indicates weakening trend strength, not necessarily a reversal.",
            read_only: true,
            trading_action_taken: false,
          }, null, 2),
        }],
      };
    }
  );
}
