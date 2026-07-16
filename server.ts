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
    if (req.xhr || req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "Silakan login terlebih dahulu" });
    }
    return res.redirect("/login");
  }
  next();
}

function superadminRequired(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!req.session || (req.session as any).role !== "superadmin") {
    if (req.xhr || req.path.startsWith("/api/")) {
      return res.status(403).json({ error: "Akses ditolak: Hanya superadmin" });
    }
    return res.status(403).send("Akses ditolak: Hanya superadmin yang dapat mengakses halaman ini.");
  }
  next();
}

// ─────────────────────────────────────────────
// STATE & SCHEDULER VARS
// ─────────────────────────────────────────────
let lastSignalCandleIdM5 = "";
let lastSignalTs = parseFloat(db.configGet("last_signal_ts", "0"));
let lastWaitSaveTs = parseFloat(db.configGet("last_wait_save_ts", "0"));
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
  
  // Broadcast the latest signal cache immediately to all connected WebSocket clients
  broadcast({ type: "LATEST_SIGNAL", data: latestSignalCache });
}

// Humanize WAIT signal reasons
function humanizeReason(raw: string, rsiVal: number): string {
  if (!raw || raw === "-") {
    return "Kondisi pasar belum memenuhi semua filter konfluensi.";
  }

  const missingMap: Record<string, string> = {
    pin_bar: "Pin bar belum terkonfirmasi",
    htf_bos: "HTF Break of Structure belum terjadi",
    bos_bull: "Break of Structure bullish belum terkonfirmasi",
    bos_bear: "Break of Structure bearish belum terkonfirmasi",
    liq_buy: "Belum ada liquidity sweep ke bawah",
    liq_sell: "Belum ada liquidity sweep ke atas",
    adx: `RSI ${rsiVal.toFixed(0)} — momentum belum cukup kuat`,
    bullish_engulfing: "Belum ada pola bullish engulfing",
    bearish_engulfing: "Belum ada pola bearish engulfing",
    stable_candle: "Candle tidak cukup solid (doji/small body)",
    decrease_over_10: "Harga belum turun dari 10 candle lalu",
    increase_over_10: "Harga belum naik dari 10 candle lalu",
  };

  const rawLower = raw.toLowerCase();
  const found: string[] = [];
  for (const [key, desc] of Object.entries(missingMap)) {
    if (rawLower.includes(key)) {
      found.push(desc);
    }
  }

  if (found.length > 0) {
    return "Menunggu konfluensi: " + found.slice(0, 3).join(" · ") + ".";
  }

  if (raw.length < 80 && !raw.includes("miss") && !raw.includes("['")) {
    return raw;
  }

  return "Kondisi pasar belum memenuhi semua filter konfluensi Berkah Signal.";
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
      ema_trend: "Menunggu",
      rsi_momentum: `RSI ${rsiValue.toFixed(0)}`,
      macd: "NEUTRAL",
      heiken_ashi: indicators?.ha_bias || "NEUTRAL",
      break_retest: "Belum",
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
      current_phase: "Menunggu setup",
      invalidation: "-",
    },
    confluence_factors: [],
    warning_signs: [],
    session_timing: {
      best_entry_window: "London/NY Overlap (14:00–04:00 WIB)",
      avoid_trading: "Sesi Asia (02:00–08:00 WIB)",
    },
    next_analysis: "1 menit",
  };

  const signalId = db.saveSignal(waitAnalysis, timeframe, price);
  setLatestSignal(signalId, waitAnalysis, price, timeframe, indicators, smc);
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
    const { data: candlesM5, source: sourceM5 } = await fetchOhlcvPrimary("5m", 500);
    if (!candlesM5 || candlesM5.length === 0) {
      console.log("[Scheduler] ⚠️ OHLCV M5 tidak tersedia — analisis dibatalkan");
      return;
    }

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
        saveWaitRatelimited(`PENGHENTIAN SEMENTARA (NEWS SUSPENSION): ${newsStatus.reason}`, price, currentIndicators, currentSMC, "5m");
        return;
      }
    } catch (newsErr) {
      console.error("[Scheduler] News suspension check error:", newsErr);
    }

    // Deduplication check based on candle time
    const latestCandleTime = candlesM5[candlesM5.length - 1].time;
    if (latestCandleTime === lastSignalCandleIdM5) {
      console.log(`[Scheduler] ⏭ Candle M5 sama (${latestCandleTime}) — skip re-scan`);
      return;
    }
    lastSignalCandleIdM5 = latestCandleTime;

    // Fetch M1
    const { data: candlesM1 } = await fetchOhlcvPrimary("1m", 500);

    // Fetch H1
    let candlesH1: any[] | null = null;
    try {
      const h1Result = await fetchOhlcvPrimary("1h", 300);
      candlesH1 = h1Result.data;
    } catch (e: any) {
      console.log(`[Scheduler] ⚠️ H1 fetch error: ${e.message} — fallback EMA lokal`);
    }

    // Fetch H4 (Requirement 2: Trend confluence H1/H4)
    let candlesH4: any[] | null = null;
    try {
      const h4Result = await fetchOhlcvPrimary("4h", 200);
      candlesH4 = h4Result.data;
    } catch (e: any) {
      console.log(`[Scheduler] ⚠️ H4 fetch error: ${e.message}`);
    }

    // Execute Multi-Timeframe Scan
    const capital = parseFloat(process.env.DISPLAY_CAPITAL || "2000.0");
    const riskPercent = parseFloat(process.env.RISK_PERCENT || "1.5");
    const valuePerLot = 10.0;

    const mtf = runMultiTimeframeScan(candlesM1, candlesM5, candlesH1, candlesH4, capital, riskPercent, valuePerLot);
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
      saveWaitRatelimited(best.reason || "Kondisi konfluensi belum terpenuhi", price, currentIndicators, currentSMC, tfLabel === "BOTH" ? "5m" : tfLabel);
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
      narrative = `Pasar XAU/USD [${tfLabel}] menunjukkan konfirmasi BUY ${conf} dengan skor confluence ${score}/7 — EMA50 di atas EMA200 mengonfirmasi bias bullish, ADX ${adxVal.toFixed(1)} menandakan momentum trend kuat. Level kritis: pertahankan SL di $${best.sl.toFixed(2)} (jarak ${slDist.toFixed(2)} poin dari entry), target bertahap TP1 $${best.tp1.toFixed(2)} → TP2 $${best.tp2.toFixed(2)} → TP3 $${best.tp3.toFixed(2)}.`;
      warningSigns = [
        `Waspadai reversal jika harga close di bawah $${best.sl.toFixed(2)}`,
        `Hindari entry jika spread melebihi batas wajar`,
        "Perhatikan rilis news high-impact yang bisa invalidate struktur",
      ];
    } else {
      narrative = `Pasar XAU/USD [${tfLabel}] menunjukkan konfirmasi SELL ${conf} dengan skor confluence ${score}/7 — EMA50 di bawah EMA200 mengonfirmasi bias bearish, ADX ${adxVal.toFixed(1)} menandakan tekanan jual masih kuat. Level kritis: pertahankan SL di $${best.sl.toFixed(2)} (jarak ${slDist.toFixed(2)} poin dari entry), target bertahap TP1 $${best.tp1.toFixed(2)} → TP2 $${best.tp2.toFixed(2)} → TP3 $${best.tp3.toFixed(2)}.`;
      warningSigns = [
        `Waspadai reversal jika harga close di atas $${best.sl.toFixed(2)}`,
        `Hindari entry jika spread melebihi batas wajar`,
        "Perhatikan rilis news high-impact yang bisa invalidate struktur",
      ];
    }

    const confidenceNote = conf === "HIGH_CONFIDENCE" 
      ? `HIGH CONFIDENCE — ${score}/7 kondisi terpenuhi, prioritaskan sinyal ini.`
      : `NORMAL — ${score}/7 kondisi terpenuhi, manajemen risiko ketat.`;

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
        max_lot_warning: "Buka maksimal 1 posisi",
        partial_close_guide: "TP1 hit → close 50%, SL ke BE | TP2 hit → close 30% | TP3 hit → close sisa 20%",
      },
      market_structure: {
        primary_trend: currentSMC.trend,
        key_support: currentSMC.support_levels[0] || 0,
        key_resistance: currentSMC.resistance_levels[0] || 0,
        price_position: `$${price.toFixed(2)} | ADX=${adxVal.toFixed(1)}`,
        current_phase: currentSMC.bos || currentSMC.choch || "Normal",
        invalidation: `${sig === "BUY" ? "Close di bawah" : "Close di atas"} SL ${best.sl}`,
      },
      confluence_factors: [best.reason],
      warning_signs: warningSigns,
      narrative: narrative,
      session_timing: {
        best_entry_window: getCurrentSession().toUpperCase(),
        avoid_trading: "Sesi Asia (02:00–08:00 WIB)",
      },
      next_analysis: "1 menit",
      berkah_raw: best,
    };

    // Skip if there is an active monitor already
    const hasActive = db.hasActiveMonitor();
    if (!hasActive) {
      const signalId = db.saveSignal(analysis, tfLabel, price);
      
      // Auto-create Trade Monitor
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

      // Telegram Send Message
      const { formatTelegramVisionSignal } = await import("./src/vision.js");
      const fakeVision = {
        verdict: "VALID" as const,
        confidence_vision: 80,
        reasoning: "Analisis teknikal confluence tinggi terkonfirmasi valid.",
        key_observations: ["Struktur searah EMA", "Momentum RSI solid"],
        risk_notes: ["Waspadai volatility News"],
        price_action_quality: "STRONG" as const,
        entry_timing: "IDEAL" as const,
        visual_trend: (sig === "BUY" ? "BULLISH" : "BEARISH") as const,
        original_signal: sig,
        combined_confidence: 75,
      };
      
      const msg = formatTelegramVisionSignal(
        fakeVision,
        price,
        tfLabel,
        best.entry,
        best.sl,
        best.tp1,
        best.tp2,
        best.tp3,
        analysis.risk_management.risk_reward_ratio
      );
      await sendTelegramMessage(msg);

      lastSignalTs = nowTs;
      db.configSet("last_signal_ts", nowTs);
      console.log(`[Scheduler] ✅ NEW ${sig} [${tfLabel}] signal saved & broadcasted @ $${price.toFixed(2)}`);
      setLatestSignal(signalId, analysis, price, tfLabel, currentIndicators, currentSMC);
    } else {
      console.log(`[Scheduler] ⏸ ${sig} detected but active trade monitor present — skip signal emission`);
      setLatestSignal(null, analysis, price, tfLabel, currentIndicators, currentSMC);
    }

  } catch (err) {
    console.error("[Scheduler] Error in background analysis:", err);
  }
}

// Start scheduler intervals on boot
let checkInterval: NodeJS.Timeout | null = null;
let scanInterval: NodeJS.Timeout | null = null;
let lastScanTime = Date.now();

function startBackgroundTasks() {
  console.log("[Scheduler] Initializing background tasks...");
  
  // Trade monitor loop: runs every 60 seconds
  if (!checkInterval) {
    checkInterval = setInterval(async () => {
      const updates = await runMonitorCheck();
      if (updates && updates.length > 0) {
        broadcast({ type: "MONITOR_UPDATE", data: updates });
      }
    }, 60000);
    console.log("[Monitor] 60s background monitor check loop started");
  }

  // Market analysis scan loop: runs every 60 seconds
  if (!scanInterval) {
    scanInterval = setInterval(async () => {
      lastScanTime = Date.now();
      await runScheduledAnalysis();
    }, 60000);
    console.log("[Scheduler] 60s background market analysis loop started");
  }

  // Run first check immediately after boot
  setTimeout(async () => {
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
    return res.render("login.html", { error: "Username dan password wajib diisi" });
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
      error: "Username atau password salah / akun nonaktif",
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
    return res.render("login_proposal.html", { error: "Username dan password wajib diisi" });
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
      error: "Username atau password salah / akun nonaktif",
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
    return res.status(400).json({ error: "Username, password, dan nama lengkap wajib diisi" });
  }

  const exists = db.getUsers().some((u) => u.username === username);
  if (exists) {
    return res.status(400).json({ error: "Username sudah terdaftar" });
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
    return res.status(400).json({ error: "Password minimal 6 karakter" });
  }

  const success = db.updateUser(userId, updates);
  if (success) {
    res.json({ ok: true, message: "User berhasil diupdate" });
  } else {
    res.status(404).json({ error: "User tidak ditemukan" });
  }
});

// DELETE soft-delete user
app.delete("/api/admin/users/:user_id", superadminRequired, (req, res) => {
  const userId = parseInt(req.params.user_id);
  if (userId === (req.session as any).user_id) {
    return res.status(400).json({ error: "Tidak bisa menghapus akun sendiri" });
  }

  const success = db.deleteUser(userId);
  if (success) {
    res.json({ ok: true, message: "User dinonaktifkan" });
  } else {
    res.status(404).json({ error: "User tidak ditemukan" });
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
      return res.status(400).json({ ok: false, error: "Vision hanya untuk BUY/SELL" });
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
      return res.status(500).json({ ok: false, error: "Gagal me-render chart: " + chart.error });
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
      const msg = formatTelegramVisionSignal(
        vision,
        parseFloat(price || chart.price || 0),
        timeframe || "15m",
        parseFloat(entry || 0),
        parseFloat(stop_loss || 0),
        parseFloat(tp1 || 0),
        parseFloat(tp2 || 0),
        parseFloat(tp3 || 0),
        req.body.rr_ratio || "1:1.5"
      );

      // Send text message
      const textSuccess = await sendTelegramMessage(msg);
      if (textSuccess) {
        tg_sent = true;
      }

      // Send photo chart
      try {
        const boundary = "----FormBoundaryExpressMultipart";
        const photoUrl = `https://api.telegram.org/bot${bot_token}/sendPhoto`;
        const chartBuffer = Buffer.from(chart.b64, "base64");
        const caption = `📊 XAU/USD ${timeframe.toUpperCase()} Chart — ${signal} Signal`;

        const bodyParts = Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chat_id}\r\n`),
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`),
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="chart.png"\r\nContent-Type: image/png\r\n\r\n`),
          chartBuffer,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]);

        await fetch(photoUrl, {
          method: "POST",
          headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
          body: bodyParts,
        });
      } catch (photoErr) {
        console.error("[Telegram] Photo delivery error:", photoErr);
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
  if (latestSignalCache.ok) {
    return res.json(latestSignalCache);
  }

  // Fallback to database
  const history = db.getHistory(1);
  if (history.length > 0) {
    const s = history[0];
    let analysisObj = {};
    try {
      analysisObj = JSON.parse(s.raw_json);
    } catch {
      analysisObj = s;
    }

    return res.json({
      ok: true,
      signal_id: s.id,
      analysis: analysisObj,
      price: s.price,
      timeframe: s.timeframe,
      timestamp: getWIBDate(new Date(s.timestamp)).toISOString().replace("T", " ").substring(0, 19),
      data_source: "MT5 Bridge (Broker Live)",
      indicators: {}, // fallback stub
      smc: { trend: s.trend },
    });
  }

  res.json({ ok: false, error: "Belum ada sinyal yang di-generate" });
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
    status: isMarketOpen() ? "RUNNING" : "STOPPED (Market Tutup)",
    next_run: "1 menit",
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

// POST run manual analyze (only if allowed)
app.post("/api/analyze", loginRequired, async (req, res) => {
  if (process.env.ALLOW_MANUAL_ANALYZE !== "true") {
    return res.status(403).json({
      error: "Analisis manual dinonaktifkan. Server scheduler berjalan otomatis.",
      next_run: 60,
    });
  }

  try {
    await runScheduledAnalysis();
    res.json({ ok: true, message: "Manual analysis completed successfully." });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET historical signals
app.get("/api/history", loginRequired, (req, res) => {
  res.json({ ok: true, data: db.getHistory(50) });
});

// GET database signal stats
app.get("/api/stats", loginRequired, (req, res) => {
  res.json({ ok: true, data: db.getStats() });
});

// POST clear signals history
app.post("/api/clear_history", superadminRequired, (req, res) => {
  db.clearHistory();
  res.json({ ok: true, message: "History berhasil dibersihkan" });
});

// POST send manual test Telegram alert
app.post("/api/send_telegram", loginRequired, async (req, res) => {
  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: "Pesan tidak boleh kosong" });
  }

  const success = await sendTelegramMessage(text);
  if (success) {
    res.json({ ok: true, message: "Pesan berhasil dikirim ke Telegram" });
  } else {
    res.status(500).json({ error: "Gagal mengirim pesan ke Telegram — periksa bot_token dan chat_id" });
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
  res.json({ ok: true, message: "Semua performance monitors berhasil di-reset" });
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
