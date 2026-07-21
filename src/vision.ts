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
  const prompt = `Kamu adalah senior trader XAU/USD dengan keahlian SMC (Smart Money Concepts) dan price action.

Aku akan kirimkan chart XAU/USD timeframe ${timeframe.toUpperCase()} beserta data analisis dari sistem trading.

═══════════════════════════════════
DATA SISTEM (dari kalkulasi teknikal)
═══════════════════════════════════

Signal   : ${signal}
Timeframe: ${timeframe.toUpperCase()}
Harga    : $${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
Confidence: ${confidence}%

ENTRY PLAN:
• Entry   : ${entry}
• SL      : ${stopLoss}  
• TP1     : ${tp1}
• TP2     : ${tp2}
• TP3     : ${tp3}

INDIKATOR:
• EMA 21  : ${indicators.ema_21 ?? "-"} ${price > parseFloat(indicators.ema_21 ?? price) ? "(price di atas = bullish)" : "(price di bawah = bearish)"}
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
TUGASMU
═══════════════════════════════════

Lihat chart yang aku kirim dengan seksama. Perhatikan:

1. **Price action visual** — bentuk candle, momentum, apakah ada rejection/acceptance
2. **Posisi terhadap EMA** — apakah harga respek EMA atau ignore?
3. **Struktur market visual** — apakah terlihat jelas bullish/bearish/ranging dari chart?
4. **Kualitas entry zone** — apakah entry price berada di area yang logis secara visual?
5. **Support & Resistance Visual & Swing High/Low** — Temukan level Support/Resistance utama terdekat dan Swing High/Low secara visual dari sumbu Y grafik.
6. **Optimasi SL & TP** — Hitung SL dan TP yang jauh lebih logis secara teknikal berdasarkan level S/R dan Swing High/Low visual tersebut (misal SL ditaruh sedikit di bawah support untuk BUY, atau di atas resistance untuk SELL).
7. **Konfirmasi atau kontradiksi** — apakah visual chart MENDUKUNG atau BERTENTANGAN dengan signal sistem?

Berikan analisis dalam format JSON (HANYA JSON, tanpa teks markdown atau pembungkus lain diluar JSON):

{
  "verdict": "VALID" | "SKIP" | "WAIT_FOR_PULLBACK",
  "confidence_vision": <angka 0-100>,
  "reasoning": "<2-3 kalimat alasan utama keputusanmu berdasarkan visual chart>",
  "key_observations": [
    "<observasi visual penting 1>",
    "<observasi visual penting 2>",
    "<observasi visual penting 3>"
  ],
  "risk_notes": [
    "<risiko visual yang terlihat 1>",
    "<risiko visual yang terlihat 2>"
  ],
  "price_action_quality": "STRONG" | "MODERATE" | "WEAK",
  "entry_timing": "IDEAL" | "ACCEPTABLE" | "PREMATURE" | "LATE",
  "visual_trend": "BULLISH" | "BEARISH" | "RANGING",
  "visual_support_level": <angka support visual terdekat dari sumbu Y chart, desimal maks 2 angka belakang koma>,
  "visual_resistance_level": <angka resistance visual terdekat dari sumbu Y chart, desimal maks 2 angka belakang koma>,
  "suggested_sl": <angka SL baru yang jauh lebih logis secara teknikal berdasarkan level visual S/R>,
  "suggested_tp1": <angka TP1 baru yang jauh lebih logis secara teknikal>,
  "suggested_tp2": <angka TP2 baru yang jauh lebih logis secara teknikal>,
  "suggested_tp3": <angka TP3 baru yang jauh lebih logis secara teknikal>
}

Penjelasan verdict:
- VALID: Chart mendukung signal, entry masuk akal, eksekusi bisa dilakukan
- WAIT_FOR_PULLBACK: Arah benar tapi entry terlalu agresif, tunggu pullback ke zona lebih baik
- SKIP: Chart tidak mendukung signal, terlalu banyak risiko visual`;

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
      reasoning: "Gagal memproses gambar melalui AI Vision: " + (err instanceof Error ? err.message : String(err)),
      key_observations: ["Koneksi Gemini API bermasalah"],
      risk_notes: ["Verifikasi visual tidak tersedia"],
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
  signalId?: number
): string {
  const signal = visionResult.original_signal || "WAIT";
  const verdict = visionResult.verdict || "SKIP";
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

  let msg = `${signalId ? `⚡️ <b>ID Signal: #${signalId}</b>\n` : ""}${sigEmoji} <b>XAU/USD ${signal}</b> — ${timeframe.toUpperCase()}
${verdictEmoji} Vision: <b>${verdict.replace(/_/g, " ")}</b>
━━━━━━━━━━━━━━━━━━
💰 Harga   : <b>$${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
🎯 Entry   : ${entry}
🛑 SL      : ${slStr}
✅ TP1     : ${tp1Str}
✅ TP2     : ${tp2Str}
✅ TP3     : ${tp3Str}
📊 RR      : ${rrRatio}
🔥 Conf    : ${combined}% (Vision+AI)
━━━━━━━━━━━━━━━━━━`;

  if (visionResult.visual_support_level || visionResult.visual_resistance_level) {
    msg += `\n👁 <b>Visual Levels Detected:</b>`;
    if (visionResult.visual_support_level) msg += `\n  • Support   : $${visionResult.visual_support_level}`;
    if (visionResult.visual_resistance_level) msg += `\n  • Resistance: $${visionResult.visual_resistance_level}`;
    msg += `\n━━━━━━━━━━━━━━━━━━`;
  }

  msg += `\n👁 <b>Analisis Visual:</b>
${reasoning}
`;

  if (obsText) {
    msg += `\n📌 <b>Observasi:</b>\n${obsText}\n`;
  }

  if (riskText) {
    msg += `\n${riskText}\n`;
  }

  msg += `━━━━━━━━━━━━━━━━━━
📈 PA: ${paQual}  |  ⏰ Timing: ${timing}
🕐 ${nowWibStr()}`;

  return msg;
}
