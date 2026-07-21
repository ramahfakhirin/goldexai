import { Candle, IndicatorsResult, calculateEMA, getIndicators, getBerkahSignal } from "./indicators.js";

/**
 * Computes high-timeframe trend bias from H1 candles.
 * Returns { bias: "BULL" | "BEAR" | "RANGING" | null, note: string }
 */
export function computeHtfBiasFromH1(candlesH1: Candle[] | null): { bias: "BULL" | "BEAR" | "RANGING" | null; note: string } {
  if (!candlesH1 || candlesH1.length === 0) {
    return { bias: null, note: "H1 tidak tersedia" };
  }

  try {
    const closes = candlesH1.map((c) => c.close);
    const n = closes.length;
    let fastPeriod = 50;
    let slowPeriod = 200;
    let pair = "EMA50/200 H1";

    if (n >= 210) {
      fastPeriod = 50;
      slowPeriod = 200;
      pair = "EMA50/200 H1";
    } else if (n >= 60) {
      fastPeriod = 20;
      slowPeriod = 50;
      pair = "EMA20/50 H1";
    } else {
      return { bias: null, note: `H1 hanya ${n} candle (butuh >=60)` };
    }

    const emaFast = calculateEMA(closes, fastPeriod);
    const emaSlow = calculateEMA(closes, slowPeriod);

    const lastFast = emaFast[emaFast.length - 1];
    const lastSlow = emaSlow[emaSlow.length - 1];

    const priceH1 = closes[closes.length - 1];
    const gap = lastFast - lastSlow;
    const minGap = priceH1 * 0.001; // 0.1% of price

    if (gap > minGap) {
      return { bias: "BULL", note: `${pair} bull, gap ${gap >= 0 ? "+" : ""}${gap.toFixed(2)}` };
    }
    if (gap < -minGap) {
      return { bias: "BEAR", note: `${pair} bear, gap ${gap.toFixed(2)}` };
    }
    return { bias: "RANGING", note: `${pair} flat, gap ${gap.toFixed(2)} < ${minGap.toFixed(2)}` };
  } catch (err: any) {
    return { bias: null, note: `H1 error: ${err.message}` };
  }
}

/**
 * Computes high-timeframe trend bias from H4 candles.
 * Returns { bias: "BULL" | "BEAR" | "RANGING" | null, note: string }
 */
export function computeHtfBiasFromH4(candlesH4: Candle[] | null): { bias: "BULL" | "BEAR" | "RANGING" | null; note: string } {
  if (!candlesH4 || candlesH4.length === 0) {
    return { bias: null, note: "H4 tidak tersedia" };
  }

  try {
    const closes = candlesH4.map((c) => c.close);
    const n = closes.length;
    let fastPeriod = 50;
    let slowPeriod = 200;
    let pair = "EMA50/200 H4";

    if (n >= 60) {
      fastPeriod = 20;
      slowPeriod = 50;
      pair = "EMA20/50 H4";
    } else if (n >= 20) {
      fastPeriod = 10;
      slowPeriod = 20;
      pair = "EMA10/20 H4";
    } else {
      return { bias: null, note: `H4 hanya ${n} candle (butuh >=20)` };
    }

    const emaFast = calculateEMA(closes, fastPeriod);
    const emaSlow = calculateEMA(closes, slowPeriod);

    const lastFast = emaFast[emaFast.length - 1];
    const lastSlow = emaSlow[emaSlow.length - 1];

    const priceH4 = closes[closes.length - 1];
    const gap = lastFast - lastSlow;
    const minGap = priceH4 * 0.001; // 0.1% of price

    if (gap > minGap) {
      return { bias: "BULL", note: `${pair} bull, gap ${gap >= 0 ? "+" : ""}${gap.toFixed(2)}` };
    }
    if (gap < -minGap) {
      return { bias: "BEAR", note: `${pair} bear, gap ${gap.toFixed(2)}` };
    }
    return { bias: "RANGING", note: `${pair} flat, gap ${gap.toFixed(2)} < ${minGap.toFixed(2)}` };
  } catch (err: any) {
    return { bias: null, note: `H4 error: ${err.message}` };
  }
}

/**
 * Computes the final aligned HTF Confluence Bias from BOTH H1 and H4 trends.
 * Sinyal BUY hanya akan valid jika trend utama H1 minimal bersifat Bullish.
 */
export function computeAlignedHtfConfluence(candlesH1: Candle[] | null, candlesH4: Candle[] | null): { bias: "BULL" | "BEAR" | "RANGING" | null; note: string } {
  const h1 = computeHtfBiasFromH1(candlesH1);
  const h4 = computeHtfBiasFromH4(candlesH4);

  if (!h1.bias) {
    return { bias: null, note: `H1 bias null: ${h1.note}` };
  }

  // If H4 is not available, default to H1 bias
  if (!h4.bias) {
    return { bias: h1.bias, note: `H1 (${h1.bias}) | H4 N/A (${h4.note})` };
  }

  // Aligned trend confluence
  if (h1.bias === "BULL") {
    if (h4.bias === "BULL" || h4.bias === "RANGING") {
      return { bias: "BULL", note: `CONFLUENCE BULL: H1 Bullish (${h1.note}) & H4 Aligned (${h4.note})` };
    } else {
      return { bias: "RANGING", note: `HTF Conflict: H1 Bullish but H4 Bearish. Standing aside.` };
    }
  }

  if (h1.bias === "BEAR") {
    if (h4.bias === "BEAR" || h4.bias === "RANGING") {
      return { bias: "BEAR", note: `CONFLUENCE BEAR: H1 Bearish (${h1.note}) & H4 Aligned (${h4.note})` };
    } else {
      return { bias: "RANGING", note: `HTF Conflict: H1 Bearish but H4 Bullish. Standing aside.` };
    }
  }

  return { bias: "RANGING", note: `RANGING: H1 flat (${h1.note}) | H4 (${h4.note})` };
}

export interface MtfScanResult {
  htf: { bias: string; note: string };
  m5: any;
  m1: any;
  best: any;
  summary: string;
}

/**
 * Runs the Multi-Timeframe Signal scan over M1 and M5 timeframes,
 * gated by HTF H1/H4 aligned bias.
 */
export function runMultiTimeframeScan(
  candlesM1: Candle[] | null,
  candlesM5: Candle[] | null,
  candlesH1: Candle[] | null,
  candlesH4: Candle[] | null = null,
  capital: number = 2000.0,
  riskPercent: number = 1.5,
  valuePerLot: number = 10.0,
  martingaleMultiplier: number = 1
): MtfScanResult {
  const results: any = {};

  // 1. Calculate HTF Bias using both H1 & H4
  const { bias: htfBias, note: htfNote } = computeAlignedHtfConfluence(candlesH1, candlesH4);
  console.log(`🧭 HTF H1/H4 Confluence → ${htfBias || "FALLBACK"} (${htfNote})`);
  results.htf = { bias: htfBias || "FALLBACK", note: htfNote };

  // 2. Scan M5
  try {
    if (!candlesM5 || candlesM5.length === 0) {
      throw new Error("M5 data kosong");
    }
    const indicM5 = getIndicators(candlesM5);
    const sigM5 = getBerkahSignal(
      candlesM5,
      indicM5,
      4, // scoreThreshold M5 = 4
      5, // scoreHighConf M5 = 5
      capital,
      riskPercent,
      valuePerLot,
      htfBias || undefined,
      martingaleMultiplier
    );
    sigM5.timeframe = "M5";
    results.m5 = sigM5;
    console.log(`📊 M5  → ${sigM5.signal} | score=${sigM5.score ?? 0}/7 | ${sigM5.confidence ?? ""}`);
  } catch (err: any) {
    console.error(`⚠️ M5 scan error: ${err.message}`);
    results.m5 = { signal: "WAIT", timeframe: "M5", reason: err.message, score: 0 };
  }

  // 3. Scan M1
  try {
    if (!candlesM1 || candlesM1.length === 0) {
      throw new Error("M1 data kosong");
    }
    const indicM1 = getIndicators(candlesM1);
    const sigM1 = getBerkahSignal(
      candlesM1,
      indicM1,
      4, // scoreThreshold M1 = 4
      5, // scoreHighConf M1 = 5
      capital,
      riskPercent,
      valuePerLot,
      htfBias || undefined,
      martingaleMultiplier
    );
    sigM1.timeframe = "M1";
    results.m1 = sigM1;
    console.log(`📊 M1  → ${sigM1.signal} | score=${sigM1.score ?? 0}/7 | ${sigM1.confidence ?? ""}`);
  } catch (err: any) {
    console.error(`⚠️ M1 scan error: ${err.message}`);
    results.m1 = { signal: "WAIT", timeframe: "M1", reason: err.message, score: 0 };
  }

  // 4. M1 Subordinate Veto
  // M1 signal is only valid if M5 aligns, or M5 directional score is >= 4
  const m1 = results.m1;
  const m5 = results.m5;
  if (m1 && (m1.signal === "BUY" || m1.signal === "SELL")) {
    const dir = m1.signal;
    const m5Sig = m5?.signal || "WAIT";
    const m5Score = m5?.score || 0;
    const isM5Aligned = m5Sig === dir;
    // We check if the M5 directional score is less than 4
    const m5DirScore = dir === "BUY" ? (m5?.conditions?.score_buy ?? 0) : (m5?.conditions?.score_sell ?? 0);

    if (!isM5Aligned && m5DirScore < 4) {
      console.log(`🚫 M1 ${dir} diveto — M5=${m5Sig}, skor arah M5=${m5DirScore}/7 < 4`);
      results.m1 = {
        ...m1,
        signal: "WAIT",
        confidence: "M1_VETOED",
        reason: `M1 ${dir} diveto — M5 tidak konfirmasi (M5=${m5Sig}, skor ${dir.toLowerCase()} M5=${m5DirScore}/7 < 4). ${m1.reason || ""}`,
      };
    }
  }

  // 5. Select Best Signal
  // Priority: HIGH_CONFIDENCE > NORMAL, M5 > M1 if equal score
  const active: any[] = [];
  if (results.m5 && (results.m5.signal === "BUY" || results.m5.signal === "SELL")) active.push(results.m5);
  if (results.m1 && (results.m1.signal === "BUY" || results.m1.signal === "SELL")) active.push(results.m1);

  let best: any;
  if (active.length === 0) {
    best = { signal: "WAIT", timeframe: "BOTH", reason: "Tidak ada sinyal aktif di M1 maupun M5" };
  } else if (active.length === 1) {
    best = active[0];
  } else {
    // Both active — choose based on confidence and score
    best = active.reduce((maxSig, current) => {
      const maxConfScore = maxSig.confidence === "HIGH_CONFIDENCE" || maxSig.confidence >= 75 ? 2 : 1;
      const curConfScore = current.confidence === "HIGH_CONFIDENCE" || current.confidence >= 75 ? 2 : 1;
      
      if (curConfScore !== maxConfScore) {
        return curConfScore > maxConfScore ? current : maxSig;
      }
      if ((current.score ?? 0) !== (maxSig.score ?? 0)) {
        return (current.score ?? 0) > (maxSig.score ?? 0) ? current : maxSig;
      }
      return current.timeframe === "M5" ? current : maxSig;
    });
  }

  results.best = best;

  const m5Sig = results.m5?.signal || "WAIT";
  const m1Sig = results.m1?.signal || "WAIT";
  const m5Sc = results.m5?.score || 0;
  const m1Sc = results.m1?.score || 0;
  const m5Conf = results.m5?.confidence || "";
  const m1Conf = results.m1?.confidence || "";

  results.summary = `MTF Scan — M5: ${m5Sig} [${m5Sc}/7 ${m5Conf}] | M1: ${m1Sig} [${m1Sc}/7 ${m1Conf}] | BEST: ${best.signal} dari ${best.timeframe || "?"}`;
  console.log(`✅ ${results.summary}`);

  return results;
}
