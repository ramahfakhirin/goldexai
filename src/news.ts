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
  const prompt = `You are a real-time economic calendar monitoring system for a gold trading bot.
Perform a Google Search (search grounding) for today's economic calendar (specifically USD and Gold/XAU) from reliable sources like Forex Factory, Investing.com, or DailyFX.

Current time is: ${currentWib} (WIB / Western Indonesian Time, UTC+7).

Your task is to check if there are HIGH-IMPACT economic news releases (such as NFP - Non-Farm Payrolls, CPI - Consumer Price Index, FOMC/Fed Rate Decision, GDP, or Unemployment Claims) scheduled within 15 minutes before or 15 minutes after the current time.

Format response as JSON only (ONLY JSON, do not wrap in markdown \`\`\`json or \`\`\`, no opening or closing text):
{
  "should_pause": true or false,
  "reason": "Reason in English if should_pause is true (news name and release time), empty or '-' if false",
  "upcoming_events": [
    {
      "event": "Economic news name",
      "impact": "High" or "Medium",
      "time": "Release time"
    }
  ]
}

Decision rules:
- should_pause is set to true IF a High-Impact USD release occurs within [Current Time - 15 Mins] to [Current Time + 15 Mins].
- Response MUST be raw pure JSON without markdown code blocks.`;

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
      reason: "Failed to monitor news: " + (err instanceof Error ? err.message : String(err)),
      upcoming_events: [],
    };
  }
}
