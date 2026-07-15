import dotenv from "dotenv";
dotenv.config();

const WIB_OFFSET = 7 * 3600 * 1000;

export function getWIBDate(dateInput: string | Date = new Date()): Date {
  const d = typeof dateInput === "string" ? new Date(dateInput) : dateInput;
  return new Date(d.getTime() + WIB_OFFSET);
}

export function nowWibStr(formatPattern: string = "YYYY-MM-DD HH:mm:ss"): string {
  const d = new Date();
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const wib = new Date(utc + WIB_OFFSET);

  const y = wib.getFullYear();
  const m = String(wib.getMonth() + 1).padStart(2, "0");
  const day = String(wib.getDate()).padStart(2, "0");
  const h = String(wib.getHours()).padStart(2, "0");
  const min = String(wib.getMinutes()).padStart(2, "0");
  const s = String(wib.getSeconds()).padStart(2, "0");

  if (formatPattern === "%H:%M WIB") {
    return `${h}:${min} WIB`;
  }
  if (formatPattern === "%Y-%m-%d %H:%M:%S") {
    return `${y}-${m}-${day} ${h}:${min}:${s}`;
  }
  return `${day}/${m}/${y} ${h}:${min} WIB`;
}

// Memory caches
const bridgePriceCache = { price: 0, fetched_at: 0 };
const bridgeOhlcvCache: Record<string, { data: any[]; fetched_at: number }> = {};
const twelvePriceCache = { price: 0, fetched_at: 0 };
const twelveOhlcvCache: Record<string, { data: any[]; fetched_at: number }> = {};

export async function fetchPriceFromBridge(): Promise<number> {
  const now = Date.now();
  if (now - bridgePriceCache.fetched_at < 3000 && bridgePriceCache.price > 0) {
    return bridgePriceCache.price;
  }

  const url = process.env.MT5_BRIDGE_URL;
  const token = process.env.MT5_BRIDGE_TOKEN || "";
  if (!url) return 0;

  try {
    const cleanUrl = url.replace(/\/$/, "") + "/price";
    const res = await fetch(cleanUrl, {
      headers: {
        "X-Bridge-Token": token,
        "User-Agent": "XAUDashboard/2.0",
      },
      signal: AbortSignal.timeout(5000),
    });
    const data: any = await res.json();
    if (data && data.ok) {
      const price = parseFloat(data.price);
      bridgePriceCache.price = price;
      bridgePriceCache.fetched_at = now;
      return price;
    }
  } catch (e) {
    console.error("[Bridge] Price fetch error:", e);
  }
  return 0;
}

export async function fetchOhlcvFromBridge(timeframe: string = "5m", count: number = 200): Promise<any[] | null> {
  const now = Date.now();
  const cached = bridgeOhlcvCache[timeframe];
  if (cached && now - cached.fetched_at < 10000) {
    return cached.data;
  }

  const url = process.env.MT5_BRIDGE_URL;
  const token = process.env.MT5_BRIDGE_TOKEN || "";
  if (!url) return null;

  try {
    const cleanUrl = `${url.replace(/\/$/, "")}/ohlcv?timeframe=${timeframe}&count=${count}`;
    const res = await fetch(cleanUrl, {
      headers: {
        "X-Bridge-Token": token,
        "User-Agent": "XAUDashboard/2.0",
      },
      signal: AbortSignal.timeout(20000),
    });
    const data: any = await res.json();
    if (data && data.ok && Array.isArray(data.data)) {
      bridgeOhlcvCache[timeframe] = { data: data.data, fetched_at: now };
      return data.data;
    }
  } catch (e) {
    console.error("[Bridge] OHLCV fetch error:", e);
  }
  return null;
}

export async function fetchPriceFromTwelveData(): Promise<number> {
  const now = Date.now();
  if (now - twelvePriceCache.fetched_at < 10000 && twelvePriceCache.price > 0) {
    return twelvePriceCache.price;
  }

  const apiKey = process.env.TWELVE_DATA_KEY;
  if (!apiKey) return 0;

  try {
    const res = await fetch(`https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${apiKey}`, {
      signal: AbortSignal.timeout(10000),
    });
    const data: any = await res.json();
    const price = parseFloat(data.price);
    if (price > 0) {
      twelvePriceCache.price = price;
      twelvePriceCache.fetched_at = now;
      return price;
    }
  } catch (e) {
    console.error("[TwelveData] Price fetch error:", e);
  }
  return 0;
}

export async function fetchOhlcvFromTwelveData(timeframe: string = "5m", count: number = 200): Promise<any[] | null> {
  const now = Date.now();
  const cached = twelveOhlcvCache[timeframe];
  if (cached && now - cached.fetched_at < 60000) {
    return cached.data;
  }

  const apiKey = process.env.TWELVE_DATA_KEY;
  if (!apiKey) return null;

  const tfMap: Record<string, string> = {
    "1m": "1min",
    "5m": "5min",
    "15m": "15min",
    "1h": "1h",
    "4h": "4h",
    "1d": "1day",
  };
  const interval = tfMap[timeframe] || "5min";

  try {
    const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${interval}&outputsize=${Math.min(count, 5000)}&apikey=${apiKey}&order=ASC`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const data: any = await res.json();
    if (data && data.values && Array.isArray(data.values)) {
      const parsed = data.values.map((v: any) => ({
        open: parseFloat(v.open),
        high: parseFloat(v.high),
        low: parseFloat(v.low),
        close: parseFloat(v.close),
        volume: parseFloat(v.volume || 0),
        time: v.datetime,
      }));
      twelveOhlcvCache[timeframe] = { data: parsed, fetched_at: now };
      return parsed;
    } else {
      console.error("[TwelveData] OHLCV response error:", data.message || "unknown");
    }
  } catch (e) {
    console.error("[TwelveData] OHLCV fetch error:", e);
  }
  return null;
}

export async function fetchCurrentPriceServer(): Promise<number> {
  const bridgePrice = await fetchPriceFromBridge();
  if (bridgePrice > 0) return bridgePrice;

  const twelvePrice = await fetchPriceFromTwelveData();
  return twelvePrice;
}

export async function fetchOhlcvPrimary(timeframe: string = "5m", count: number = 200): Promise<{ data: any[] | null; source: string }> {
  const bridgeData = await fetchOhlcvFromBridge(timeframe, count);
  if (bridgeData && bridgeData.length > 0) {
    return { data: bridgeData, source: "MT5 Bridge (Broker Live)" };
  }

  const twelveData = await fetchOhlcvFromTwelveData(timeframe, count);
  if (twelveData && twelveData.length > 0) {
    return { data: twelveData, source: "Twelve Data (Fallback)" };
  }

  return { data: null, source: "Tidak tersedia" };
}

// RSS News sentiment scraper
export async function fetchGoldNewsSentiment(): Promise<any> {
  const now = new Date();
  const headlines: any[] = [];
  const errors: string[] = [];

  const feeds = [
    { name: "MarketWatch", url: "https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines" },
    { name: "MarketWatch Top Stories", url: "https://feeds.marketwatch.com/marketwatch/topstories/" },
  ];

  const goldKeywords = ["gold", "xau", "bullion", "precious metal", "fed", "federal reserve", "interest rate", "inflation", "dollar", "treasury", "yield", "powell", "rate cut", "rate hike", "cpi", "jobs report", "nfp"];
  const bullWords = ["rise", "rises", "rising", "gain", "gains", "rally", "surge", "jump", "climb", "bullish", "higher", "soar", "advance", "strengthen", "safe haven", "demand", "record high", "boost", "support"];
  const bearWords = ["fall", "falls", "falling", "drop", "drops", "decline", "slide", "tumble", "plunge", "bearish", "lower", "weaken", "sell-off", "selloff", "pressure", "hawkish", "outflow", "retreat", "slump"];

  for (const feed of feeds) {
    try {
      const res = await fetch(feed.url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(10000),
      });
      const xml = await res.text();

      // Parse with lightweight manual regex to be super-fast and stable without dependencies
      const items = xml.split("<item>");
      items.shift(); // remove first part before <item>

      for (const item of items) {
        const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
        const pubDateMatch = item.match(/<pubDate>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/pubDate>/i);

        if (!titleMatch) continue;
        const title = titleMatch[1].trim();
        const titleLower = title.toLowerCase();

        if (!goldKeywords.some((kw) => titleLower.includes(kw))) continue;

        let pubTime = "";
        if (pubDateMatch) {
          try {
            const pubDate = new Date(pubDateMatch[1].trim());
            const ageHours = (now.getTime() - pubDate.getTime()) / 3600000;
            if (ageHours < 0 || ageHours > 48) continue; // max 48 hours

            const pubWib = getWIBDate(pubDate);
            pubTime = `${String(pubWib.getDate()).padStart(2, "0")}/${String(pubWib.getMonth() + 1).padStart(2, "0")} ${String(pubWib.getHours()).padStart(2, "0")}:${String(pubWib.getMinutes()).padStart(2, "0")} WIB`;
          } catch {
            continue;
          }
        }

        const score = bullWords.filter((w) => titleLower.includes(w)).length - bearWords.filter((w) => titleLower.includes(w)).length;
        const sentiment = score > 0 ? "BULLISH" : score < 0 ? "BEARISH" : "NEUTRAL";

        headlines.push({
          title,
          sentiment,
          source: feed.name,
          time: pubTime || nowWibStr(),
          score,
        });
      }
    } catch (e: any) {
      errors.push(`${feed.name}: ${e.message}`);
    }
  }

  if (headlines.length === 0) {
    return {
      overall_sentiment: "NEUTRAL",
      sentiment_score: 0,
      summary: "Tidak ada berita gold/Fed/dolar dalam 48 jam terakhir.",
      key_factors: [],
      headlines: [],
      watch_out: "Tidak ada berita signifikan terkini.",
      updated: nowWibStr("%H:%M WIB"),
      source: "MarketWatch RSS (Railway direct)",
      errors,
    };
  }

  // Deduplicate
  const seen = new Set();
  const deduped: any[] = [];
  for (const h of headlines) {
    const key = h.title.slice(0, 60).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(h);
    }
  }

  const finalHeadlines = deduped.sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 10);
  const totalScore = finalHeadlines.reduce((sum, h) => sum + h.score, 0);
  const normScore = Math.max(-100, Math.min(100, Math.round((totalScore / finalHeadlines.length) * 20)));
  const overall = totalScore > 0 ? "BULLISH" : totalScore < 0 ? "BEARISH" : "NEUTRAL";

  return {
    overall_sentiment: overall,
    sentiment_score: normScore,
    summary: `Dari ${finalHeadlines.length} berita terkini terkait emas/Fed/dolar, sentimen keseluruhan cenderung ${overall.toLowerCase()}.`,
    key_factors: [],
    headlines: finalHeadlines,
    watch_out: finalHeadlines[0]?.title || "Pantau rilis data ekonomi AS.",
    updated: nowWibStr("%H:%M WIB"),
    source: "MarketWatch RSS (Railway direct)",
    errors,
  };
}

// Economic calendar FF
export async function fetchForexCalendar(): Promise<any[]> {
  try {
    const res = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10000),
    });
    const events: any = await res.json();
    if (!Array.isArray(events)) return [];

    const now = new Date();
    const result: any[] = [];

    for (const ev of events) {
      const country = (ev.country || ev.currency || "").toUpperCase();
      const impact = (ev.impact || "").trim();

      if (country !== "USD") continue;
      if (impact !== "High" && impact !== "Medium") continue;

      try {
        const evDt = new Date(ev.date);
        const diffHours = (evDt.getTime() - now.getTime()) / 3600000;
        if (diffHours < -24) continue; // older than 24h

        const wib = getWIBDate(evDt);
        const wibDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const dayStr = wibDays[wib.getDay()];
        const timeWib = `${dayStr} ${String(wib.getDate()).padStart(2, "0")}/${String(wib.getMonth() + 1).padStart(2, "0")} ${String(wib.getHours()).padStart(2, "0")}:${String(wib.getMinutes()).padStart(2, "0")} WIB`;

        result.push({
          title: ev.title,
          currency: country,
          impact,
          time_wib: timeWib,
          diff_hours: Math.round(diffHours * 10) / 10,
          forecast: ev.forecast || "-",
          previous: ev.previous || "-",
          actual: ev.actual || "",
          past: diffHours < 0,
        });
      } catch (e) {
        console.error("FF Date parse error:", e);
      }
    }

    return result.sort((a, b) => a.diff_hours - b.diff_hours).slice(0, 30);
  } catch (e) {
    console.error("[FF Calendar] fetch error:", e);
    return [];
  }
}

// Telegram messaging
export async function sendTelegramMessage(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;

  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        text: text,
        parse_mode: "HTML",
      }),
      signal: AbortSignal.timeout(10000),
    });
    const data: any = await res.json();
    return data && data.ok;
  } catch (e) {
    console.error("[Telegram] Error sending message:", e);
    return false;
  }
}

/**
 * Checks if the gold/forex market is open.
 * Closed: Saturday 05:00 WIB to Monday 06:00 WIB.
 */
export function isMarketOpen(): boolean {
  const now = getWIBDate(new Date());
  const wd = now.getDay(); // 0 = Sunday, 1 = Monday, ... 6 = Saturday
  const hr = now.getHours();

  if (wd === 6) { // Saturday
    return hr < 5;
  }
  if (wd === 0) { // Sunday
    return false;
  }
  if (wd === 1) { // Monday
    return hr >= 6;
  }
  return true; // Tuesday to Friday
}

/**
 * Returns explanation text if market is closed.
 */
export function marketClosedReason(): string {
  const now = getWIBDate(new Date());
  const wd = now.getDay();
  const hr = now.getHours();

  if (wd === 6 || wd === 0 || (wd === 1 && hr < 6)) {
    return "Market gold/forex tutup — buka kembali Senin 06:00 WIB";
  }
  return "";
}

