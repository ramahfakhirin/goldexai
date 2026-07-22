import { GoogleGenAI, GenerateContentResponse } from "@google/genai";
import dotenv from "dotenv";
import { nowWibStr } from "./api.js";

dotenv.config();

// Initialize the Gemini API client lazily
let aiInstance: GoogleGenAI | null = null;

function getAIClient(): GoogleGenAI {
  if (!aiInstance) {
    const key = process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error("GEMINI_API_KEY environment variable is required for AI Vision Analysis. Please configure it in your environment.");
    }
    aiInstance = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiInstance;
}

export interface VisionResult {
  verdict: "VALID" | "SKIP" | "WAIT_FOR_PULLBACK";
  confidence_vision: number;
  reasoning: string;
  key_observations: string[];
  risk_notes: string[];
  price_action_quality: "STRONG" | "MODERATE" | "WEAK";
  entry_timing: "IDEAL" | "ACCEPTABLE" | "PREMATURE" | "LATE";
  visual_trend: "BULLISH" | "BEARISH" | "RANGING";
  
  // Appended fields
  final_signal?: string;
  combined_confidence?: number;
  original_signal?: string;
  system_confidence?: number;
}

/**
 * Sends the base64-encoded chart to Gemini Vision for confirmation.
 */
export async function confirmSignalVision(
  chartB64: string,
  signal: string,
  price: number,
  timeframe: string,
  entry: number,
  stopLoss: number,
  tp1: number,
  tp2: number,
  tp3: number,
  confidence: number,
  indicators: Record<string, any>,
  smc: Record<string, any>
): Promise<VisionResult> {
  const prompt = `You are a senior XAU/USD trader with expertise in SMC (Smart Money Concepts) and price action.

I will send you a chart for XAU/USD timeframe ${timeframe.toUpperCase()} along with analysis data from the trading system.

═══════════════════════════════════
SYSTEM DATA (from technical calculations)
═══════════════════════════════════

Signal   : ${signal}
Timeframe: ${timeframe.toUpperCase()}
Price    : $${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
Confidence: ${confidence}%

ENTRY PLAN:
• Entry   : ${entry}
• SL      : ${stopLoss}  
• TP1     : ${tp1}
• TP2     : ${tp2}
• TP3     : ${tp3}

INDICATORS:
• EMA 21  : ${indicators.ema_21 ?? "-"} ${price > parseFloat(indicators.ema_21 ?? price) ? "(price above = bullish)" : "(price below = bearish)"}
• EMA 50  : ${indicators.ema_50 ?? "-"}
• EMA 200 : ${indicators.ema_200 ?? "-"}
• RSI     : ${indicators.rsi ?? "-"}
• MACD    : ${indicators.macd ?? "-"} | Signal: ${indicators.macd_signal ?? "-"}
• ATR     : ${indicators.atr ?? "-"}

SMC STRUCTURE:
• Trend   : ${smc.trend ?? "-"}
• BOS     : ${smc.bos ?? "NONE"}
• CHoCH   : ${smc.choch ?? "NONE"}
• Swing H : ${smc.swing_high ?? "-"}
• Swing L : ${smc.swing_low ?? "-"}

═══════════════════════════════════
YOUR TASK
═══════════════════════════════════

Examine the provided chart carefully. Pay attention to:

1. **Visual price action** — candle shapes, momentum, rejection/acceptance
2. **Position relative to EMAs** — does price respect or ignore EMAs?
3. **Visual market structure** — is bullish/bearish/ranging clearly visible?
4. **Entry zone quality** — is the entry price at a logically sound area visually?
5. **Visual Support & Resistance & Swing High/Low** — Find nearest key Support/Resistance and Swing High/Low visually from the Y-axis.
6. **SL & TP Optimization** — Calculate technically sound SL and TP based on visual S/R and Swing High/Low.
7. **Confirmation or contradiction** — does the visual chart SUPPORT or CONTRADICT the system signal?

Provide analysis in English in JSON format (ONLY JSON, without markdown blocks or outside text):

{
  "verdict": "VALID" | "SKIP" | "WAIT_FOR_PULLBACK",
  "confidence_vision": <number 0-100>,
  "reasoning": "<2-3 sentence main reasoning for your decision in English>",
  "key_observations": [
    "<important visual observation 1 in English>",
    "<important visual observation 2 in English>",
    "<important visual observation 3 in English>"
  ],
  "risk_notes": [
    "<visual risk note 1 in English>",
    "<visual risk note 2 in English>"
  ],
  "price_action_quality": "STRONG" | "MODERATE" | "WEAK",
  "entry_timing": "IDEAL" | "ACCEPTABLE" | "PREMATURE" | "LATE",
  "visual_trend": "BULLISH" | "BEARISH" | "RANGING",
  "visual_support_level": <nearest visual support from Y-axis, max 2 decimals>,
  "visual_resistance_level": <nearest visual resistance from Y-axis, max 2 decimals>,
  "suggested_sl": <new technically logical SL based on visual S/R>,
  "suggested_tp1": <new technically logical TP1>,
  "suggested_tp2": <new technically logical TP2>,
  "suggested_tp3": <new technically logical TP3>
}

Verdict explanations:
- VALID: Chart supports signal, entry makes sense, execution recommended
- WAIT_FOR_PULLBACK: Direction is correct but entry is too aggressive, wait for pullback to a better zone
- SKIP: Chart does not support signal, too many visual risks`;

  const aiClient = getAIClient();

  try {
    const imagePart = {
      inlineData: {
        mimeType: "image/png",
        data: chartB64,
      },
    };
    const textPart = {
      text: prompt,
    };

    const response: GenerateContentResponse = await aiClient.models.generateContent({
      model: "gemini-3.5-flash",
      contents: { parts: [imagePart, textPart] },
      config: {
        responseMimeType: "application/json",
      },
    });

    let raw = response.text || "";
    raw = raw.trim();

    // Clean up any potential markdown formatting in case it still exists
    if (raw.startsWith("```")) {
      raw = raw.split("```")[1];
      if (raw.startsWith("json")) {
        raw = raw.slice(4);
      }
      raw = raw.trim();
    }

    const result: VisionResult = JSON.parse(raw);

    // Calculate combined confidence (60% vision + 40% system)
    const visionConf = Number(result.confidence_vision) || 50;
    const combined = Math.round(visionConf * 0.6 + confidence * 0.4);

    // Determine final signal based on verdict
    let finalSignal = "WAIT";
    if (result.verdict === "VALID") {
      finalSignal = signal;
    } else if (result.verdict === "WAIT_FOR_PULLBACK") {
      finalSignal = "WAIT";
    } else {
      finalSignal = "WAIT";
    }

    result.final_signal = finalSignal;
    result.combined_confidence = combined;
    result.original_signal = signal;
    result.system_confidence = confidence;

    return result;
  } catch (err) {
    console.error("[Vision API] Gemini error during confirmation:", err);
    // Fallback in case of API failure, preserving original system signal but cautioning
    return {
      verdict: "SKIP",
      confidence_vision: 0,
      reasoning: "Failed to process image via AI Vision: " + (err instanceof Error ? err.message : String(err)),
      key_observations: ["Gemini API connection issue"],
      risk_notes: ["Visual verification unavailable"],
      price_action_quality: "WEAK",
      entry_timing: "LATE",
      visual_trend: "RANGING",
      final_signal: "WAIT", // Be safe on API errors
      combined_confidence: confidence,
      original_signal: signal,
      system_confidence: confidence,
    };
  }
}

/**
 * Formats a Telegram message incorporating visual analysis details.
 */
export function formatTelegramVisionSignal(
  visionResult: VisionResult,
  price: number,
  timeframe: string,
  entry: number,
  stopLoss: number,
  tp1: number,
  tp2: number,
  tp3: number,
  rrRatio: string,
  signalId?: number,
  recommendedLot?: number | string,
  martingaleMult: number = 1
): string {
  // STRICT GUARD: Telegram signal MUST NOT be sent without a confirmed signalId from DB
  if (!signalId || isNaN(signalId) || signalId <= 0) {
    console.warn("[Telegram] Cannot format signal message without a valid confirmed signalId from DB");
    return "";
  }

  const signal = visionResult.original_signal || "BUY";
  const verdict = visionResult.verdict || "VALID";
  const combined = visionResult.combined_confidence ?? 0;
  const paQual = visionResult.price_action_quality || "-";
  const timing = visionResult.entry_timing || "-";
  const reasoning = visionResult.reasoning || "";
  const obs = visionResult.key_observations || [];
  const risks = visionResult.risk_notes || [];

  const sigEmoji = signal === "BUY" ? "🟢" : "🔴";
  const verdictEmoji = verdict === "VALID" ? "✅" : verdict === "WAIT_FOR_PULLBACK" ? "⏳" : "⛔";

  const obsText = obs.slice(0, 3).map((o) => `  • ${o}`).join("\n");
  const riskText = risks.slice(0, 2).map((r) => `  ⚠ ${r}`).join("\n");

  const hasRefined = visionResult.suggested_sl && visionResult.suggested_sl > 0;
  const slStr = hasRefined ? `<b>${visionResult.suggested_sl}</b> (Refined 👁)` : `${stopLoss}`;
  const tp1Str = hasRefined ? `<b>${visionResult.suggested_tp1}</b> (Refined 👁)` : `${tp1}`;
  const tp2Str = hasRefined ? `<b>${visionResult.suggested_tp2}</b> (Refined 👁)` : `${tp2}`;
  const tp3Str = hasRefined ? `<b>${visionResult.suggested_tp3}</b> (Refined 👁)` : `${tp3}`;

  const lotDisplay = recommendedLot ? `${recommendedLot} Lot` : "0.10 Lot";
  const martDisplay = martingaleMult > 1 
    ? `🔥 <b>Martingale ${martingaleMult}x Active</b> (Recovery Step)` 
    : `🛡 <b>Normal Risk 1x</b> (Standard)`;

  let msg = `<b>⚡️ GOLDEX AI SIGNAL | ID #${signalId}</b>
🆔 <b>Signal ID: #${signalId}</b>
${sigEmoji} <b>XAU/USD ${signal}</b> — ${timeframe.toUpperCase()}
${verdictEmoji} Vision: <b>${verdict.replace(/_/g, " ")}</b>
━━━━━━━━━━━━━━━━━━
💰 Price   : <b>$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
🎯 Entry   : ${entry}
🛑 SL      : ${slStr}
✅ TP1     : ${tp1Str}
✅ TP2     : ${tp2Str}
✅ TP3     : ${tp3Str}
📊 RR      : ${rrRatio}
📦 Lot Rec : <b>${lotDisplay}</b>
🎲 Mode    : ${martDisplay}
🔥 Conf    : ${combined}% (Vision+AI)
━━━━━━━━━━━━━━━━━━`;

  if (visionResult.visual_support_level || visionResult.visual_resistance_level) {
    msg += `\n👁 <b>Visual Levels Detected:</b>`;
    if (visionResult.visual_support_level) msg += `\n  • Support   : $${visionResult.visual_support_level}`;
    if (visionResult.visual_resistance_level) msg += `\n  • Resistance: $${visionResult.visual_resistance_level}`;
    msg += `\n━━━━━━━━━━━━━━━━━━`;
  }

  msg += `\n👁 <b>Visual Analysis:</b>
${reasoning}
`;

  if (obsText) {
    msg += `\n📌 <b>Observations:</b>\n${obsText}\n`;
  }

  if (riskText) {
    msg += `\n${riskText}\n`;
  }

  msg += `━━━━━━━━━━━━━━━━━━
📈 PA: ${paQual}  |  ⏰ Timing: ${timing}
🕐 ${nowWibStr()}`;

  return msg;
}
