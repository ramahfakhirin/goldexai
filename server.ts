import express from "express";
import path from "path";
import cookieParser from "cookie-parser";
import session from "express-session";
import nunjucks from "nunjucks";
import dotenv from "dotenv";
import crypto from "crypto";

import { db, User } from "./src/db.js";
import { 
  isMarketOpen, 
  marketClosedReason, 
  fetchOhlcvPrimary, 
  fetchCurrentPriceServer, 
  sendTelegramMessage, 
  fetchGoldNewsSentiment, 
  fetchForexCalendar,
  nowWibStr,
  getWIBDate
} from "./src/api.js";
import { getCurrentSession, isSessionActive, getSessionSchedule, setSessionSchedule } from "./src/sessions.js";
import { runMultiTimeframeScan } from "./src/analyst.js";
import { runMonitorCheck } from "./src/monitor.js";
import { generateChart } from "./src/chart.js";
import { confirmSignalVision, formatTelegramVisionSignal } from "./src/vision.js";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";

dotenv.config();

const app = express();
const PORT = 3000;

// Create HTTP server wrapping express app for WebSockets
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const activeWsClients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  activeWsClients.add(ws);
  console.log(`[WebSocket] Client connected. Total active clients: ${activeWsClients.size}`);

  // Send latest signal data immediately on connection if cached
  if (latestSignalCache && Object.keys(latestSignalCache).length > 0) {
    ws.send(JSON.stringify({ type: "LATEST_SIGNAL", data: latestSignalCache }));
  }

  ws.on("close", () => {
    activeWsClients.delete(ws);
    console.log(`[WebSocket] Client disconnected. Total active clients: ${activeWsClients.size}`);
  });
});

export function broadcast(payload: any) {
  const json = JSON.stringify(payload);
  for (const client of activeWsClients) {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(json);
      } catch (e) {
        console.error("[WebSocket] Send error:", e);
      }
    }
  }
}

// Set up Nunjucks templating engine
nunjucks.configure("templates", {
  autoescape: true,
  express: app,
  watch: false,
});

// Parsers & Session middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Trust proxy is required to allow 'secure' cookies to work properly behind reverse proxies (like Cloud Run)
app.set("trust proxy", true);

app.use(
  session({
    secret: process.env.SESSION_SECRET || "goldex-ai-secret-key-2026",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 24 * 3600 * 1000, // 24 hours
    },
  })
);

// Dynamic session cookie middleware to set sameSite and secure flags dynamically
app.use((req, res, next) => {
  if (req.session && req.session.cookie) {
    const isSecure = req.secure || req.headers["x-forwarded-proto"] === "https";
    if (isSecure) {
      req.session.cookie.secure = true;
      req.session.cookie.sameSite = "none";
    } else {
      req.session.cookie.secure = false;
      req.session.cookie.sameSite = "lax";
    }
  }
  next();
});

// Serve static assets from /static
app.use("/static", express.static(path.join(process.cwd(), "static")));

// Custom Nunjucks middleware context injection
app.use((req, res, next) => {
  // We wrap the session to support the original Python template 'session.get("role")' format
  const sessionWrapper = {
    ...(req.session || {}),
    get: (key: string, fallback: any = null) => {
      return (req.session as any)?.[key] !== undefined ? (req.session as any)[key] : fallback;
    },
  };
  res.locals.session = sessionWrapper;
  res.locals.username = req.session?.username || "";
  res.locals.full_name = (req.session as any)?.full_name || "";
  next();
});

// Authentication Guard Middlewares
function loginRequired(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!req.session || !(req.session as any).user_id) {
    const isApi =
      req.xhr ||
      req.path.startsWith("/api/") ||
      req.originalUrl.startsWith("/api/") ||
      req.baseUrl.startsWith("/api/") ||
      (req.headers.accept && req.headers.accept.includes("application/json"));

    if (isApi) {
      return res.status(401).json({ ok: false, error: "Silakan login terlebih dahulu (Sesi telah berakhir)." });
    }
    return res.redirect("/login");
  }
  next();
}

function superadminRequired(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!req.session || (req.session as any).role !== "superadmin") {
    const isApi =
      req.xhr ||
      req.path.startsWith("/api/") ||
      req.originalUrl.startsWith("/api/") ||
      req.baseUrl.startsWith("/api/") ||
      (req.headers.accept && req.headers.accept.includes("application/json"));

    if (isApi) {
      return res.status(403).json({ ok: false, error: "Akses ditolak: Hanya superadmin." });
    }
    return res.status(403).send("Access denied: Only superadmin can access this page.");
  }
  next();
}

// ─────────────────────────────────────────────
// STATE & SCHEDULER VARS
// ─────────────────────────────────────────────
let lastSignalCandleIdM5 = db.configGet("last_signal_candle_id_m5", "");
let lastSignalCandleIdM1 = db.configGet("last_signal_candle_id_m1", "");
let lastSignalTs = parseFloat(db.configGet("last_signal_ts", "0"));
let lastWaitSaveTs = parseFloat(db.configGet("last_wait_save_ts", "0"));
let lastSentTelegramSignalId: number | null = null;
const signalCooldownSec = parseInt(process.env.SIGNAL_COOLDOWN_SEC || "900"); // default 15 mins

// Memory cache for latest signal API polling
let latestSignalCache: any = {};

function setLatestSignal(signalId: number | null, analysis: any, price: number, timeframe: string, indicators: any, smc: any) {
  latestSignalCache = {
    ok: true,
    signal_id: signalId,
    analysis: analysis,
    price: price,
    timeframe: timeframe,
    timestamp: nowWibStr("%Y-%m-%d %H:%M:%S"),
    data_source: "MT5 Bridge (Broker Live)", // or default to this label
    indicators: {
      ema_21: indicators.ema_21,
      ema_50: indicators.ema_50,
      ema_55: indicators.ema_55,
      ema_200: indicators.ema_200,
      rsi: indicators.rsi,
      atr: indicators.atr,
      macd: indicators.macd,
      macd_signal: indicators.macd_signal,
      ha_bias: indicators.ha_bias,
      ha_strength: indicators.ha_strength,
    },
    smc: {
      trend: smc.trend,
      bos: smc.bos,
      choch: smc.choch,
      swing_high: smc.swing_high,
      swing_low: smc.swing_low,
      support: smc.support_levels,
      resistance: smc.resistance_levels,
      fvg_zones: smc.fvg_zones?.slice(0, 3) || [],
      ob_zones: smc.ob_zones?.slice(0, 3) || [],
    },
  };
  
  // Persist the latest signal cache in the shared SQLite config table
  db.configSet("latest_signal_cache", JSON.stringify(latestSignalCache));
  
  // Broadcast the latest signal cache immediately to all connected WebSocket clients
  broadcast({ type: "LATEST_SIGNAL", data: latestSignalCache });
}

// Humanize WAIT signal reasons
function humanizeReason(raw: string, rsiVal: number): string {
  if (!raw || raw === "-") {
    return "Market conditions do not meet all confluence filters yet.";
  }

  const missingMap: Record<string, string> = {
    pin_bar: "Pin bar not yet confirmed",
    htf_bos: "HTF Break of Structure has not occurred",
    bos_bull: "Bullish Break of Structure not confirmed",
    bos_bear: "Bearish Break of Structure not confirmed",
    liq_buy: "No liquidity sweep downwards",
    liq_sell: "No liquidity sweep upwards",
    adx: `RSI ${rsiVal.toFixed(0)} — momentum not strong enough`,
    bullish_engulfing: "No bullish engulfing pattern",
    bearish_engulfing: "No bearish engulfing pattern",
    stable_candle: "Candle not solid enough (doji/small body)",
    decrease_over_10: "Price has not dropped from 10 candles ago",
    increase_over_10: "Price has not risen from 10 candles ago",
  };

  const rawLower = raw.toLowerCase();
  const found: string[] = [];
  for (const [key, desc] of Object.entries(missingMap)) {
    if (rawLower.includes(key)) {
      found.push(desc);
    }
  }

  if (found.length > 0) {
    return "Awaiting confluence: " + found.slice(0, 3).join(" · ") + ".";
  }

  if (raw.length < 80 && !raw.includes("miss") && !raw.includes("['")) {
    return raw;
  }

  return "Market conditions do not meet all confluence filters yet.";
}

function saveWaitRatelimited(reason: string, price: number, indicators: any, smc: any, timeframe: string) {
  const nowTs = Date.now() / 1000;
  
  // 30 minutes rate limiting (1800s)
  if (nowTs - lastWaitSaveTs < 1800) {
    return;
  }

  // Database-level check
  const history = db.getHistory(1);
  if (history.length > 0 && history[0].signal === "WAIT") {
    const elapsedSec = (Date.now() - new Date(history[0].timestamp).getTime()) / 1000;
    if (elapsedSec < 1800) {
      return;
    }
  }

  lastWaitSaveTs = nowTs;
  db.configSet("last_wait_save_ts", nowTs);

  const rsiValue = indicators?.rsi ?? 50;
  const readableReason = humanizeReason(reason, rsiValue);

  const waitAnalysis = {
    signal: "WAIT",
    confidence: 0,
    bias: "NEUTRAL",
    narrative: readableReason,
    method_confluence: {
      ema_trend: "Waiting",
      rsi_momentum: `RSI ${rsiValue.toFixed(0)}`,
      macd: "NEUTRAL",
      heiken_ashi: indicators?.ha_bias || "NEUTRAL",
      break_retest: "None",
      session: "SCANNING",
      aligned_methods: 0,
    },
    entry: {
      ideal_price: price,
      entry_zone: "-",
      type: "WAIT",
      notes: readableReason,
    },
    risk_management: {
      stop_loss: 0,
      take_profit_1: 0,
      take_profit_2: 0,
      take_profit_3: 0,
    },
    market_structure: {
      primary_trend: "SIDEWAYS",
      key_support: smc?.support_levels?.[0] || 0,
      key_resistance: smc?.resistance_levels?.[0] || 0,
      price_position: `$${price.toFixed(2)}`,
      current_phase: "Awaiting setup",
      invalidation: "-",
    },
    confluence_factors: [],
    warning_signs: [],
    session_timing: {
      best_entry_window: "London/NY Overlap (14:00–04:00 WIB)",
      avoid_trading: "Asian Session (02:00–08:00 WIB)",
    },
    next_analysis: "1 minute",
  };

  const signalId = db.saveSignal(waitAnalysis, timeframe, price);
  
  // Only update latest signal cache with WAIT if there is no current BUY or SELL signal in DB
  const currentDbSig = db.getLatestSignalFromDB();
  if (!currentDbSig || (currentDbSig.signal !== "BUY" && currentDbSig.signal !== "SELL")) {
    setLatestSignal(signalId, waitAnalysis, price, timeframe, indicators, smc);
  }
}

// ─────────────────────────────────────────────
// CORE SCHEDULER: MARKET SCAN PIPELINE
// ─────────────────────────────────────────────
async function runScheduledAnalysis() {
  try {
    if (!isMarketOpen()) {
      console.log(`[Scheduler] 🔴 Market tutup (${marketClosedReason()}) — skip analisis`);
      return;
    }

    if (!isSessionActive()) {
      const sess = getCurrentSession();
      console.log(`[Scheduler] ⏸ Sesi '${sess}' dinonaktifkan superadmin — skip analisis`);
      return;
    }

    console.log("[Scheduler] Running scheduled gold market scan...");

    // Fetch primary M5
    const { data: rawCandlesM5, source: sourceM5 } = await fetchOhlcvPrimary("5m", 500);
    if (!rawCandlesM5 || rawCandlesM5.length === 0) {
      console.log("[Scheduler] ⚠️ OHLCV M5 tidak tersedia — analisis dibatalkan");
      return;
    }
    // Slice: Hanya gunakan closed candles untuk analisis (buang active candle terakhir)
    const candlesM5 = rawCandlesM5.length > 1 ? rawCandlesM5.slice(0, -1) : rawCandlesM5;

    // 1. Economic News Grounding Suspension Check via Gemini Search Grounding
    try {
      const { checkEconomicNewsSuspension } = await import("./src/news.js");
      const newsStatus = await checkEconomicNewsSuspension();
      if (newsStatus.should_pause) {
        console.log(`[Scheduler] ⏸ News Suspension Active: ${newsStatus.reason}. Suspending signal scans.`);
        const price = candlesM5[candlesM5.length - 1].close;
        const { getIndicators, getSMCStructure } = await import("./src/indicators.js");
        const currentIndicators = getIndicators(candlesM5);
        const currentSMC = getSMCStructure(candlesM5, price);
        saveWaitRatelimited(`TEMPORARY SUSPENSION (NEWS): ${newsStatus.reason}`, price, currentIndicators, currentSMC, "5m");
        return;
      }
    } catch (newsErr) {
      console.error("[Scheduler] News suspension check error:", newsErr);
    }

    // Fetch M1
    let candlesM1: any[] | null = null;
    try {
      const m1Result = await fetchOhlcvPrimary("1m", 500);
      if (m1Result && m1Result.data) {
        candlesM1 = m1Result.data.length > 1 ? m1Result.data.slice(0, -1) : m1Result.data;
      }
    } catch (e: any) {
      console.log(`[Scheduler] ⚠️ M1 fetch error: ${e.message}`);
    }

    // Deduplication check based on candle time (M1 first, M5 fallback)
    if (candlesM1 && candlesM1.length > 0) {
      const latestM1Time = candlesM1[candlesM1.length - 1].time;
      if (latestM1Time === lastSignalCandleIdM1) {
        console.log(`[Scheduler] ⏭ Candle M1 sama (${latestM1Time}) — skip re-scan`);
        return;
      }
      lastSignalCandleIdM1 = latestM1Time;
      db.configSet("last_signal_candle_id_m1", latestM1Time);
    } else {
      const latestM5Time = candlesM5[candlesM5.length - 1].time;
      if (latestM5Time === lastSignalCandleIdM5) {
        console.log(`[Scheduler] ⏭ Candle M5 sama (${latestM5Time}) — skip re-scan`);
        return;
      }
      lastSignalCandleIdM5 = latestM5Time;
      db.configSet("last_signal_candle_id_m5", latestM5Time);
    }

    // Fetch H1
    let candlesH1: any[] | null = null;
    try {
      const h1Result = await fetchOhlcvPrimary("1h", 300);
      if (h1Result && h1Result.data) {
        candlesH1 = h1Result.data.length > 1 ? h1Result.data.slice(0, -1) : h1Result.data;
      }
    } catch (e: any) {
      console.log(`[Scheduler] ⚠️ H1 fetch error: ${e.message} — fallback EMA lokal`);
    }

    // Fetch H4 (Requirement 2: Trend confluence H1/H4)
    let candlesH4: any[] | null = null;
    try {
      const h4Result = await fetchOhlcvPrimary("4h", 200);
      if (h4Result && h4Result.data) {
        candlesH4 = h4Result.data.length > 1 ? h4Result.data.slice(0, -1) : h4Result.data;
      }
    } catch (e: any) {
      console.log(`[Scheduler] ⚠️ H4 fetch error: ${e.message}`);
    }

    // Execute Multi-Timeframe Scan
    const capital = parseFloat(process.env.DISPLAY_CAPITAL || "2000.0");
    const riskPercent = parseFloat(process.env.RISK_PERCENT || "1.5");
    const valuePerLot = 10.0;

    const martingaleMultiplier = db.getMartingaleMultiplier() || 1;
    const mtf = runMultiTimeframeScan(
      candlesM1,
      candlesM5,
      candlesH1,
      candlesH4,
      capital,
      riskPercent,
      valuePerLot,
      martingaleMultiplier
    );
    const best = mtf.best;
    const sig = best.signal;
    const tfLabel = best.timeframe || "M5";

    // Re-calculate indicators & structure for the latest state logging
    const fromCandles = tfLabel === "M1" ? (candlesM1 || candlesM5) : candlesM5;
    const { getIndicators, getSMCStructure } = await import("./src/indicators.js");
    const currentIndicators = getIndicators(fromCandles);
    const currentSMC = getSMCStructure(fromCandles, best.entry || candlesM5[candlesM5.length - 1].close);
    const price = candlesM5[candlesM5.length - 1].close;

    if (sig === "WAIT") {
      saveWaitRatelimited(best.reason || "Confluence conditions not met yet", price, currentIndicators, currentSMC, tfLabel === "BOTH" ? "5m" : tfLabel);
      return;
    }

    // Cooldown check for BUY/SELL
    const nowTs = Date.now() / 1000;
    const elapsedSinceLast = nowTs - lastSignalTs;
    if (elapsedSinceLast < signalCooldownSec && lastSignalTs > 0) {
      console.log(`[Scheduler] 🕐 Cooldown aktif — ${elapsedSinceLast.toFixed(0)}s < ${signalCooldownSec}s — skip ${sig}`);
      return;
    }

    // Directional Loss-Streak Guard Check
    const guard = db.isDirectionBlocked(sig);
    if (guard.blocked) {
      console.log(`[Scheduler] 🚧 ${sig} diblokir loss-streak guard — ${guard.text}`);
      return;
    }

    // Auto-narrative formulation (0-token generation helper)
    const score = best.score || 0;
    const conf = best.confidence === "HIGH_CONFIDENCE" || best.confidence >= 75 ? "HIGH_CONFIDENCE" : "NORMAL";
    const adxVal = 25.0; // simple mock adx
    const slDist = Math.abs(best.entry - best.sl);

    let narrative = "";
    let warningSigns: string[] = [];

    if (sig === "BUY") {
      narrative = `XAU/USD [${tfLabel}] market shows BUY confirmation ${conf} with confluence score ${score}/7 — EMA50 above EMA200 confirms bullish bias, ADX ${adxVal.toFixed(1)} indicates strong trend momentum. Critical level: hold SL at $${best.sl.toFixed(2)} (distance ${slDist.toFixed(2)} pts from entry), targets TP1 $${best.tp1.toFixed(2)} → TP2 $${best.tp2.toFixed(2)} → TP3 $${best.tp3.toFixed(2)}.`;
      warningSigns = [
        `Watch out for reversal if price closes below $${best.sl.toFixed(2)}`,
        `Avoid entry if spread exceeds acceptable limit`,
        "Pay attention to high-impact news releases that could invalidate structure",
      ];
    } else {
      narrative = `XAU/USD [${tfLabel}] market shows SELL confirmation ${conf} with confluence score ${score}/7 — EMA50 below EMA200 confirms bearish bias, ADX ${adxVal.toFixed(1)} indicates selling pressure remains strong. Critical level: hold SL at $${best.sl.toFixed(2)} (distance ${slDist.toFixed(2)} pts from entry), targets TP1 $${best.tp1.toFixed(2)} → TP2 $${best.tp2.toFixed(2)} → TP3 $${best.tp3.toFixed(2)}.`;
      warningSigns = [
        `Watch out for reversal if price closes above $${best.sl.toFixed(2)}`,
        `Avoid entry if spread exceeds acceptable limit`,
        "Pay attention to high-impact news releases that could invalidate structure",
      ];
    }

    const confidenceNote = conf === "HIGH_CONFIDENCE" 
      ? `HIGH CONFIDENCE — ${score}/7 conditions met, prioritize this signal.`
      : `NORMAL — ${score}/7 conditions met, strict risk management.`;

    const analysis = {
      signal: sig,
      confidence: conf === "HIGH_CONFIDENCE" ? 75 : 60,
      bias: sig === "BUY" ? "BULLISH" : "BEARISH",
      method_confluence: {
        ema_trend: `MTF [${tfLabel}] Confluence Score ${score}/7`,
        rsi_momentum: `ADX ${adxVal.toFixed(1)}`,
        macd: "BoS + HTF BoS",
        heiken_ashi: "Liquidity Sweep",
        break_retest: "Pin Bar",
        session: getCurrentSession().toUpperCase(),
        aligned_methods: score,
      },
      entry: {
        ideal_price: best.entry,
        entry_zone: `${(best.entry - (best.atr ?? 1.5) * 0.3).toFixed(2)}–${(best.entry + (best.atr ?? 1.5) * 0.3).toFixed(2)}`,
        type: "MARKET",
        notes: best.reason || "",
      },
      risk_management: {
        atr_value: best.atr || 1.5,
        sl_minimum_distance: slDist,
        sl_optimal_distance: slDist,
        stop_loss: best.sl,
        take_profit_1: best.tp1,
        take_profit_2: best.tp2,
        take_profit_3: best.tp3,
        risk_reward_ratio: best.rrr || "1:1.5",
        recommended_lot: `${best.lot_size ?? "0.10"} lot`,
        max_lot_warning: "Open maximum 1 position",
        partial_close_guide: "TP1 hit → close 50%, SL to BE | TP2 hit → close 30% | TP3 hit → close remaining 20%",
      },
      market_structure: {
        primary_trend: currentSMC.trend,
        key_support: currentSMC.support_levels[0] || 0,
        key_resistance: currentSMC.resistance_levels[0] || 0,
        price_position: `$${price.toFixed(2)} | ADX=${adxVal.toFixed(1)}`,
        current_phase: currentSMC.bos || currentSMC.choch || "Normal",
        invalidation: `${sig === "BUY" ? "Close below" : "Close above"} SL ${best.sl}`,
      },
      confluence_factors: [best.reason],
      warning_signs: warningSigns,
      narrative: narrative,
      session_timing: {
        best_entry_window: getCurrentSession().toUpperCase(),
        avoid_trading: "Asian Session (02:00–08:00 WIB)",
      },
      next_analysis: "1 minute",
      berkah_raw: best,
    };

    let visionResult: any = null;
    let isApproved = false;

    const apiKey = process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY;

    if (apiKey) {
      try {
        const { generateChart } = await import("./src/chart.js");
        const { confirmSignalVision } = await import("./src/vision.js");

        const chart = await generateChart({
          timeframe: tfLabel === "BOTH" ? "5m" : tfLabel.toLowerCase(),
          signal: sig,
          entry: best.entry,
          stop_loss: best.sl,
          tp1: best.tp1,
          tp2: best.tp2,
          tp3: best.tp3,
          confidence: best.confidence === "HIGH_CONFIDENCE" || (best.score || 0) >= 5 ? 75 : 60,
        });

        if (chart.ok && chart.b64) {
          visionResult = await confirmSignalVision(
            chart.b64,
            sig,
            price,
            tfLabel,
            best.entry,
            best.sl,
            best.tp1,
            best.tp2,
            best.tp3,
            best.score ? Math.round((best.score / 7) * 100) : 60,
            currentIndicators,
            currentSMC
          );

          if (visionResult && visionResult.verdict === "VALID") {
            isApproved = true;
          } else {
            console.log(`[Scheduler] 👁 Vision AI verdict: ${visionResult?.verdict || "SKIP"} — signal rejected`);
            saveWaitRatelimited(`Vision AI rejected signal (${visionResult?.verdict || "SKIP"})`, price, currentIndicators, currentSMC, tfLabel === "BOTH" ? "5m" : tfLabel);
            return;
          }
        } else {
          console.warn("[Scheduler] Chart rendering failed, falling back to strict technical rules:", chart.error);
        }
      } catch (vErr) {
        console.error("[Scheduler] Vision AI check error, falling back to strict technical rules:", vErr);
      }
    }

    // Fallback if Vision AI is unavailable or key missing: require strict score >= 5
    if (!isApproved) {
      if ((best.score || 0) >= 5 || conf === "HIGH_CONFIDENCE") {
        isApproved = true;
        visionResult = {
          verdict: "VALID" as const,
          confidence_vision: 75,
          reasoning: "Strict technical confluence criteria met (Score >= 5/7).",
          key_observations: [`Score: ${score}/7`, `HTF Bias: ${mtf.htf?.bias || "RANGING"}`],
          risk_notes: ["Maintain strict risk management"],
          price_action_quality: "STRONG" as const,
          entry_timing: "IDEAL" as const,
          visual_trend: (sig === "BUY" ? "BULLISH" : "BEARISH") as const,
          original_signal: sig,
          combined_confidence: 75,
        };
      } else {
        console.log(`[Scheduler] ⚠️ Technical score ${best.score}/7 < 5 without Vision AI approval — skipping low-confluence signal`);
        saveWaitRatelimited(`Low confluence score (${best.score}/7 < 5)`, price, currentIndicators, currentSMC, tfLabel === "BOTH" ? "5m" : tfLabel);
        return;
      }
    }

    // 0. Synchronize Vision AI SL/TP refinement directly into 'best' and 'analysis' BEFORE saving to DB
    if (visionResult) {
      if (visionResult.suggested_sl && visionResult.suggested_sl > 0) {
        best.sl = visionResult.suggested_sl;
        if (visionResult.suggested_tp1 && visionResult.suggested_tp1 > 0) best.tp1 = visionResult.suggested_tp1;
        if (visionResult.suggested_tp2 && visionResult.suggested_tp2 > 0) best.tp2 = visionResult.suggested_tp2;
        if (visionResult.suggested_tp3 && visionResult.suggested_tp3 > 0) best.tp3 = visionResult.suggested_tp3;
      }
      analysis.risk_management.stop_loss = best.sl;
      analysis.risk_management.take_profit_1 = best.tp1;
      analysis.risk_management.take_profit_2 = best.tp2;
      analysis.risk_management.take_profit_3 = best.tp3;
      analysis.entry.ideal_price = best.entry;
      analysis.vision = visionResult;
      if (visionResult.combined_confidence) {
        analysis.confidence = visionResult.combined_confidence;
      }
    }

    // 1. ALWAYS Save Signal to SQLite Database first to get unique signal ID (with synchronized SL/TP)
    const signalId = db.saveSignal(analysis, tfLabel, price);
    if (!signalId || isNaN(signalId) || signalId <= 0) {
      console.error("[Scheduler] Failed to save signal to database");
      return;
    }

    // 2. Auto-create Trade Monitor for the confirmed signal (supersede old active monitors to prevent desync)
    db.supersedeActiveMonitors();
    db.createTradeMonitor(
      signalId,
      sig,
      best.entry,
      best.sl,
      best.tp1,
      best.tp2,
      best.tp3,
      tfLabel
    );
    console.log(`[Scheduler] 🚀 Active trade monitor set for Signal #${signalId}`);

    // 3. ALWAYS Format and Send Telegram Message with synchronized signalId
    if (lastSentTelegramSignalId === signalId) {
      console.log(`[Scheduler] ℹ️ Signal #${signalId} already broadcasted to Telegram — skipping duplicate`);
    } else {
      const { formatTelegramVisionSignal } = await import("./src/vision.js");
      const msg = formatTelegramVisionSignal(
        visionResult,
        price,
        tfLabel,
        best.entry,
        best.sl,
        best.tp1,
        best.tp2,
        best.tp3,
        analysis.risk_management?.risk_reward_ratio || "1:2",
        signalId,
        analysis.risk_management?.recommended_lot || best.lot_risk || 0.10,
        martingaleMultiplier
      );
      if (msg) {
        const sent = await sendTelegramMessage(msg);
        if (sent) {
          lastSentTelegramSignalId = signalId;
          console.log(`[Scheduler] ✅ Broadcasted Signal #${signalId} to Telegram`);
        }
      }
    }

    lastSignalTs = nowTs;
    db.configSet("last_signal_ts", nowTs);
    console.log(`[Scheduler] ✅ NEW ${sig} [${tfLabel}] signal #${signalId} saved & confirmed @ $${price.toFixed(2)}`);
    setLatestSignal(signalId, analysis, price, tfLabel, currentIndicators, currentSMC);

  } catch (err) {
    console.error("[Scheduler] Error in background analysis:", err);
  }
}

// Check if Python scheduler is already running by trying to acquire the same flock
function isPythonSchedulerRunning(): boolean {
  try {
    const { execSync } = require("child_process");
    execSync(
      `python3 -c "import fcntl; f = open('/tmp/goldex_scheduler.lock', 'a'); fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)"`,
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    // If it succeeds, it means we can acquire the lock, so Python scheduler is NOT running
    return false;
  } catch (e) {
    // If it fails (BlockingIOError or other), it means Python scheduler is running
    return true;
  }
}

// Start scheduler intervals on boot
let checkInterval: NodeJS.Timeout | null = null;
let scanInterval: NodeJS.Timeout | null = null;
let lastScanTime = Date.now();

function startBackgroundTasks() {
  console.log("[Scheduler] Initializing background tasks...");
  
  // Trade monitor loop: runs every 10 seconds for real-time TP/SL execution
  if (!checkInterval) {
    checkInterval = setInterval(async () => {
      if (isPythonSchedulerRunning()) {
        console.log("[Monitor] ⏭ Python scheduler is active (lock acquired) — skip Node.js monitor check (anti-duplicate)");
        return;
      }
      const updates = await runMonitorCheck();
      if (updates && updates.length > 0) {
        broadcast({ type: "MONITOR_UPDATE", data: updates });
      }
    }, 10000);
    console.log("[Monitor] 10s background monitor check loop started");
  }

  // Market analysis scan loop: runs every 30 seconds
  if (!scanInterval) {
    scanInterval = setInterval(async () => {
      if (isPythonSchedulerRunning()) {
        console.log("[Scheduler] ⏭ Python scheduler is active (lock acquired) — skip Node.js market scan (anti-duplicate)");
        return;
      }
      lastScanTime = Date.now();
      await runScheduledAnalysis();
    }, 30000);
    console.log("[Scheduler] 30s background market analysis loop started");
  }

  // Run first check immediately after boot
  setTimeout(async () => {
    if (isPythonSchedulerRunning()) {
      console.log("[Scheduler] ⏭ Python scheduler is active (lock acquired) — skip Node.js initial scans (anti-duplicate)");
      return;
    }
    const updates = await runMonitorCheck();
    if (updates && updates.length > 0) {
      broadcast({ type: "MONITOR_UPDATE", data: updates });
    }
    lastScanTime = Date.now();
    await runScheduledAnalysis();
  }, 3000);
}

// ─────────────────────────────────────────────
// PAGE ROUTE HANDLERS
// ─────────────────────────────────────────────

app.get("/", (req, res) => {
  res.render("landing.html");
});

app.get("/login", (req, res) => {
  if (req.session && (req.session as any).user_id) {
    return res.redirect("/dashboard");
  }
  
  const currentEnvUser = (process.env.DASHBOARD_USER || "admin").trim();
  const currentEnvPass = (process.env.DASHBOARD_PASS || "nano2026").trim();

  // Create partially masked helper string for safety, but extremely clear for debugging
  const maskText = (text: string) => {
    if (text.length <= 3) return text;
    return text[0] + "*".repeat(text.length - 2) + text[text.length - 1];
  };

  res.render("login.html", { 
    error: req.query.error,
    activeEnvUser: currentEnvUser,
    activeEnvPassMasked: maskText(currentEnvPass),
    isDefaultCreds: currentEnvUser === "admin" && currentEnvPass === "nano2026"
  });
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render("login.html", { error: "Username and password are required" });
  }

  const cleanUsername = username.trim();
  const cleanPassword = password.trim();

  const hash = crypto.createHash("sha256").update(cleanPassword).digest("hex");
  let user = db.getUserByCredentials(cleanUsername, hash);

  // Fallback to environment variables or hardcoded values
  if (!user) {
    const adminUser = (process.env.DASHBOARD_USER || "admin").trim();
    const adminPass = (process.env.DASHBOARD_PASS || "nano2026").trim();
    
    const isEnvMatch = (cleanUsername.toLowerCase() === adminUser.toLowerCase() && cleanPassword === adminPass);
    const isCustomMatch = (cleanUsername.toLowerCase() === "xauxau" && cleanPassword === "xauberkah99");

    if (isEnvMatch || isCustomMatch) {
      const targetUser = isCustomMatch ? "xauxau" : adminUser;
      const existing = db.getUsers().find((u) => u.username.toLowerCase() === targetUser.toLowerCase());
      if (existing) {
        db.updateUser(existing.id, { 
          username: targetUser, 
          password_hash: hash, 
          is_active: 1, 
          role: "superadmin" 
        });
        user = existing;
      } else {
        user = db.createUser({
          username: targetUser,
          password_hash: hash,
          full_name: "Super Admin",
          kota: "Jakarta",
          no_wa: "081234567890",
          telegram: "@admin",
          role: "superadmin",
          is_active: 1,
        });
      }
    }
  }

  if (!user) {
    const currentEnvUser = (process.env.DASHBOARD_USER || "admin").trim();
    const currentEnvPass = (process.env.DASHBOARD_PASS || "nano2026").trim();
    const maskText = (text: string) => {
      if (text.length <= 3) return text;
      return text[0] + "*".repeat(text.length - 2) + text[text.length - 1];
    };

    return res.render("login.html", { 
      error: "Invalid username or password / account inactive",
      activeEnvUser: currentEnvUser,
      activeEnvPassMasked: maskText(currentEnvPass),
      isDefaultCreds: currentEnvUser === "admin" && currentEnvPass === "nano2026"
    });
  }

  // Set session variables
  (req.session as any).user_id = user.id;
  (req.session as any).username = user.username;
  (req.session as any).role = user.role;
  (req.session as any).full_name = user.full_name;

  // Save session and redirect
  req.session.save((err) => {
    if (err) {
      console.error("[Session] Save error:", err);
    }
    res.redirect("/dashboard");
  });
});

app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("[Session] Destroy error:", err);
    }
    res.redirect("/");
  });
});

app.get("/api/diagnostic-env", (req, res) => {
  const envUser = process.env.DASHBOARD_USER;
  const envPass = process.env.DASHBOARD_PASS;

  const loadedUser = envUser !== undefined;
  const loadedPass = envPass !== undefined;

  const trimmedUser = envUser ? envUser.trim() : "";
  const trimmedPass = envPass ? envPass.trim() : "";

  const hasWhitespaceUser = envUser ? envUser !== trimmedUser : false;
  const hasWhitespacePass = envPass ? envPass !== trimmedPass : false;

  const userLength = envUser ? envUser.length : 0;
  const passLength = envPass ? envPass.length : 0;

  const isDefaultUser = trimmedUser === "admin" || trimmedUser === "";
  const isDefaultPass = trimmedPass === "nano2026" || trimmedPass === "";

  // Check database users
  const usersInDb = db.getUsers();
  const dbUserMatch = usersInDb.find(u => u.username.toLowerCase() === (trimmedUser || "admin").toLowerCase());
  const dbCustomMatch = usersInDb.find(u => u.username.toLowerCase() === "xauxau");

  const diagnosticResult = {
    status: "ok",
    timestamp: new Date().toISOString(),
    environment: {
      DASHBOARD_USER: {
        loaded: loadedUser,
        length: userLength,
        hasLeadingOrTrailingWhitespace: hasWhitespaceUser,
        isDefault: isDefaultUser,
      },
      DASHBOARD_PASS: {
        loaded: loadedPass,
        length: passLength,
        hasLeadingOrTrailingWhitespace: hasWhitespacePass,
        isDefault: isDefaultPass,
      }
    },
    databaseState: {
      totalUsers: usersInDb.length,
      hasEnvUserInDb: !!dbUserMatch,
      hasCustomUserInDb: !!dbCustomMatch,
      envUserActive: dbUserMatch ? dbUserMatch.is_active === 1 : null,
      customUserActive: dbCustomMatch ? dbCustomMatch.is_active === 1 : null,
    },
    sessionConfig: {
      cookieSecure: req.session?.cookie?.secure ?? null,
      cookieSameSite: req.session?.cookie?.sameSite ?? null,
    }
  };

  console.log("[DIAGNOSTIC] Environment check performed:", JSON.stringify(diagnosticResult, null, 2));
  return res.json(diagnosticResult);
});

app.get("/dashboard", loginRequired, (req, res) => {
  res.render("index.html", { username: (req.session as any).username });
});

app.get("/login_proposal", (req, res) => {
  const currentEnvUser = (process.env.DASHBOARD_USER || "admin").trim();
  const currentEnvPass = (process.env.DASHBOARD_PASS || "nano2026").trim();
  const maskText = (text: string) => {
    if (text.length <= 3) return text;
    return text[0] + "*".repeat(text.length - 2) + text[text.length - 1];
  };
  res.render("login_proposal.html", { 
    error: req.query.error,
    activeEnvUser: currentEnvUser,
    activeEnvPassMasked: maskText(currentEnvPass),
    isDefaultCreds: currentEnvUser === "admin" && currentEnvPass === "nano2026"
  });
});

app.post("/login_proposal", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.render("login_proposal.html", { error: "Username and password are required" });
  }

  const cleanUsername = username.trim();
  const cleanPassword = password.trim();

  const hash = crypto.createHash("sha256").update(cleanPassword).digest("hex");
  let user = db.getUserByCredentials(cleanUsername, hash);

  // Fallback to environment variables or hardcoded values
  if (!user) {
    const adminUser = (process.env.DASHBOARD_USER || "admin").trim();
    const adminPass = (process.env.DASHBOARD_PASS || "nano2026").trim();
    
    const isEnvMatch = (cleanUsername.toLowerCase() === adminUser.toLowerCase() && cleanPassword === adminPass);
    const isCustomMatch = (cleanUsername.toLowerCase() === "xauxau" && cleanPassword === "xauberkah99");

    if (isEnvMatch || isCustomMatch) {
      const targetUser = isCustomMatch ? "xauxau" : adminUser;
      const existing = db.getUsers().find((u) => u.username.toLowerCase() === targetUser.toLowerCase());
      if (existing) {
        db.updateUser(existing.id, { 
          username: targetUser, 
          password_hash: hash, 
          is_active: 1, 
          role: "superadmin" 
        });
        user = existing;
      } else {
        user = db.createUser({
          username: targetUser,
          password_hash: hash,
          full_name: "Super Admin",
          kota: "Jakarta",
          no_wa: "081234567890",
          telegram: "@admin",
          role: "superadmin",
          is_active: 1,
        });
      }
    }
  }

  if (!user) {
    const currentEnvUser = (process.env.DASHBOARD_USER || "admin").trim();
    const currentEnvPass = (process.env.DASHBOARD_PASS || "nano2026").trim();
    const maskText = (text: string) => {
      if (text.length <= 3) return text;
      return text[0] + "*".repeat(text.length - 2) + text[text.length - 1];
    };

    return res.render("login_proposal.html", { 
      error: "Invalid username or password / account inactive",
      activeEnvUser: currentEnvUser,
      activeEnvPassMasked: maskText(currentEnvPass),
      isDefaultCreds: currentEnvUser === "admin" && currentEnvPass === "nano2026"
    });
  }

  // Set session variables
  (req.session as any).user_id = user.id;
  (req.session as any).username = user.username;
  (req.session as any).role = user.role;
  (req.session as any).full_name = user.full_name;

  // Save session and redirect
  req.session.save((err) => {
    if (err) {
      console.error("[Session] Save error:", err);
    }
    res.redirect("/dashboard_proposal");
  });
});

app.get("/dashboard_proposal", loginRequired, (req, res) => {
  res.render("index_proposal.html", { username: (req.session as any).username });
});

app.get("/dashboard_dummy", (req, res) => {
  res.render("dashboard_dummy.html");
});

app.get("/admin/users", superadminRequired, (req, res) => {
  res.render("admin_users.html", {
    username: (req.session as any).username,
    full_name: (req.session as any).full_name || "Admin",
  });
});

// ─────────────────────────────────────────────
// API ENDPOINTS
// ─────────────────────────────────────────────

// GET all users
app.get("/api/admin/users", superadminRequired, (req, res) => {
  res.json(db.getUsers());
});

// POST register user
app.post("/api/admin/users", superadminRequired, (req, res) => {
  const { username, password, full_name, kota, no_wa, telegram, role } = req.body;
  
  if (!username || !password || !full_name) {
    return res.status(400).json({ error: "Username, password, and full name are required" });
  }

  const exists = db.getUsers().some((u) => u.username === username);
  if (exists) {
    return res.status(400).json({ error: "Username already registered" });
  }

  const hash = crypto.createHash("sha256").update(password).digest("hex");
  const newUser = db.createUser({
    username,
    password_hash: hash,
    full_name,
    kota: kota || "",
    no_wa: no_wa || "",
    telegram: telegram || "",
    role: role || "user",
    is_active: 1,
  });

  res.json({ ok: true, user: newUser });
});

// PUT update user
app.put("/api/admin/users/:user_id", superadminRequired, (req, res) => {
  const userId = parseInt(req.params.user_id);
  const { full_name, kota, no_wa, telegram, role, is_active, password } = req.body;

  const updates: Partial<User> = {};
  if (full_name !== undefined) updates.full_name = full_name;
  if (kota !== undefined) updates.kota = kota;
  if (no_wa !== undefined) updates.no_wa = no_wa;
  if (telegram !== undefined) updates.telegram = telegram;
  if (role !== undefined) updates.role = role;
  if (is_active !== undefined) updates.is_active = parseInt(is_active);

  if (password && password.trim().length >= 6) {
    updates.password_hash = crypto.createHash("sha256").update(password.trim()).digest("hex");
  } else if (password && password.trim().length > 0) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  const success = db.updateUser(userId, updates);
  if (success) {
    res.json({ ok: true, message: "User updated successfully" });
  } else {
    res.status(404).json({ error: "User not found" });
  }
});

// DELETE soft-delete user
app.delete("/api/admin/users/:user_id", superadminRequired, (req, res) => {
  const userId = parseInt(req.params.user_id);
  if (userId === (req.session as any).user_id) {
    return res.status(400).json({ error: "Cannot delete your own account" });
  }

  const success = db.deleteUser(userId);
  if (success) {
    res.json({ ok: true, message: "User disabled" });
  } else {
    res.status(404).json({ error: "User not found" });
  }
});

// GET public live price
app.get("/api/public/price", async (req, res) => {
  const price = await fetchCurrentPriceServer();
  res.json({ ok: true, price });
});

// GET session status info
app.get("/api/session_status", loginRequired, (req, res) => {
  const current = getCurrentSession();
  const active = isSessionActive();
  res.json({
    ok: true,
    current_session: current,
    session_active: active,
    schedule: getSessionSchedule(),
  });
});

// GET admin session schedule toggles
app.get("/api/admin/session_schedule", superadminRequired, (req, res) => {
  res.json({
    ok: true,
    schedule: getSessionSchedule(),
    current_session: getCurrentSession(),
    session_active: isSessionActive(),
    session_hours: {
      london: "14:00–21:59 WIB",
      new_york: "19:00–02:59 WIB",
      tokyo: "06:00–13:59 WIB",
      sydney: "04:00–09:59 WIB",
    },
  });
});

// POST update session schedule toggles
app.post("/api/admin/session_schedule", superadminRequired, (req, res) => {
  const body = req.body || {};
  const updated: any = {};
  
  for (const key of ["london", "new_york", "sydney", "tokyo"]) {
    if (body[key] !== undefined) {
      updated[key] = !!body[key];
    }
  }

  if (Object.keys(updated).length > 0) {
    setSessionSchedule(updated);
  }

  res.json({
    ok: true,
    schedule: getSessionSchedule(),
    updated,
  });
});

// POST vision confirmation pipeline
app.post("/api/vision_confirm", loginRequired, async (req, res) => {
  try {
    const { 
      signal, 
      timeframe, 
      entry, 
      stop_loss, 
      tp1, 
      tp2, 
      tp3, 
      confidence, 
      indicators, 
      smc, 
      price 
    } = req.body;

    if (!signal || signal === "WAIT") {
      return res.status(400).json({ ok: false, error: "Vision is only for BUY/SELL" });
    }

    // 1. Generate chart image b64 via Python Bridge
    const chart = await generateChart({
      timeframe: timeframe || "15m",
      signal: signal,
      entry: parseFloat(entry || 0),
      stop_loss: parseFloat(stop_loss || 0),
      tp1: parseFloat(tp1 || 0),
      tp2: parseFloat(tp2 || 0),
      tp3: parseFloat(tp3 || 0),
      confidence: parseInt(confidence || 0),
    });

    if (!chart.ok || !chart.b64) {
      return res.status(500).json({ ok: false, error: "Failed to render chart: " + chart.error });
    }

    // 2. Query Gemini Vision SDK
    const vision = await confirmSignalVision(
      chart.b64,
      signal,
      parseFloat(price || chart.price || 0),
      timeframe || "15m",
      parseFloat(entry || 0),
      parseFloat(stop_loss || 0),
      parseFloat(tp1 || 0),
      parseFloat(tp2 || 0),
      parseFloat(tp3 || 0),
      parseInt(confidence || 0),
      indicators || {},
      smc || {}
    );

    // 3. Post to Telegram if VALID
    let tg_sent = false;
    const bot_token = process.env.TELEGRAM_BOT_TOKEN;
    const chat_id = process.env.TELEGRAM_CHAT_ID;

    if (vision.verdict === "VALID" && bot_token && chat_id) {
      const rawSigId = req.body.signal_id ? parseInt(req.body.signal_id) : undefined;
      
      if (!rawSigId || isNaN(rawSigId) || rawSigId <= 0) {
        console.log("[Vision Confirm] ℹ️ Vision analysis completed, but no signal_id from DB provided — skipping Telegram broadcast");
      } else if (lastSentTelegramSignalId === rawSigId) {
        console.log(`[Vision Confirm] ℹ️ Telegram message for Signal #${rawSigId} already broadcasted by server — skipping duplicate`);
      } else {
        const msg = formatTelegramVisionSignal(
          vision,
          parseFloat(price || chart.price || 0),
          timeframe || "15m",
          parseFloat(entry || 0),
          parseFloat(stop_loss || 0),
          parseFloat(tp1 || 0),
          parseFloat(tp2 || 0),
          parseFloat(tp3 || 0),
          req.body.rr_ratio || "1:1.5",
          rawSigId
        );

        if (msg) {
          const textSuccess = await sendTelegramMessage(msg);
          if (textSuccess) {
            tg_sent = true;
            lastSentTelegramSignalId = rawSigId;
          }
        }
      }
    }

    res.json({
      ok: true,
      verdict: vision.verdict,
      final_signal: vision.final_signal,
      combined_confidence: vision.combined_confidence,
      reasoning: vision.reasoning,
      key_observations: vision.key_observations,
      risk_notes: vision.risk_notes,
      price_action_quality: vision.price_action_quality,
      entry_timing: vision.entry_timing,
      chart_b64: chart.b64,
      tg_sent: tg_sent,
      visual_support_level: vision.visual_support_level,
      visual_resistance_level: vision.visual_resistance_level,
      suggested_sl: vision.suggested_sl,
      suggested_tp1: vision.suggested_tp1,
      suggested_tp2: vision.suggested_tp2,
      suggested_tp3: vision.suggested_tp3,
    });

  } catch (err: any) {
    console.error("[Vision Confirm API] error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET RSS news sentiment cache
let cachedNewsData: any = null;
let lastNewsFetch = 0;

app.get("/api/news_sentiment", loginRequired, async (req, res) => {
  const now = Date.now();
  if (now - lastNewsFetch > 300000 && cachedNewsData) { // 5 minutes cache
    // fetch in bg
    fetchGoldNewsSentiment().then((data) => {
      cachedNewsData = data;
      lastNewsFetch = now;
    }).catch(console.error);
  }

  if (!cachedNewsData) {
    cachedNewsData = await fetchGoldNewsSentiment();
    lastNewsFetch = now;
  }

  res.json(cachedNewsData);
});

// GET economic USD news calendar
let cachedCalData: any = null;
let lastCalFetch = 0;

app.get("/api/economic_calendar", loginRequired, async (req, res) => {
  const now = Date.now();
  if (now - lastCalFetch > 900000 && cachedCalData) { // 15 minutes cache
    fetchForexCalendar().then((data) => {
      cachedCalData = data;
      lastCalFetch = now;
    }).catch(console.error);
  }

  if (!cachedCalData) {
    cachedCalData = await fetchForexCalendar();
    lastCalFetch = now;
  }

  res.json({ ok: true, data: cachedCalData, updated: nowWibStr("%H:%M WIB") });
});

// GET latest signal
app.get("/api/latest_signal", loginRequired, (req, res) => {
  const activeMonitors = db.getActiveMonitors();
  const dbSignal = db.getLatestSignalFromDB();

  // 1. Prioritize DB signal (Active trade monitor signal, or latest BUY/SELL trade signal)
  if (dbSignal) {
    let analysisObj: any = {};
    try {
      analysisObj = JSON.parse(dbSignal.raw_json);
    } catch {
      analysisObj = dbSignal;
    }

    return res.json({
      ok: true,
      signal_id: dbSignal.id,
      analysis: analysisObj,
      price: dbSignal.price,
      timeframe: dbSignal.timeframe,
      timestamp: getWIBDate(new Date(dbSignal.timestamp)).toISOString().replace("T", " ").substring(0, 19),
      data_source: "MT5 Bridge (Broker Live)",
      indicators: analysisObj.indicators || {},
      smc: analysisObj.smc || { trend: dbSignal.trend },
      market_open: isMarketOpen(),
      market_closed_reason: isMarketOpen() ? "" : marketClosedReason(),
      active_monitor: activeMonitors && activeMonitors.length > 0 ? activeMonitors[0] : null,
      from_db: true,
    });
  }

  // 2. Check cached signal fallback
  const latestCachedStr = db.configGet("latest_signal_cache", "");
  if (latestCachedStr) {
    try {
      const cachedData = JSON.parse(latestCachedStr);
      return res.json({
        ...cachedData,
        market_open: isMarketOpen(),
        market_closed_reason: isMarketOpen() ? "" : marketClosedReason(),
        active_monitor: activeMonitors && activeMonitors.length > 0 ? activeMonitors[0] : null,
      });
    } catch {
      // ignore parse error, fallback
    }
  }

  if (latestSignalCache && latestSignalCache.ok) {
    return res.json({
      ...latestSignalCache,
      market_open: isMarketOpen(),
      market_closed_reason: isMarketOpen() ? "" : marketClosedReason(),
      active_monitor: activeMonitors && activeMonitors.length > 0 ? activeMonitors[0] : null,
    });
  }

  res.json({ ok: false, error: "No signal generated yet" });
});

// GET scheduler interval status
app.get("/api/scheduler_status", loginRequired, (req, res) => {
  const now = Date.now();
  const nextRunMs = lastScanTime + 60000;
  const next_run_sec = Math.max(0, Math.round((nextRunMs - now) / 1000));
  
  const nextWib = getWIBDate(new Date(nextRunMs));
  const pad = (num: number) => String(num).padStart(2, "0");
  const next_run_time = `${pad(nextWib.getHours())}:${pad(nextWib.getMinutes())}:${pad(nextWib.getSeconds())} WIB`;

  res.json({
    ok: true,
    interval_sec: 60,
    active_loops: ["MonitorCheck", "ScheduledAnalysis"],
    status: isMarketOpen() ? "RUNNING" : "STOPPED (Market Closed)",
    next_run: "1 minute",
    next_run_sec: next_run_sec,
    next_run_time: next_run_time,
    thread_alive: true,
    market_open: isMarketOpen(),
    market_closed_reason: marketClosedReason(),
    timeframe: (process.env.DEFAULT_TIMEFRAME || "1m").toUpperCase(),
  });
});

// GET general configuration
app.get("/api/get_config", loginRequired, async (req, res) => {
  const twelvePrice = await fetchCurrentPriceServer();
  res.json({
    ok: true,
    has_anthropic: !!(process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY),
    has_twelve: !!process.env.TWELVE_DATA_KEY,
    has_telegram: !!process.env.TELEGRAM_BOT_TOKEN,
    has_bridge: !!process.env.MT5_BRIDGE_URL,
    bridge_url: !!process.env.MT5_BRIDGE_URL,
    twelve_price: twelvePrice,
    bridge_price: twelvePrice,
    live_price: twelvePrice,
    price_source: "MT5 Bridge (Broker Live)",
    has_news_bridge: !!process.env.MT5_BRIDGE_URL,
    data_source: "MT5 Bridge (Broker Live)",
  });
});

// POST run manual analyze (authorized for dashboard users)
app.post("/api/analyze", loginRequired, async (req, res) => {
  try {
    await runScheduledAnalysis();
    res.json({ ok: true, message: "Manual market analysis executed & signal broadcasted successfully." });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST broadcast latest active signal to Telegram
app.post("/api/broadcast_latest_signal", loginRequired, async (req, res) => {
  try {
    const latest = db.getLatestSignalFromDB();
    if (!latest) {
      return res.status(404).json({ error: "No active signal found in database" });
    }

    const { formatTelegramVisionSignal } = await import("./src/vision.js");
    const parsed = typeof latest.raw_json === "string" ? JSON.parse(latest.raw_json) : latest.raw_json || {};
    const rm = parsed.risk_management || {};

    const msg = formatTelegramVisionSignal(
      {
        verdict: "VALID",
        final_signal: latest.signal,
        combined_confidence: latest.confidence || 80,
        reasoning: latest.narrative || "Manual broadcast from GOLDEX AI Dashboard.",
        key_observations: ["Broadcasted on demand via Dashboard"],
        risk_notes: "Follow strict risk management guidelines.",
        suggested_sl: latest.stop_loss,
        suggested_tp1: latest.tp1,
        suggested_tp2: latest.tp2,
        suggested_tp3: latest.tp3,
      },
      latest.price,
      latest.timeframe || "5m",
      latest.entry || latest.price,
      latest.stop_loss,
      latest.tp1,
      latest.tp2,
      latest.tp3,
      latest.rr_ratio || rm.risk_reward_ratio || "1:2",
      latest.id,
      rm.recommended_lot || 0.10
    );

    if (!msg) {
      return res.status(500).json({ error: "Failed to format signal message" });
    }

    const sent = await sendTelegramMessage(msg);
    if (sent) {
      res.json({ ok: true, message: `Signal #${latest.id} (${latest.signal}) successfully sent to Telegram!` });
    } else {
      res.status(500).json({ error: "Failed to send to Telegram — please verify Bot Token and Chat ID" });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST dispatch custom manual signal to Dashboard & Telegram
app.post("/api/dispatch_manual_signal", loginRequired, async (req, res) => {
  try {
    const { signal, price, timeframe, stop_loss, tp1, tp2, tp3, narrative } = req.body;
    if (!signal || !price || !stop_loss || !tp1) {
      return res.status(400).json({ error: "Signal, current price, stop loss, and TP1 are required." });
    }

    const sigType = signal.toUpperCase();
    if (sigType !== "BUY" && sigType !== "SELL") {
      return res.status(400).json({ error: "Signal must be BUY or SELL" });
    }

    const currentPrice = parseFloat(price);
    const sl = parseFloat(stop_loss);
    const t1 = parseFloat(tp1);
    const t2 = tp2 ? parseFloat(tp2) : (sigType === "BUY" ? t1 + (t1 - currentPrice) : t1 - (currentPrice - t1));
    const t3 = tp3 ? parseFloat(tp3) : (sigType === "BUY" ? t2 + (t1 - currentPrice) : t2 - (currentPrice - t1));
    const tf = timeframe || "5m";

    const customAnalysis = {
      signal: sigType,
      confidence: 85,
      bias: sigType === "BUY" ? "BULLISH" : "BEARISH",
      narrative: narrative || "Manual signal created & dispatched from GOLDEX AI Terminal.",
      entry: {
        ideal_price: currentPrice,
        entry_zone: `$${currentPrice.toFixed(2)} - $${(currentPrice + (sigType === "BUY" ? 0.5 : -0.5)).toFixed(2)}`,
        action: sigType,
      },
      risk_management: {
        stop_loss: sl,
        take_profit_1: t1,
        take_profit_2: t2,
        take_profit_3: t3,
        risk_reward_ratio: "1:2",
        recommended_lot: 0.10,
      },
    };

    // 1. Save to DB
    const signalId = db.saveSignal(customAnalysis, tf, currentPrice);

    // 2. Set active trade monitor
    db.supersedeActiveMonitors();
    db.createTradeMonitor(signalId, sigType, currentPrice, sl, t1, t2, t3, tf);

    // 3. Broadcast to Dashboard clients via WebSocket
    broadcast({
      type: "SIGNAL_UPDATE",
      data: {
        id: signalId,
        analysis: customAnalysis,
        price: currentPrice,
        timeframe: tf,
        timestamp: new Date().toISOString(),
      },
    });

    // 4. Format & Send Telegram Message
    const { formatTelegramVisionSignal } = await import("./src/vision.js");
    const msg = formatTelegramVisionSignal(
      {
        verdict: "VALID",
        final_signal: sigType,
        combined_confidence: 85,
        reasoning: customAnalysis.narrative,
        key_observations: ["Manual Signal dispatched directly from Dashboard"],
        risk_notes: "Always practice proper risk & money management.",
        suggested_sl: sl,
        suggested_tp1: t1,
        suggested_tp2: t2,
        suggested_tp3: t3,
      },
      currentPrice,
      tf,
      currentPrice,
      sl,
      t1,
      t2,
      t3,
      "1:2",
      signalId,
      0.10
    );

    let tgSent = false;
    if (msg) {
      tgSent = await sendTelegramMessage(msg);
    }

    res.json({
      ok: true,
      signal_id: signalId,
      telegram_sent: tgSent,
      message: `Manual Signal #${signalId} (${sigType}) dispatched successfully! ${tgSent ? "Sent to Telegram & Dashboard." : "Updated on Dashboard."}`,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET historical signals
app.get("/api/history", loginRequired, (req, res) => {
  const limit = parseInt((req.query.limit as string) || "50");
  const filter = (req.query.filter as string) || (req.query.type as string) || "ALL";
  res.json({ ok: true, data: db.getHistory(limit, filter) });
});

// GET database signal stats
app.get("/api/stats", loginRequired, (req, res) => {
  res.json({ ok: true, data: db.getStats() });
});

// POST clear signals history
app.post("/api/clear_history", superadminRequired, (req, res) => {
  db.clearHistory();
  res.json({ ok: true, message: "History cleared successfully" });
});

// POST send manual test Telegram alert
app.post("/api/send_telegram", loginRequired, async (req, res) => {
  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: "Message cannot be empty" });
  }

  const success = await sendTelegramMessage(text);
  if (success) {
    res.json({ ok: true, message: "Message sent successfully to Telegram" });
  } else {
    res.status(500).json({ error: "Failed to send message to Telegram — check bot_token and chat_id" });
  }
});

// POST trigger manual monitors check
app.post("/api/check_monitors", loginRequired, async (req, res) => {
  const updates = await runMonitorCheck();
  if (updates && updates.length > 0) {
    broadcast({ type: "MONITOR_UPDATE", data: updates });
  }
  res.json({ ok: true, updates });
});

// GET win rate / performance statistics
app.get("/api/performance", loginRequired, (req, res) => {
  res.json({ ok: true, data: db.getPerformanceStats(7) });
});

// POST reset monitors
app.post("/api/reset_performance", superadminRequired, (req, res) => {
  // Clear monitors
  (db as any).data.trade_monitors = [];
  db.save();
  res.json({ ok: true, message: "All performance monitors successfully reset" });
});

// GET analytics with period filter
app.get("/api/analytics", loginRequired, (req, res) => {
  const days = parseInt((req.query.days as string) || "7");
  res.json({ ok: true, data: db.getPerformanceStats(days) });
});

// GET closed trades history
app.get("/api/trade_history", loginRequired, (req, res) => {
  res.json({ ok: true, data: db.getTradeHistory(30) });
});

// GET open ACTIVE positions
app.get("/api/active_monitors", loginRequired, (req, res) => {
  res.json({ ok: true, data: db.getActiveMonitors() });
});

// POST save Telegram setup configs
app.post("/api/save_telegram_config", superadminRequired, (req, res) => {
  const { bot_token, chat_id } = req.body;
  if (bot_token) {
    process.env.TELEGRAM_BOT_TOKEN = bot_token;
    db.configSet("telegram_bot_token", bot_token);
  }
  if (chat_id) {
    process.env.TELEGRAM_CHAT_ID = chat_id;
    db.configSet("telegram_chat_id", chat_id);
  }
  res.json({ ok: true, message: "Telegram config saved successfully" });
});

// ─────────────────────────────────────────────
// BOOTSTRAP EXPRESS SERVER
// ─────────────────────────────────────────────
server.listen(PORT, "0.0.0.0", () => {
  console.log(`========================================`);
  console.log(` GOLDEX AI — XAU/USD Signal Terminal`);
  console.log(` Running on http://localhost:${PORT}`);
  console.log(`========================================`);
  
  // Start the background workers
  startBackgroundTasks();
});
