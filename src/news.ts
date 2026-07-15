import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { nowWibStr } from "./api.js";

dotenv.config();

let aiInstance: GoogleGenAI | null = null;

function getAIClient(): GoogleGenAI {
  if (!aiInstance) {
    const key = process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error("GEMINI_API_KEY environment variable is required for Economic News Grounding. Please configure it.");
    }
    if (key.startsWith("sk-ant-")) {
      throw new Error("API key invalid: The configured key is an Anthropic key, which is unsupported by the Google Gemini SDK. Please configure a valid Google Gemini API Key.");
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

export interface NewsSuspensionResult {
  should_pause: boolean;
  reason: string;
  upcoming_events: Array<{
    event: string;
    impact: string;
    time: string;
  }>;
}

/**
 * Checks for upcoming/recent high impact USD economic news events using Gemini Search Grounding.
 * Automatically halts signal scanning if a major release is scheduled within 15 minutes before or after the current time.
 */
export async function checkEconomicNewsSuspension(): Promise<NewsSuspensionResult> {
  const currentWib = nowWibStr();
  const prompt = `Kamu adalah sistem pemantau kalender ekonomi real-time untuk bot trading gold.
Lakukan pencarian Google (search grounding) untuk kalender ekonomi hari ini (terutama USD dan Emas/XAU) dari sumber terpercaya seperti Forex Factory, Investing.com, atau DailyFX.

Waktu saat ini adalah: ${currentWib} (WIB / Western Indonesian Time, UTC+7).

Tugasmu adalah memeriksa apakah ada rilis berita ekonomi HIGH-IMPACT (seperti NFP - Non-Farm Payrolls, CPI - Consumer Price Index, Keputusan Suku Bunga FOMC/Fed, PDB/GDP, atau Unemployment Claims) yang dijadwalkan dalam waktu 15 menit sebelum atau 15 menit sesudah waktu sekarang.

Format balasan dalam bentuk JSON saja (HANYA JSON, jangan dibungkus markdown \`\`\`json atau \`\`\`, tanpa teks pembuka atau penutup):
{
  "should_pause": true atau false,
  "reason": "Alasan jika should_pause adalah true (nama berita dan jam rilisnya dalam format WIB), kosongkan atau beri '-' jika false",
  "upcoming_events": [
    {
      "event": "Nama berita ekonomi",
      "impact": "High" atau "Medium",
      "time": "Jam rilis dalam format WIB"
    }
  ]
}

Aturan keputusan:
- should_pause diatur ke true JIKA rilis berita berdampak tinggi (High Impact) USD terjadi dalam rentang [Waktu Sekarang - 15 Menit] hingga [Waktu Sekarang + 15 Menit].
- Balasan HARUS berupa raw JSON murni tanpa pembungkus markdown markdown \`\`\`json atau \`\`\`.`;

  try {
    const aiClient = getAIClient();
    const response = await aiClient.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
      },
    });

    let raw = response.text || "";
    raw = raw.trim();

    // Clean markdown code blocks if the model ignores responseMimeType instructions
    if (raw.startsWith("```")) {
      raw = raw.split("```")[1];
      if (raw.startsWith("json")) {
        raw = raw.slice(4);
      }
      raw = raw.trim();
    }

    const result: NewsSuspensionResult = JSON.parse(raw);
    console.log(`[News Grounding] Verified suspension status: should_pause=${result.should_pause}, reason=${result.reason}`);
    return result;
  } catch (err) {
    console.error("[News Grounding] Error checking economic calendar via Search Grounding:", err);
    // Fallback on API error to not interrupt general operations but log warning
    return {
      should_pause: false,
      reason: "Gagal memantau berita: " + (err instanceof Error ? err.message : String(err)),
      upcoming_events: [],
    };
  }
}
