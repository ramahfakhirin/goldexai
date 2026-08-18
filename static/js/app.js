/* ── XAU/USD AI Terminal — Frontend JS ── */

// ─── STATE ───────────────────────────────
let apiKey        = "";  // tidak dipakai lagi — server pakai env
let confChart     = null;
let historyData   = [];
let lastSignalId  = null;  // track signal terakhir yang ditampilkan
let pollTimer     = null;  // timer polling /api/latest_signal
let PERF_DAYS     = 7;     // filter periode Trade Performance: 1 (24H) / 7 (7D) / 30 (30D)

// ─── SAFE FETCH HELPER ─────────────────────
async function safeFetchJson(url, options = {}) {
  const opts = { ...options };
  opts.headers = {
    "Accept": "application/json",
    ...(opts.headers || {}),
  };

  const res = await fetch(url, opts);
  const contentType = res.headers.get("content-type") || "";

  if (!contentType.includes("application/json")) {
    if (res.status === 401 || res.status === 403) {
      throw new Error("Sesi login berakhir. Silakan muat ulang halaman atau login kembali.");
    }
    throw new Error(`Server mengembalikan respon non-JSON (${res.status})`);
  }

  const data = await res.json();
  return data;
}

// ─── INIT ────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  startClock();
  loadHistory();
  loadStats();
  loadActiveMonitors();
  loadPerformance();
  loadTradeHistory();
  initPerfFilter();
  loadCalendar(false);

  // Mode baru: semua analisis dari server scheduler
  // Browser hanya polling hasil terbaru
  startServerPolling();
  syncSchedulerCountdown();
});

function initPerfFilter() {
  const filterEl = document.getElementById("perf-filter");
  if (!filterEl) return;
  filterEl.querySelectorAll(".perf-filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const days = parseInt(btn.dataset.days, 10);
      if (!days || days === PERF_DAYS) return;
      PERF_DAYS = days;
      filterEl.querySelectorAll(".perf-filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      loadPerformance();
      loadAnalytics();
    });
  });
}

// ─── CLOCK ───────────────────────────────
function startClock() {
  function tick() {
    const now = new Date();
    document.getElementById("clock").textContent =
      now.toLocaleTimeString("id-ID", { hour12: false });
  }
  tick();
  setInterval(tick, 1000);
}

// ─── API KEY ─────────────────────────────
function saveKey() {
  const val = document.getElementById("api-key-input").value.trim();
  if (!val || !val.startsWith("sk-ant-")) {
    showToast("Invalid API key format (must start with sk-ant-)", "error");
    return;
  }
  apiKey = val;
  localStorage.setItem("xau_api_key", val);
  document.getElementById("key-status").textContent = "✓ API key saved";
  showToast("API key saved!", "success");
}

// ─── TWELVE DATA KEY ─────────────────────
function saveTwelveKey() {
  const val = document.getElementById("twelve-key-input").value.trim();
  if (!val || val.length < 20) {
    showToast("Invalid Twelve Data key format", "error");
    return;
  }
  localStorage.setItem("xau_twelve_key", val);
  document.getElementById("twelve-status").textContent = "✓ Twelve Data key saved";
  showToast("Twelve Data key saved!", "success");
}

// ─── RUN ANALYSIS ────────────────────────
async function runAnalysis() {
  const keyVal = document.getElementById("api-key-input").value.trim() || apiKey;
  if (!keyVal) {
    showToast("Please enter an API key first!", "error");
    return;
  }

  const timeframe = document.getElementById("timeframe-select").value;
  const btn       = document.getElementById("btn-analyze");
  const btnText   = document.getElementById("btn-text");

  btn.disabled = true;
  btnText.textContent = "⏳ ANALYZING...";
  showLoading(true);

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key:     keyVal === "__FROM_SERVER__" ? "" : keyVal,
        timeframe,
        twelve_key:  "", // taken from server env
        use_server_keys: true,
      }),
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || "Analysis failed");
    }

    renderSignal(data);
    renderIndicators(data.indicators, data.price);
    renderSMC(data.smc);
    await loadHistory();
    await loadStats();
    showToast("✓ Analysis successful!", "success");
    // Always refresh monitor & performance after analysis
    loadActiveMonitors();
    loadPerformance();
    loadTradeHistory();

    document.getElementById("topbar-price").textContent =
      "$" + Number(data.price).toLocaleString("en-US", { minimumFractionDigits: 2 });

  } catch (err) {
    showToast("Error: " + err.message, "error");
    console.error(err);
  } finally {
    btn.disabled = false;
    btnText.textContent = "▶ RUN ANALYSIS";
    showLoading(false);
  }
}

// ─── RENDER SIGNAL ───────────────────────
function renderSignal(data) {
  if (!data || !data.analysis) return;   // guard: jangan crash jika data tidak lengkap
  const a   = data.analysis;
  const rm  = a.risk_management || {};
  const ms  = a.market_structure || {};
  const cf  = a.confluence_factors || [];
  const tm  = a.session_timing || {};
  const en  = a.entry || {};

  document.getElementById("signal-empty").style.display  = "none";
  document.getElementById("signal-result").style.display = "block";

  // Badge "data tersimpan" jika dari DB (bukan live cache)
  const fromDbEl = document.getElementById("sig-from-db");
  if (fromDbEl) fromDbEl.style.display = data.from_db ? "inline-block" : "none";

  // Badge
  const badge = document.getElementById("sig-badge");
  badge.textContent  = a.signal || "WAIT";
  badge.className    = "signal-badge " + (a.signal || "WAIT");

  // Signal ID
  const sigIdEl = document.getElementById("sig-id-tag");
  if (sigIdEl) {
    const activeSigId = data.signal_id || a.signal_id;
    if (activeSigId) {
      sigIdEl.textContent = "ID #" + activeSigId;
      sigIdEl.style.display = "inline-block";
    } else {
      sigIdEl.textContent = "ID #-";
      sigIdEl.style.display = "inline-block";
    }
  }

  // Time + price + TF
  document.getElementById("sig-time").textContent  = data.timestamp;
  document.getElementById("sig-price").textContent = "$" + Number(data.price).toLocaleString("en-US", { minimumFractionDigits: 2 });
  document.getElementById("sig-tf").textContent    = "Timeframe: " + data.timeframe.toUpperCase();

  // Display data source info
  const srcBadge = document.getElementById("data-source-badge");
  if (srcBadge) {
    const src      = data.data_source || "";
    const isBridge = src.includes("MT5") || src.includes("BRIDGE");
    const isTwelve = src.includes("Twelve") || src.includes("TWELVE");
    if (isBridge) {
      srcBadge.textContent = "● Live MT5 Broker — Identical Price";
      srcBadge.style.color = "var(--gold)";
    } else if (isTwelve) {
      srcBadge.textContent = "⚡ Twelve Data (Fallback)";
      srcBadge.style.color = "var(--blue, #4c9eff)";
    } else {
      srcBadge.textContent = "⚠ Data Source Offline";
      srcBadge.style.color = "var(--red)";
    }
  }

  // Confidence ring
  const conf  = Number(a.confidence || 0);
  const circ  = 2 * Math.PI * 32; // r=32
  const offset = circ - (conf / 100) * circ;
  document.getElementById("ring-fill").style.strokeDashoffset = offset;
  document.getElementById("ring-fill").setAttribute("stroke-dasharray", circ);
  document.getElementById("sig-conf").textContent = conf + "%";

  // Ring color by confidence
  const ring = document.getElementById("ring-fill");
  ring.style.stroke = conf >= 70 ? "#26c17e" : conf >= 50 ? "#4c9eff" : "#e05252";

  // Risk management
  document.getElementById("rm-entry").textContent      = en.entry_zone || en.ideal_price || "-";
  document.getElementById("rm-entry-type").textContent = en.entry_type || "";
  document.getElementById("rm-sl").textContent         = rm.stop_loss || "-";
  document.getElementById("rm-tp1").textContent        = rm.take_profit_1 || "-";
  document.getElementById("rm-tp2").textContent        = rm.take_profit_2 || "-";
  document.getElementById("rm-tp3").textContent        = rm.take_profit_3 || "-";
  document.getElementById("rm-rr").textContent         = rm.risk_reward_ratio || "-";

  // ── ATR SL Validation ──
  const atrVal   = Number(a.risk_management?.atr_value || 0);
  const slMinDist = Number(a.risk_management?.sl_minimum_distance || 0);
  const slOptDist = Number(a.risk_management?.sl_optimal_distance || 0);
  const entryP   = Number(a.entry?.ideal_price || data.price || 0);
  const slP      = Number(a.risk_management?.stop_loss || 0);
  const banner   = document.getElementById("atr-banner");
  const bannerTx = document.getElementById("atr-banner-text");

  if (banner && bannerTx && slP && entryP && slMinDist) {
    const actualSlDist = Math.abs(entryP - slP);
    if (actualSlDist < slMinDist && a.signal !== "WAIT") {
      banner.style.display = "block";
      bannerTx.textContent =
        `⚠️ Warning: Suggested SL (±$${actualSlDist.toFixed(2)}) ` +
        `is narrower than minimum ATR (±$${slMinDist.toFixed(2)} = 1.5x ATR). ` +
        `Consider widening SL to at least ±$${slOptDist.toFixed(2)} to avoid stop hunts.`;
    } else {
      banner.style.display = "none";
    }
  }

  renderConfluence(a, cf);
  renderNarrativeAndWarnings(a);

  // Timing
  document.getElementById("timing-best").textContent  = tm.best_entry_window || "-";
  document.getElementById("timing-avoid").textContent = tm.avoid_trading || "-";
  document.getElementById("timing-next").textContent  = a.next_analysis || "-";

  document.getElementById("chart-card").style.display = "block";
}

// ─── RENDER CONFLUENCE (bahasa-aware) ──
function renderConfluence(a, cfFallback) {
  const cfList = document.getElementById("cf-list");
  if (!cfList) return;
  const isEn = typeof getCurrentLang === "function" && getCurrentLang() === "en";
  const cf = (isEn && Array.isArray(a?.confluence_factors_en) && a.confluence_factors_en.length)
    ? a.confluence_factors_en
    : (a?.confluence_factors || cfFallback || []);
  cfList.innerHTML = cf.map(f => `<li>${f}</li>`).join("");
}

// ─── RENDER NARRATIVE + WARNINGS (bahasa-aware) ──
// Dipisah dari renderSignal supaya bisa dipanggil ulang saat toggle bahasa
// berubah, tanpa perlu menunggu poll /api/latest_signal berikutnya.
function renderNarrativeAndWarnings(a) {
  if (!a) return;
  const isEn = typeof getCurrentLang === "function" && getCurrentLang() === "en";

  // Narrative — pakai versi EN kalau ada & bahasa saat ini EN, fallback ke ID
  let narrativeText = (isEn && a.narrative_en) ? a.narrative_en : (a.narrative || "-");
  if (narrativeText.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(narrativeText);
      narrativeText = parsed.narrative || narrativeText;
    } catch(e) {
      const m = narrativeText.match(/"narrative"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) narrativeText = m[1].replace(/\\"/g, '"').replace(/\\n/g, ' ');
    }
  }
  narrativeText = narrativeText.replace(/\\n/g, ' ').replace(/\\"/g, '"').trim();
  const narrEl = document.getElementById("sig-narrative");
  if (narrEl) narrEl.textContent = narrativeText;

  // Warnings — sama, pakai versi EN kalau tersedia & bahasa aktif EN
  const wrn = (isEn && Array.isArray(a.warning_signs_en) && a.warning_signs_en.length)
    ? a.warning_signs_en
    : (a.warning_signs || []);
  const warnList = document.getElementById("warn-list");
  if (warnList) warnList.innerHTML = wrn.map(w => `<li>${w}</li>`).join("");
}

document.addEventListener("langchange", () => {
  if (window._lastSignalData) {
    renderConfluence(window._lastSignalData);
    renderNarrativeAndWarnings(window._lastSignalData);
  }
});

// ─── RENDER INDICATORS ───────────────────
function renderIndicators(ind, price) {
  if (!ind) return;
  document.getElementById("indicators-card").style.display = "block";

  document.getElementById("ind-ema21").textContent  = Number(ind.ema_21).toFixed(2);
  document.getElementById("ind-ema50").textContent  = Number(ind.ema_50).toFixed(2);
  const ema55El = document.getElementById("ind-ema55");
  if (ema55El) ema55El.textContent = Number(ind.ema_55 || 0).toFixed(2);
  document.getElementById("ind-ema200").textContent = Number(ind.ema_200).toFixed(2);
  document.getElementById("ind-rsi").textContent    = Number(ind.rsi).toFixed(2);
  document.getElementById("ind-macd").textContent   = Number(ind.macd).toFixed(4);
  document.getElementById("ind-macd-sig").textContent = Number(ind.macd_signal).toFixed(4);
  document.getElementById("ind-atr").textContent    = Number(ind.atr).toFixed(2);

  // EMA badge
  const emaBadge = document.getElementById("ind-ema21-badge");
  if (price > ind.ema_21) {
    emaBadge.textContent = "BULL"; emaBadge.className = "ind-badge bull";
  } else {
    emaBadge.textContent = "BEAR"; emaBadge.className = "ind-badge bear";
  }

  // RSI badge
  const rsiBadge = document.getElementById("ind-rsi-badge");
  const rsi = Number(ind.rsi);
  if (rsi > 70) {
    rsiBadge.textContent = "OB"; rsiBadge.className = "ind-badge ob";
  } else if (rsi < 30) {
    rsiBadge.textContent = "OS"; rsiBadge.className = "ind-badge os";
  } else {
    rsiBadge.textContent = "NEU"; rsiBadge.className = "ind-badge neu";
  }

  // Heiken Ashi Badge
  const haEl    = document.getElementById("ind-ha-bias");
  const haBadge = document.getElementById("ind-ha-badge");
  if (haEl && ind.ha_bias) {
    haEl.textContent = ind.ha_bias + (ind.ha_strength ? " (" + ind.ha_strength + ")" : "");
    haEl.style.color = ind.ha_bias === "BULLISH" ? "var(--green)"
                     : ind.ha_bias === "BEARISH" ? "var(--red)"
                     : "var(--text-sec)";
    if (haBadge) {
      haBadge.textContent = ind.ha_bias === "BULLISH" ? "↑" : ind.ha_bias === "BEARISH" ? "↓" : "→";
      haBadge.className   = "ind-badge " + (ind.ha_bias === "BULLISH" ? "bull" : ind.ha_bias === "BEARISH" ? "bear" : "neu");
    }
  }

  // ATR Risk Meter
  const atr = Number(ind.atr || 0);
  if (atr > 0) {
    const slMin = (atr * 1.5).toFixed(2);
    const slOpt = (atr * 2.0).toFixed(2);
    const elMin = document.getElementById("atr-sl-min");
    const elOpt = document.getElementById("atr-sl-opt");
    if (elMin) elMin.textContent = `±$${slMin}`;
    if (elOpt) elOpt.textContent = `±$${slOpt}`;
  }
}

// ─── RENDER SMC ──────────────────────────
function renderSMC(smc) {
  if (!smc) return;
  document.getElementById("smc-card").style.display = "block";

  const trendEl = document.getElementById("smc-trend");
  trendEl.textContent = smc.trend || "-";
  trendEl.className   = "smc-trend " + (smc.trend || "RANGING");

  document.getElementById("smc-sh").textContent   = smc.swing_high || "-";
  document.getElementById("smc-sl").textContent   = smc.swing_low  || "-";
  document.getElementById("smc-bos").textContent  = smc.bos   || "NONE";
  document.getElementById("smc-choch").textContent= smc.choch || "NONE";

  // FVG zones
  const fvgList = document.getElementById("fvg-list");
  if (smc.fvg_zones && smc.fvg_zones.length) {
    fvgList.innerHTML = smc.fvg_zones.slice(0, 4).map(z => {
      const cls = z.type && z.type.includes("BULLISH") ? "bull" : "bear";
      return `<div class="zone-tag ${cls}">
        <span>${z.type || "FVG"}</span>
        <span>${z.low}–${z.high}</span>
      </div>`;
    }).join("");
  } else {
    fvgList.innerHTML = "<div class='history-empty'>No FVG zones</div>";
  }
}

// ─── HISTORY ─────────────────────────────
const HISTORY_PAGE_SIZE = 10;
let historyPage  = 1;
let historyTotal = 0;

async function loadHistory() {
  // Confidence chart selalu pakai signal terbaru keseluruhan, terlepas dari
  // halaman/filter yang lagi dibuka di daftar history — supaya tetap
  // menunjukkan tren terkini, bukan ikut ter-paginate.
  try {
    const chartRes  = await fetch(`/api/history?limit=20&filter=ALL`);
    const chartResp = await chartRes.json();
    if (chartResp.ok) renderConfChart(chartResp.data);
  } catch (e) {
    console.error("Failed to load chart data:", e);
  }

  await loadHistoryPage();
}

async function loadHistoryPage() {
  try {
    const filterParam = historyFilter || "TRADE";
    const offset = (historyPage - 1) * HISTORY_PAGE_SIZE;
    const res  = await fetch(`/api/history?limit=${HISTORY_PAGE_SIZE}&offset=${offset}&filter=${filterParam}`);
    const data = await res.json();
    if (!data.ok) return;

    historyData  = data.data;
    historyTotal = data.total || 0;
    renderHistory(historyData);
  } catch (e) {
    console.error("Failed to load history:", e);
  }
}

function goToHistoryPage(page) {
  const maxPage = Math.max(1, Math.ceil(historyTotal / HISTORY_PAGE_SIZE));
  historyPage = Math.min(Math.max(1, page), maxPage);
  loadHistoryPage();
}

// PnL Multiplier based on lot (sent by backend via /api/performance).
// Default 10 = 0.10 lot XAUUSD ($10 per point). DB data remains raw points.
let PNL_MULT = 10;
let PNL_LOT  = 0.10;

// Active filter for Signal History — default ALL so all recent signals are loaded
let historyFilter = "ALL"; // TRADE | ALL | BUY | SELL | WAIT

function setHistoryFilter(mode) {
  historyFilter = mode;
  historyPage = 1;
  loadHistoryPage();
}

function renderHistory(items) {
  const el = document.getElementById("history-list");
  if (!el) return;

  // ── Dedup: remove consecutive identical entries (same signal+price+minute) ──
  const deduped = [];
  let prevKey = "";
  (items || []).forEach(item => {
    const key = `${item.signal}|${item.price}|${String(item.timestamp).slice(0, 16)}`;
    if (key !== prevKey) deduped.push(item);
    prevKey = key;
  });

  // ── Filter according to active chip ──
  const filtered = deduped.filter(item => {
    if (historyFilter === "ALL")   return true;
    if (historyFilter === "TRADE") return item.signal === "BUY" || item.signal === "SELL";
    return item.signal === historyFilter;
  });

  const waitCount  = deduped.filter(i => i.signal === "WAIT").length;
  const chip = (mode, label) =>
    `<button class="hist-chip ${historyFilter === mode ? "active" : ""}"
       onclick="setHistoryFilter('${mode}')">${label}</button>`;

  const chipsHtml = `
    <div class="hist-chips">
      ${chip("TRADE", "Signal")}
      ${chip("BUY",  "BUY")}
      ${chip("SELL", "SELL")}
      ${chip("WAIT", `WAIT (${waitCount})`)}
      ${chip("ALL",  "All")}
    </div>`;

  if (!filtered.length) {
    const emptyMsg = historyFilter === "TRADE" || historyFilter === "BUY" || historyFilter === "SELL"
      ? "No trade signals yet — engine waiting for quality setup"
      : "No entries found";
    el.innerHTML = chipsHtml + `<div class="history-empty">${emptyMsg}</div>`;
    syncHistoryToMobile();
    return;
  }

  const itemsHtml = filtered.map(item => {
    const ts     = new Date(item.timestamp).toLocaleString("id-ID");
    const price  = Number(item.price).toLocaleString("en-US", { minimumFractionDigits: 2 });
    const isWait = item.signal === "WAIT";
    const sigIdTag = item.id ? `<span class="hist-id-tag" style="font-size:11px; font-weight:700; color:var(--gold,#f1c40f); margin-left:6px; background:rgba(241,196,15,0.12); border:1px solid rgba(241,196,15,0.3); padding:1px 5px; border-radius:3px; vertical-align:middle;">#${item.id}</span>` : '';
    // WAIT tidak punya confidence bermakna — jangan tampilkan "0%"
    const confHtml = isWait
      ? `<span class="hist-conf muted">standby</span>`
      : `<span class="hist-conf">${item.confidence}%</span>`;
    return `
    <div class="history-item ${item.signal}${isWait ? " is-wait" : ""}" onclick="showHistoryDetail(${item.id})">
      <div class="hist-row1">
        <span class="hist-signal ${item.signal}">${item.signal}</span>
        ${sigIdTag}
        <span class="hist-price">$${price}</span>
      </div>
      <div class="hist-row2">
        <span class="hist-time">${ts}</span>
        <span class="hist-tf">${item.timeframe}</span>
        ${confHtml}
      </div>
    </div>`;
  }).join("");

  el.innerHTML = chipsHtml + itemsHtml + renderHistoryPagination();

  syncHistoryToMobile();
}

// ─── HISTORY PAGINATION ──────────────────
function renderHistoryPagination() {
  if (historyTotal <= HISTORY_PAGE_SIZE) return ""; // muat semua di satu halaman, tak perlu kontrol

  const maxPage = Math.max(1, Math.ceil(historyTotal / HISTORY_PAGE_SIZE));
  const page    = historyPage;
  const from    = (page - 1) * HISTORY_PAGE_SIZE + 1;
  const to      = Math.min(page * HISTORY_PAGE_SIZE, historyTotal);

  return `
    <div class="hist-pagination">
      <button class="hist-page-btn" ${page <= 1 ? "disabled" : ""} onclick="goToHistoryPage(${page - 1})">‹ Prev</button>
      <span class="hist-page-info">${from}–${to} of ${historyTotal} · Page ${page}/${maxPage}</span>
      <button class="hist-page-btn" ${page >= maxPage ? "disabled" : ""} onclick="goToHistoryPage(${page + 1})">Next ›</button>
    </div>`;
}

// Salin isi history desktop → mobile (chips ikut tersalin, onclick tetap jalan)
function syncHistoryToMobile() {
  const src  = document.getElementById("history-list");
  const dest = document.getElementById("m-history-list");
  if (src && dest) dest.innerHTML = src.innerHTML;
}

function showHistoryDetail(id) {
  const item = historyData.find(h => h.id === id);
  if (!item || !item.raw_json) return;
  try {
    const raw = JSON.parse(item.raw_json);
    // Re-render signal with history data
    const fakeResp = {
      signal_id:  item.id,
      analysis:   raw,
      price:      item.price,
      timeframe:  item.timeframe,
      timestamp:  new Date(item.timestamp).toLocaleString("en-US"),
      data_source: "Database Record #" + item.id,
      from_db:    true,
      indicators: raw.indicators || {},
      smc:        raw.smc || {},
    };
    renderSignal(fakeResp);
    showToast("Displaying signal ID #" + id);
  } catch (e) {
    showToast("Failed to load details", "error");
  }
}

// ─── CHART ───────────────────────────────
function renderConfChart(items) {
  if (!items.length) return;

  const labels = items.slice(0, 20).reverse().map((_, i) => "#" + (i + 1));
  const confs  = items.slice(0, 20).reverse().map(i => i.confidence);
  const colors = items.slice(0, 20).reverse().map(i =>
    i.signal === "BUY"  ? "#26c17e" :
    i.signal === "SELL" ? "#e05252" : "#f0b429"
  );

  const ctx = document.getElementById("conf-chart");
  if (!ctx) return;

  if (confChart) confChart.destroy();

  confChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        data: confs,
        backgroundColor: colors.map(c => c + "88"),
        borderColor: colors,
        borderWidth: 1,
        borderRadius: 3,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => "Confidence: " + ctx.raw + "%",
          },
          backgroundColor: "#1e2130",
          borderColor: "#252836",
          borderWidth: 1,
          titleColor: "#7b8099",
          bodyColor: "#e8eaf0",
        },
      },
      scales: {
        x: {
          grid: { color: "#252836" },
          ticks: { color: "#454860", font: { family: "'JetBrains Mono'" } },
        },
        y: {
          min: 0,
          max: 100,
          grid: { color: "#252836" },
          ticks: { color: "#454860", font: { family: "'JetBrains Mono'" }, callback: v => v + "%" },
        },
      },
    },
  });
}

// ─── STATS ───────────────────────────────
let lastKnownMartingaleMult = null;  // null = belum pernah dicek

function renderMartingaleBadge(mult) {
  const isActive = mult > 1;
  const label = isActive ? `🔥 Martingale ${mult}x Active` : "🛡 Normal Risk 1x";

  [["mart-bar", "mart-status"], ["m-mart-bar", "m-mart-status"]].forEach(([barId, statusId]) => {
    const bar    = document.getElementById(barId);
    const status = document.getElementById(statusId);
    if (bar)    bar.classList.toggle("active", isActive);
    if (status) status.textContent = label;
  });

  // Notifikasi hanya saat multiplier BERUBAH (naik/turun), bukan tiap poll
  if (lastKnownMartingaleMult !== null && mult !== lastKnownMartingaleMult) {
    if (mult > lastKnownMartingaleMult) {
      showToast(`🔥 Martingale ${mult}x Active — lot digandakan setelah rentetan loss`, "error");
    } else if (mult === 1) {
      showToast("🛡 Risk kembali normal (1x)", "success");
    }
  }
  lastKnownMartingaleMult = mult;
}

async function loadStats() {
  const statTotalEl = document.getElementById("stat-total");
  if (!statTotalEl) return; // Stats card only exists on the dashboard page
  try {
    const res  = await fetch("/api/stats");
    const data = await res.json();
    if (!data.ok) return;
    const s = data.data;
    statTotalEl.textContent = s.total;
    document.getElementById("stat-buy").textContent   = s.buy;
    document.getElementById("stat-sell").textContent  = s.sell;
    document.getElementById("stat-wait").textContent  = s.wait;
    document.getElementById("stat-conf").textContent  = s.avg_confidence + "%";
    renderMartingaleBadge(Number(s.martingale_mult || 1));
    // Sync ke mobile sections
    if (window.innerWidth <= 768) {
      const mf = { "m-stat-total": s.total, "m-stat-buy": s.buy,
                   "m-stat-sell": s.sell, "m-stat-wait": s.wait,
                   "m-stat-conf": s.avg_confidence + "%" };
      Object.entries(mf).forEach(([id, val]) => {
        const el = document.getElementById(id); if (el) el.textContent = val;
      });
    }
  } catch (e) {
    console.error("Gagal load stats:", e);
  }
}

// ─── CLEAR HISTORY ────────────────────────
async function clearHistory() {
  if (!confirm("Delete all signal history?")) return;
  try {
    await fetch("/api/clear_history", { method: "POST" });
    historyData  = [];
    historyPage  = 1;
    historyTotal = 0;
    renderHistory([]);
    if (confChart) { confChart.destroy(); confChart = null; }
    document.getElementById("chart-card").style.display = "none";
    await loadStats();
    showToast("History deleted", "success");
  } catch (e) {
    showToast("Failed to delete history", "error");
  }
}

// ─── LOADING ─────────────────────────────
function showLoading(show) {
  document.getElementById("loading").style.display = show ? "flex" : "none";
  if (show) animateLoadingSteps();
}

function animateLoadingSteps() {
  const steps   = ["ls1", "ls2", "ls3", "ls4"];
  const delays  = [0, 1200, 2500, 4000];
  steps.forEach(id => {
    const el = document.getElementById(id);
    el.className = "lstep";
  });
  steps.forEach((id, i) => {
    setTimeout(() => {
      if (i > 0) {
        document.getElementById(steps[i-1]).className = "lstep done";
      }
      document.getElementById(id).className = "lstep active";
    }, delays[i]);
  });
}

// ─── TOAST ───────────────────────────────
let toastTimer = null;
function showToast(msg, type = "") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className   = "toast show " + type;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast"; }, 3000);
}

// ═══════════════════════════════════════════════
// AUTO-REFRESH + SMART PAUSE + TELEGRAM
// ═══════════════════════════════════════════════

// ─── AUTO-REFRESH STATE ──────────────────────
let autoTimer        = null;   // setInterval handle
let countdownTimer   = null;   // countdown tick
let countdownSec     = 0;      // detik tersisa
let totalSec         = 0;      // total interval detik
let waitStreak       = 0;      // berapa kali WAIT berturut-turut
let smartPauseActive = false;
let smartPauseTimer  = null;
const WAIT_STREAK_LIMIT = 2;   // WAIT berturut-turut sebelum smart pause
const SMART_PAUSE_SEC   = 30 * 60; // 30 menit dalam detik
const DEFAULT_INTERVAL_MIN = 5;     // default interval auto-refresh

// ─── INIT TAMBAHAN ───────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // Load telegram config
  const tgToken = localStorage.getItem("xau_tg_token") || "";
  const tgChat  = localStorage.getItem("xau_tg_chat")  || "";
  if (tgToken) document.getElementById("tg-token").value = tgToken;
  if (tgChat)  document.getElementById("tg-chat").value  = tgChat;
  if (tgToken && tgChat) {
    document.getElementById("tg-status").textContent = "✓ Telegram saved";
  }
});

// ─── AUTO-REFRESH TOGGLE ─────────────────────
function toggleAuto() {
  const on = document.getElementById("auto-toggle").checked;
  if (on) startAutoRefresh(true);   // true = analyze immediately on user toggle
  else    stopAutoRefresh();
}

function startAutoRefresh(runImmediately = true) {
  const minutes = parseInt(document.getElementById("auto-interval").value);
  totalSec      = minutes * 60;
  countdownSec  = totalSec;
  waitStreak    = 0;
  smartPauseActive = false;

  document.getElementById("auto-status").innerHTML =
    `<span class="auto-active">● Auto mode ON — every ${minutes} minutes</span>`;
  document.getElementById("countdown-wrap").style.display = "block";
  document.getElementById("smart-pause-info").style.display = "none";

  // Only analyze immediately if requested (manual toggle by user)
  if (runImmediately) {
    runAnalysis().then(result => {
      if (result) handleAutoResult(result);
    });
  }

  // Clear old timer if exists
  if (autoTimer) clearInterval(autoTimer);

  // Set interval
  autoTimer = setInterval(async () => {
    if (smartPauseActive) return;
    const result = await runAnalysis();
    if (result) handleAutoResult(result);
    startCountdown(totalSec);
  }, totalSec * 1000);

  // Start countdown tick
  startCountdown(totalSec);
}

function stopAutoRefresh() {
  clearInterval(autoTimer);
  clearInterval(countdownTimer);
  clearTimeout(smartPauseTimer);
  autoTimer = countdownTimer = smartPauseTimer = null;
  smartPauseActive = false;
  waitStreak = 0;

  document.getElementById("auto-status").innerHTML =
    `<span class="auto-idle">● Idle — Auto mode off</span>`;
  document.getElementById("countdown-wrap").style.display  = "none";
  document.getElementById("smart-pause-info").style.display = "none";
}

function startCountdown(sec) {
  clearInterval(countdownTimer);
  countdownSec = sec;
  updateCountdownUI();

  countdownTimer = setInterval(() => {
    countdownSec--;
    if (countdownSec <= 0) countdownSec = 0;
    updateCountdownUI();
  }, 1000);
}

function updateCountdownUI() {
  const m = String(Math.floor(countdownSec / 60)).padStart(2, "0");
  const s = String(countdownSec % 60).padStart(2, "0");
  const el = document.getElementById("countdown-val");
  const bar = document.getElementById("countdown-bar");
  if (el)  el.textContent = `${m}:${s}`;
  if (bar) bar.style.width = ((countdownSec / totalSec) * 100) + "%";
}

// ─── HANDLE AUTO ANALYSIS RESULT ──────────────
function handleAutoResult(data) {
  const signal = data?.analysis?.signal || "WAIT";

  // Reset countdown
  startCountdown(totalSec);

  if (signal === "WAIT") {
    waitStreak++;
    if (waitStreak >= WAIT_STREAK_LIMIT && !smartPauseActive) {
      activateSmartPause();
      return;
    }
    // Refresh monitor status during WAIT
    loadActiveMonitors();
    loadPerformance();
  } else {
    // BUY or SELL
    waitStreak = 0;

    if (data.already_active) {
      // Active monitor exists — skip generating new signal regardless of direction
      showToast(`⏸ Active position exists — waiting for TP/SL before new signal`, "");
      loadActiveMonitors();
      loadPerformance();
      return;
    }

    // NEW Signal — trigger Vision confirmation
    playAlertSound(signal);
    showToast(`🔍 NEW ${signal} signal — running Vision AI...`, signal === "BUY" ? "success" : "error");

    triggerVisionConfirm(data).then(vision => {
      if (vision) {
        renderVisionResult(vision);
        if (vision.verdict === "VALID") {
          playAlertSound(signal);
          showToast(`✅ Vision VALID — ${signal} ${vision.combined_confidence}%`, signal === "BUY" ? "success" : "error");
        } else {
          showToast(`⏳ Vision: ${vision.verdict.replace("_"," ")} — skipping entry`, "");
        }
      }
      loadActiveMonitors();
      loadPerformance();
    });
  }
}

// ─── SMART PAUSE ─────────────────────────────
function activateSmartPause() {
  smartPauseActive = true;
  clearInterval(countdownTimer);

  document.getElementById("smart-pause-info").style.display = "block";
  document.getElementById("auto-status").innerHTML =
    `<span class="auto-paused">⏸ Smart pause — resuming in 30 minutes</span>`;

  // Countdown smart pause
  totalSec     = SMART_PAUSE_SEC;
  startCountdown(SMART_PAUSE_SEC);

  smartPauseTimer = setTimeout(() => {
    smartPauseActive = false;
    waitStreak       = 0;
    document.getElementById("smart-pause-info").style.display = "none";

    const minutes = parseInt(document.getElementById("auto-interval").value);
    totalSec = minutes * 60;

    document.getElementById("auto-status").innerHTML =
      `<span class="auto-active">● Auto mode ON — every ${minutes} minutes</span>`;

    // Analyze immediately after pause completes
    runAnalysis().then(result => {
      if (result) handleAutoResult(result);
      startCountdown(totalSec);
    });

  }, SMART_PAUSE_SEC * 1000);
}

// ─── AUDIO ALERT ─────────────────────────────
function playAlertSound(signal) {
  try {
    const ctx  = new (window.AudioContext || window.webkitAudioContext)();
    const freq  = signal === "BUY" ? 880 : 440;
    const notes = signal === "BUY"
      ? [freq, freq * 1.25, freq * 1.5]   // BUY: ascending (optimis)
      : [freq * 1.5, freq * 1.25, freq];  // SELL: descending (waspada)

    notes.forEach((f, i) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = f;
      osc.type = "sine";
      gain.gain.setValueAtTime(0.3, ctx.currentTime + i * 0.15);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.15 + 0.3);
      osc.start(ctx.currentTime + i * 0.15);
      osc.stop(ctx.currentTime + i * 0.15 + 0.3);
    });
  } catch (e) {
    console.warn("Audio alert tidak bisa diputar:", e);
  }
}

// ─── TELEGRAM CONFIG ─────────────────────────
function saveTelegram() {
  const token = document.getElementById("tg-token").value.trim();
  const chat  = document.getElementById("tg-chat").value.trim();

  if (!token || !chat) {
    showToast("Bot Token and Chat ID are required!", "error");
    return;
  }
  if (!token.includes(":")) {
    showToast("Invalid Bot Token format!", "error");
    return;
  }

  localStorage.setItem("xau_tg_token", token);
  localStorage.setItem("xau_tg_chat",  chat);
  document.getElementById("tg-status").textContent = "✓ Telegram saved";
  showToast("Telegram configuration saved!", "success");
}

async function testTelegram() {
  const token = localStorage.getItem("xau_tg_token") ||
                document.getElementById("tg-token").value.trim();
  const chat  = localStorage.getItem("xau_tg_chat") ||
                document.getElementById("tg-chat").value.trim();

  if (!token || !chat) {
    showToast("Save Telegram configuration first!", "error");
    return;
  }

  const msg = `🤖 <b>XAU/USD AI Terminal</b>\n\n` +
    `✅ Notification test successful!\n` +
    `🕐 ${new Date().toLocaleString("en-US")}\n\n` +
    `Your dashboard is now connected to Telegram.`;

  await sendTelegramRaw(token, chat, msg);
}

// ─── SEND SIGNAL TO TELEGRAM ────────────────
async function sendTelegramSignal(data) {
  const token = localStorage.getItem("xau_tg_token") || "";
  const chat  = localStorage.getItem("xau_tg_chat")  || "";
  if (!token || !chat) return;

  const a      = data.analysis || {};
  const rm     = a.risk_management || {};
  const signal = a.signal  || "WAIT";
  const conf   = a.confidence || 0;
  const price  = data.price || 0;
  const tf     = (data.timeframe || "").toUpperCase();

  // Check notification preferences
  const notifyBuy  = document.getElementById("tg-buy")?.checked;
  const notifySell = document.getElementById("tg-sell")?.checked;
  const notifyWait = document.getElementById("tg-wait")?.checked;

  if (signal === "BUY"  && !notifyBuy)  return;
  if (signal === "SELL" && !notifySell) return;
  if (signal === "WAIT" && !notifyWait) return;

  const emoji = signal === "BUY" ? "🟢" : signal === "SELL" ? "🔴" : "🟡";
  const time  = new Date().toLocaleString("en-US");

  const msg =
    `${emoji} <b>XAU/USD ${signal}</b> — ${tf}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `💰 Price    : <b>$${Number(price).toLocaleString("en-US", {minimumFractionDigits: 2})}</b>\n` +
    `🎯 Entry    : ${a.entry?.entry_zone || a.entry?.ideal_price || "-"}\n` +
    `🛑 SL       : ${rm.stop_loss || "-"}\n` +
    `✅ TP1      : ${rm.take_profit_1 || "-"}\n` +
    `✅ TP2      : ${rm.take_profit_2 || "-"}\n` +
    `✅ TP3      : ${rm.take_profit_3 || "-"}\n` +
    `📊 RR       : ${rm.risk_reward_ratio || "-"}\n` +
    `🔥 Conf.    : ${conf}%\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `📝 ${a.narrative ? a.narrative.substring(0, 200) + "..." : "-"}\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `🕐 ${time}`;

  await sendTelegramRaw(token, chat, msg);
}

// ─── MANUAL SIGNAL & TELEGRAM CONTROL FUNCTIONS ────────────────
async function triggerManualAnalysis() {
  showToast("⏳ Running market analysis & preparing signal broadcast...", "info");
  try {
    const data = await safeFetchJson("/api/analyze", { method: "POST" });
    if (data.ok) {
      showToast("✅ Market analysis completed & broadcasted!", "success");
      if (typeof loadLatestSignal === "function") loadLatestSignal();
    } else {
      showToast("⚠️ " + (data.error || "Analysis failed"), "error");
    }
  } catch (e) {
    showToast("❌ Connection error: " + e.message, "error");
  }
}

async function broadcastLatestSignal() {
  showToast("⏳ Sending active signal to Telegram...", "info");
  try {
    const data = await safeFetchJson("/api/broadcast_latest_signal", { method: "POST" });
    if (data.ok) {
      showToast(data.message || "✅ Signal sent to Telegram!", "success");
    } else {
      showToast("⚠️ " + (data.error || "Broadcast failed"), "error");
    }
  } catch (e) {
    showToast("❌ Connection error: " + e.message, "error");
  }
}

async function dispatchManualSignal() {
  const signal = prompt("Masukkan jenis sinyal (BUY atau SELL):", "BUY");
  if (!signal) return;
  
  const currentPriceText = document.getElementById("dt-price")?.textContent?.replace("$","") || "2385.00";
  const defaultPrice = parseFloat(currentPriceText) || 2385.00;

  const priceStr = prompt("Masukkan Current Price ($):", defaultPrice.toFixed(2));
  if (!priceStr) return;
  
  const slStr = prompt("Masukkan Stop Loss ($):", (signal.toUpperCase() === "BUY" ? defaultPrice - 5 : defaultPrice + 5).toFixed(2));
  if (!slStr) return;

  const tp1Str = prompt("Masukkan Take Profit 1 ($):", (signal.toUpperCase() === "BUY" ? defaultPrice + 8 : defaultPrice - 8).toFixed(2));
  if (!tp1Str) return;

  const tp2Str = prompt("Masukkan Take Profit 2 ($) (opsional):", (signal.toUpperCase() === "BUY" ? defaultPrice + 15 : defaultPrice - 15).toFixed(2));
  const tp3Str = prompt("Masukkan Take Profit 3 ($) (opsional):", (signal.toUpperCase() === "BUY" ? defaultPrice + 25 : defaultPrice - 25).toFixed(2));
  const narrative = prompt("Catatan / Alasan Analisis:", "Manual signal dispatched from GOLDEX AI Terminal.");

  showToast("⏳ Dispatching manual signal to Dashboard & Telegram...", "info");
  try {
    const data = await safeFetchJson("/api/dispatch_manual_signal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signal,
        price: parseFloat(priceStr),
        stop_loss: parseFloat(slStr),
        tp1: parseFloat(tp1Str),
        tp2: tp2Str ? parseFloat(tp2Str) : undefined,
        tp3: tp3Str ? parseFloat(tp3Str) : undefined,
        narrative,
        timeframe: "5m"
      })
    });
    if (data.ok) {
      showToast("🎉 " + data.message, "success");
      if (typeof loadLatestSignal === "function") loadLatestSignal();
    } else {
      showToast("⚠️ " + (data.error || "Failed to dispatch manual signal"), "error");
    }
  } catch (e) {
    showToast("❌ Connection error: " + e.message, "error");
  }
}

async function sendTelegramRaw(token, chat, message) {
  try {
    const data = await safeFetchJson("/api/send_telegram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bot_token: token, chat_id: chat, message }),
    });
    if (data.ok) {
      showToast("✓ Telegram message sent!", "success");
    } else {
      showToast("Telegram error: " + (data.error || "Unknown"), "error");
    }
  } catch (e) {
    showToast("Failed to send Telegram message: " + e.message, "error");
  }
}

// ═══════════════════════════════════════════════
// TRADE MONITOR + PERFORMANCE
// ═══════════════════════════════════════════════

let monitorInterval  = null;
const MONITOR_TICK_MS = 60 * 1000; // check every 1 minute

// ─── START MONITOR ENGINE ────────────────────
function startMonitorEngine() {
  if (monitorInterval) return;
  checkMonitors(); // check immediately
  monitorInterval = setInterval(checkMonitors, MONITOR_TICK_MS);
}

// ─── CHECK MONITORS ──────────────────────────
async function checkMonitors() {
  const twelveKey = localStorage.getItem("xau_twelve_key") || "";
  const tgToken   = localStorage.getItem("xau_tg_token")  || "";
  const tgChat    = localStorage.getItem("xau_tg_chat")   || "";

  try {
    const res  = await fetch("/api/check_monitors", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        twelve_key:      "",  // server env
        use_server_keys: true,
        bot_token:  tgToken,
        chat_id:    tgChat,
      }),
    });
    const data = await res.json();
    if (!data.ok) return;

    // If updates exist — refresh UI
    if (data.updates && data.updates.length > 0) {
      data.updates.forEach(u => {
        const pnl   = Number(u.pnl_usd ?? (Number(u.pnl_pips || 0) * PNL_MULT));
        const isBE  = u.outcome === "BE_HIT";
        const isWin = pnl > 0;
        const emoji = isWin ? "✅" : isBE ? "⚖️" : "🛑";
        const label = u.outcome === "SL_HIT" ? "STOP LOSS"
                    : u.outcome === "BE_HIT" ? "BREAKEVEN"
                    : u.outcome.replace("_", " ");
        showToast(
          `${emoji} ${u.direction} ${label} — ` +
          `${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toFixed(2)}`,
          isWin ? "success" : isBE ? "info" : "error"
        );
      });
      await loadTradeHistory();
      await loadPerformance();
      loadAnalytics();
    }

    // Update monitor list UI
    await loadActiveMonitors();

  } catch (e) {
    console.error("Monitor check error:", e);
  }
}

// ─── LOAD ACTIVE MONITORS ────────────────────
let _monitorPnlTimer = null;  // live P&L refresh timer

async function loadActiveMonitors() {
  try {
    const res  = await fetch("/api/active_monitors");
    const data = await res.json();
    if (!data.ok) return;

    const monitors = data.data || [];
    const countEl  = document.getElementById("monitor-count");
    const listEl   = document.getElementById("monitor-list");
    if (!listEl) return;

    if (countEl) countEl.textContent = monitors.length + " active";

    if (!monitors.length) {
      listEl.innerHTML = '<div class="history-empty">No positions monitored</div>';
      // Stop live P&L timer if no monitors
      if (_monitorPnlTimer) { clearInterval(_monitorPnlTimer); _monitorPnlTimer = null; }
      return;
    }

    // Render monitor cards with P&L placeholder first
    function renderMonitorCards(currentPrice) {
      listEl.innerHTML = monitors.map(m => {
        const dir    = m.direction;
        const entry  = Number(m.entry_price);
        const sl     = Number(m.stop_loss);
        const tp1    = Number(m.tp1 || 0);
        const tp2    = Number(m.tp2 || 0);
        const tp3    = Number(m.tp3 || 0);
        const mult   = Number(m.martingale_mult) || 1;
        const ts     = new Date(m.timestamp).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

        const livePnl = currentPrice
          ? (dir === "BUY" ? currentPrice - entry : entry - currentPrice) * PNL_MULT * mult
          : null;

        // Calculate running duration
        const elapsed = m.timestamp
          ? Math.floor((Date.now() - new Date(m.timestamp).getTime()) / 60000)
          : 0;
        const elapsedStr = elapsed < 60
          ? elapsed + " m"
          : Math.floor(elapsed / 60) + "h " + (elapsed % 60) + "m";

        const pnlStr = livePnl !== null
          ? `${livePnl >= 0 ? "+" : ""}$${livePnl.toFixed(2)}`
          : "...";
        const pnlCls = livePnl !== null ? (livePnl >= 0 ? "pos" : "neg") : "";

        // TP status badge
        const tpHit = m.tp_hit || 0;
        const tpBadge = tpHit > 0
          ? `<span class="tp-badge">TP${tpHit} ✓</span>`
          : "";
        const martBadge = mult > 1
          ? `<span class="tp-badge" style="background:rgba(241,196,15,0.15);color:var(--gold,#f1c40f);border-color:rgba(241,196,15,0.35)">🔥 Martingale ${mult}x</span>`
          : "";

        return `<div class="monitor-item ${dir}">
          <div class="mon-row1">
            <span class="mon-dir ${dir}">${dir}</span>
            <span class="mon-price">Entry: $${entry.toFixed(2)}</span>
            <span class="mon-pnl ${pnlCls}" id="pnl-${m.id}">${pnlStr}</span>
          </div>
          <div class="mon-row2">
            <div class="mon-level">
              <span style="color:var(--text-dim)">SL</span>
              <span class="sl-val">$${sl.toFixed(2)}</span>
            </div>
            <div class="mon-level">
              <span style="color:var(--text-dim)">TP1</span>
              <span class="tp-val">$${tp1 ? tp1.toFixed(2) : "-"}</span>
            </div>
            <div class="mon-level">
              <span style="color:var(--text-dim)">TP2</span>
              <span class="tp-val">$${tp2 ? tp2.toFixed(2) : "-"}</span>
            </div>
            <div class="mon-level">
              <span style="color:var(--text-dim)">TP3</span>
              <span class="tp-val">$${tp3 ? tp3.toFixed(2) : "-"}</span>
            </div>
            <div class="mon-level">
              <span style="color:var(--text-dim)">Duration</span>
              <span>${elapsedStr}</span>
            </div>
          </div>
          ${tpBadge}
          ${martBadge}
          <div class="mon-live-price" style="font-size:11px;color:var(--text-dim);margin-top:4px;">
            Live price: <span id="liveprice-${m.id}">${currentPrice ? "$" + currentPrice.toFixed(2) : "..."}</span>
          </div>
        </div>`;
      }).join("");
    }

    // Fetch harga awal
    let currentPrice = 0;
    try {
      const pr = await fetch("/api/public/price");
      const pd = await pr.json();
      currentPrice = pd.price || 0;
    } catch(_) {}

    renderMonitorCards(currentPrice);

    // Auto-refresh P&L tiap 5 detik
    if (_monitorPnlTimer) clearInterval(_monitorPnlTimer);
    _monitorPnlTimer = setInterval(async () => {
      try {
        const pr2 = await fetch("/api/public/price");
        const pd2 = await pr2.json();
        const livePrice = pd2.price || 0;
        if (!livePrice) return;

        // Update hanya elemen P&L dan live price — tidak re-render seluruh card
        monitors.forEach(m => {
          const dir   = m.direction;
          const entry = Number(m.entry_price);
          const mult  = Number(m.martingale_mult) || 1;
          const pnl   = (dir === "BUY" ? livePrice - entry : entry - livePrice) * PNL_MULT * mult;
          const pnlEl = document.getElementById("pnl-" + m.id);
          const prEl  = document.getElementById("liveprice-" + m.id);
          if (pnlEl) {
            pnlEl.textContent = `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;
            pnlEl.className   = "mon-pnl " + (pnl >= 0 ? "pos" : "neg");
          }
          if (prEl) prEl.textContent = "$" + livePrice.toFixed(2);
        });
      } catch(_) {}
    }, 5000);

    // Auto-start engine kalau ada monitor aktif
    startMonitorEngine();

  } catch (e) {
    console.error("Load monitors error:", e);
  }
}

// ─── LOAD TRADE HISTORY ──────────────────────
const TRADE_HIST_PAGE_SIZE = 10;
let tradeHistPage  = 1;
let tradeHistTotal = 0;
let tradeHistDays  = 7;   // filter periode: 1 (24H) / 7 (7D) / 30 (30D)

function setTradeHistDays(days) {
  if (days === tradeHistDays) return;
  tradeHistDays = days;
  tradeHistPage = 1;
  loadTradeHistory();
}

function goToTradeHistPage(page) {
  const maxPage = Math.max(1, Math.ceil(tradeHistTotal / TRADE_HIST_PAGE_SIZE));
  tradeHistPage = Math.min(Math.max(1, page), maxPage);
  loadTradeHistory();
}

function renderTradeHistFilter() {
  const opts = [[1, "24H"], [7, "7D"], [30, "30D"]];
  return `<div class="perf-filter hist-period-filter">` +
    opts.map(([d, label]) =>
      `<button class="perf-filter-btn ${tradeHistDays === d ? "active" : ""}" onclick="setTradeHistDays(${d})">${label}</button>`
    ).join("") +
    `</div>`;
}

function renderTradeHistPagination() {
  if (tradeHistTotal <= TRADE_HIST_PAGE_SIZE) return "";
  const maxPage = Math.max(1, Math.ceil(tradeHistTotal / TRADE_HIST_PAGE_SIZE));
  const page    = tradeHistPage;
  const from    = (page - 1) * TRADE_HIST_PAGE_SIZE + 1;
  const to      = Math.min(page * TRADE_HIST_PAGE_SIZE, tradeHistTotal);
  return `
    <div class="hist-pagination">
      <button class="hist-page-btn" ${page <= 1 ? "disabled" : ""} onclick="goToTradeHistPage(${page - 1})">‹ Prev</button>
      <span class="hist-page-info">${from}–${to} of ${tradeHistTotal} · Page ${page}/${maxPage}</span>
      <button class="hist-page-btn" ${page >= maxPage ? "disabled" : ""} onclick="goToTradeHistPage(${page + 1})">Next ›</button>
    </div>`;
}

async function loadTradeHistory() {
  try {
    const offset = (tradeHistPage - 1) * TRADE_HIST_PAGE_SIZE;
    const res  = await fetch(`/api/trade_history?limit=${TRADE_HIST_PAGE_SIZE}&offset=${offset}&days=${tradeHistDays}`);
    const data = await res.json();
    if (!data.ok) return;

    const trades = data.data || [];
    tradeHistTotal = data.total || 0;
    const el = document.getElementById("trade-history-list");
    if (!el) return;

    const filterHtml = renderTradeHistFilter();

    if (!trades.length) {
      el.innerHTML = filterHtml + '<div class="history-empty">No completed trades yet</div>';
      return;
    }

    const outcomeLabel = {
      SL_HIT:  "STOP LOSS",
      BE_HIT:  "BREAKEVEN",
      TP1_HIT: "TP1 HIT",
      TP2_HIT: "TP2 HIT",
      TP3_HIT: "FULL TP",
    };

    const itemsHtml = trades
      .filter(t => t.status !== "ACTIVE")   // active positions shown in LIVE MONITORS
      .map(t => {
      const pnl   = Number(t.pnl_usd ?? (Number(t.pnl_pips || 0) * PNL_MULT));
      const isBE  = t.outcome === "BE_HIT";
      const isWin = pnl > 0 && !isBE;
      const cls   = isWin ? "win" : isBE ? "be" : pnl > 0 ? "win" : "loss";
      const pnlStr  = `${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toFixed(2)}`;
      const outcome = outcomeLabel[t.outcome] || (t.outcome ? t.outcome.replace("_", " ") : "-");
      const ts      = new Date(t.outcome_time || t.timestamp)
                        .toLocaleString("en-US", { day:"2-digit", month:"2-digit",
                          hour:"2-digit", minute:"2-digit" });
      const dir     = t.direction || "-";
      const tpBadge = (t.tp_hit || 0) > 0
        ? `<span class="trade-meta tp-partial">✓ TP${t.tp_hit} partial</span>`
        : `<span class="trade-meta">TP hit: 0</span>`;

      return `<div class="trade-item ${cls}">
        <div class="trade-row1">
          <span class="trade-outcome ${cls}">${dir} ${outcome}</span>
          <span class="trade-pnl ${pnl > 0 ? "pos" : pnl < 0 ? "neg" : "be"}">${pnlStr}</span>
        </div>
        <div class="trade-row2">
          <span class="trade-meta">Entry: $${Number(t.entry_price||0).toFixed(2)}</span>
          ${tpBadge}
          <span class="trade-meta">${ts}</span>
        </div>
      </div>`;
    }).join("") || '<div class="history-empty">No completed trades yet</div>';

    el.innerHTML = filterHtml + itemsHtml + renderTradeHistPagination();

  } catch (e) {
    console.error("Trade history error:", e);
  }
  // Sync all lists to mobile sections
  setTimeout(() => {
    ["monitor-list", "trade-history-list", "history-list"].forEach(id => {
      const src  = document.getElementById(id);
      const dest = document.getElementById("m-" + id);
      if (src && dest) dest.innerHTML = src.innerHTML;
    });
    const cnt  = document.getElementById("monitor-count");
    const mcnt = document.getElementById("m-monitor-count");
    if (cnt && mcnt) mcnt.textContent = cnt.textContent;
  }, 100);
}
// ─── ANALYTICS DIAGNOSIS ──────────────────────
const SESSION_LABEL = {
  london: "🇬🇧 London", new_york: "🇺🇸 New York",
  tokyo: "🇯🇵 Tokyo",   sydney: "🇦🇺 Sydney",
  off: "Off-session",   unknown: "?",
};

async function loadAnalytics() {
  try {
    const res  = await fetch(`/api/analytics?days=${PERF_DAYS}`);
    const data = await res.json();
    if (!data.ok) return;
    const a  = data.data;
    const el = document.getElementById("analytics-body");
    if (!el) return;

    if (!a.overall || !a.overall.total) {
      el.innerHTML = '<div class="history-empty">No trade data available</div>';
      syncAnalyticsToMobile();
      return;
    }

    const row = (label, g) => {
      if (!g || !g.total) return "";
      const wrCls  = g.win_rate >= 55 ? "pos" : g.win_rate >= 40 ? "mid" : "neg";
      const pnlCls = g.net_pnl > 0 ? "pos" : g.net_pnl < 0 ? "neg" : "mid";
      const pnlStr = `${g.net_pnl >= 0 ? "+" : "-"}$${Math.abs(g.net_pnl).toFixed(2)}`;
      return `<div class="an-row">
        <span class="an-label">${label}</span>
        <span class="an-val">${g.total}x</span>
        <span class="an-val ${wrCls}">${g.win_rate}%</span>
        <span class="an-val ${pnlCls}">${pnlStr}</span>
        <span class="an-val">PF ${g.profit_factor}</span>
      </div>`;
    };

    let html = `<div class="an-head">
      <span class="an-label"></span><span class="an-val">N</span>
      <span class="an-val">WR</span><span class="an-val">PnL</span><span class="an-val">PF</span>
    </div>`;

    html += `<div class="an-section">Direction</div>`;
    ["BUY", "SELL"].forEach(d => { html += row(d, a.by_direction[d]); });

    html += `<div class="an-section">Timeframe</div>`;
    Object.entries(a.by_timeframe || {}).forEach(([tf, g]) => { html += row(tf, g); });

    html += `<div class="an-section">Session</div>`;
    Object.entries(a.by_session || {}).forEach(([s, g]) => {
      html += row(SESSION_LABEL[s] || s, g);
    });

    // MFE Insight
    const d = a.mfe_diagnosis || {};
    if (d.sl_pure_total > 0) {
      const pct = Math.round((d.sl_near_tp1 / d.sl_pure_total) * 100);
      const insight = pct >= 50
        ? `⚠️ ${pct}% of losses approached TP1 (≥70% distance) — indicates SL too tight / TP1 too far`
        : `${d.sl_near_tp1}/${d.sl_pure_total} losses approached TP1 — majority of losses were wrong direction, not execution error`;
      html += `<div class="an-insight">${insight}</div>`;
    }

    el.innerHTML = html;
    syncAnalyticsToMobile();
  } catch (e) {
    console.error("Analytics error:", e);
  }
}

function syncAnalyticsToMobile() {
  const src  = document.getElementById("analytics-body");
  const dest = document.getElementById("m-analytics-body");
  if (src && dest) dest.innerHTML = src.innerHTML;
}

async function loadPerformance() {
  try {
    const res  = await fetch(`/api/performance?days=${PERF_DAYS}`);
    const data = await res.json();
    if (!data.ok) return;
    const p = data.data;

    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    };

    set("perf-total",   p.total);
    set("perf-wins",    p.wins);
    set("perf-neutral", p.neutral || 0);
    set("perf-losses",  p.losses);
    set("perf-rate",    p.win_rate + "%");
    set("perf-tp1",     p.tp1_hits);
    set("perf-tp2",     p.tp2_hits);
    set("perf-tp3",     p.tp3_hits);

    // Topbar KPI pills (desktop shell)
    const tbWinrate = document.getElementById("tb-winrate");
    if (tbWinrate) tbWinrate.textContent = (p.win_rate || 0) + "%";
    const tbPnl = document.getElementById("tb-pnl");
    if (tbPnl) {
      const tpnl = p.total_pnl ?? p.total_pips ?? 0;
      tbPnl.textContent = (tpnl >= 0 ? "+" : "-") + "$" + Math.abs(tpnl).toFixed(0);
      tbPnl.className = "val " + (tpnl >= 0 ? "pos" : "neg");
    }

    // Update period label (analytics card mirrors the same filter)
    const periodLbl = PERF_DAYS === 1 ? "24H" : PERF_DAYS === 7 ? "7D" : PERF_DAYS === 30 ? "30D" : PERF_DAYS + "D";
    const analyticsPeriodEl = document.getElementById("analytics-period");
    if (analyticsPeriodEl) analyticsPeriodEl.textContent = periodLbl;

    const pipsEl = document.getElementById("perf-pips");
    const avgEl  = document.getElementById("perf-avg");
    const bestEl = document.getElementById("perf-best");
    const wrstEl = document.getElementById("perf-worst");

    // Sync lot multiplier from backend
    if (p.pnl_mult) PNL_MULT = Number(p.pnl_mult);
    if (p.lot_size) PNL_LOT  = Number(p.lot_size);
    // "(0.10 lot)" cuma akurat kalau semua trade di periode ini basis 1x —
    // total PnL sendiri sudah benar (backend jumlahkan per-trade martingale
    // mult), tapi label statis ini menyesatkan begitu ada trade Martingale
    // yang lot efektifnya lebih besar dari basis.
    const lotNote = p.has_martingale
      ? `(basis ${PNL_LOT.toFixed(2)} lot + Martingale)`
      : `(${PNL_LOT.toFixed(2)} lot)`;
    const lotLbl = document.getElementById("perf-lot-note");
    if (lotLbl) lotLbl.textContent = lotNote;
    document.querySelectorAll(".m-lot-note").forEach(el => {
      el.textContent = lotNote;
    });

    const totalPnl = p.total_pnl ?? p.total_pips ?? 0;
    const avgPnl   = p.avg_pnl   ?? p.avg_pips   ?? 0;

    if (pipsEl) {
      pipsEl.textContent = (totalPnl >= 0 ? "+" : "-") + "$" + Math.abs(totalPnl).toFixed(2);
      pipsEl.style.color = totalPnl >= 0 ? "var(--green)" : "var(--red)";
    }
    if (avgEl) {
      avgEl.textContent  = (avgPnl >= 0 ? "+" : "-") + "$" + Math.abs(avgPnl).toFixed(2);
      avgEl.style.color  = avgPnl >= 0 ? "var(--green)" : "var(--red)";
    }
    if (bestEl)  bestEl.textContent  = "+$" + (p.best  || 0).toFixed(2);
    if (wrstEl)  wrstEl.textContent  = "-$" + Math.abs(p.worst || 0).toFixed(2);

    const pfEl = document.getElementById("perf-pf");
    if (pfEl) {
      const pf = Number(p.profit_factor || 0);
      pfEl.textContent = pf > 0 ? pf.toFixed(2) : "—";
      pfEl.style.color = pf >= 1.5 ? "var(--green)"
                       : pf >= 1.0 ? "var(--gold)"
                       : "var(--red)";
    }
    const beEl = document.getElementById("perf-be");
    if (beEl) beEl.textContent = p.be_count || 0;
    const neutralEl = document.getElementById("perf-neutral");
    if (neutralEl) neutralEl.textContent = p.neutral || 0;

    const rateEl = document.getElementById("perf-rate");
    if (rateEl) {
      rateEl.style.color = p.win_rate >= 60 ? "var(--green)"
                         : p.win_rate >= 40 ? "var(--gold)"
                         : "var(--red)";
    }

    if (window.innerWidth <= 768) {
      const mf = {
        "m-perf-total":   p.total,
        "m-perf-wins":    p.wins,
        "m-perf-neutral": p.neutral || 0,
        "m-perf-losses":  p.losses,
        "m-perf-rate":    p.win_rate + "%",
        "m-perf-pips":    (totalPnl >= 0 ? "+" : "-") + "$" + Math.abs(totalPnl).toFixed(2),
        "m-perf-avg":    (avgPnl >= 0 ? "+" : "-") + "$" + Math.abs(avgPnl).toFixed(2),
        "m-perf-pf":     Number(p.profit_factor || 0) > 0 ? Number(p.profit_factor).toFixed(2) : "—",
      };
      Object.entries(mf).forEach(([id, val]) => {
        const el = document.getElementById(id); if (el) el.textContent = val;
      });
    }
  } catch (e) {
    console.error("Performance error:", e);
  }
}

async function resetPerformance() {
  if (!confirm("Reset all performance data? Trade outcomes will be permanently deleted.")) return;
  try {
    const res  = await fetch("/api/reset_performance", {method:"POST"});
    const data = await res.json();
    if(data.ok) {
      showToast(`✓ ${data.message}`, "success");
      loadPerformance();
      loadTradeHistory();
      loadAnalytics();
    } else {
      showToast("Reset failed: " + (data.error || "unknown"), "error");
    }
  } catch(e) {
    showToast("Error: " + e.message, "error");
  }
}

// ─── INIT TAMBAHAN ──────────────────────────
// Panggil load saat halaman pertama dibuka
document.addEventListener("DOMContentLoaded", () => {
  setTimeout(() => {
    loadActiveMonitors();
    loadTradeHistory();
    loadPerformance();
    loadAnalytics();
  }, 500);
});

// ═══════════════════════════════════════════════
// VISION AI CONFIRMATION
// ═══════════════════════════════════════════════

// ─── TRIGGER VISION CONFIRM ──────────────────
async function triggerVisionConfirm(data) {
  const a   = data.analysis || {};
  const rm  = a.risk_management || {};
  const en  = a.entry || {};
  const tgToken = localStorage.getItem("xau_tg_token") || "";
  const tgChat  = localStorage.getItem("xau_tg_chat")  || "";

  const activeSigId = data.signal_id || a.signal_id || null;

  try {
    const res = await fetch("/api/vision_confirm", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signal_id:   activeSigId,
        signal:      a.signal,
        timeframe:   data.timeframe,
        price:       data.price,
        entry:       en.ideal_price  || 0,
        stop_loss:   rm.stop_loss    || 0,
        tp1:         rm.take_profit_1 || 0,
        tp2:         rm.take_profit_2 || 0,
        tp3:         rm.take_profit_3 || 0,
        rr_ratio:    rm.risk_reward_ratio || "-",
        confidence:  a.confidence   || 0,
        indicators:  data.indicators || {},
        smc:         data.smc        || {},
        bot_token:   tgToken,
        chat_id:     tgChat,
      }),
    });
    const result = await res.json();
    return result.ok ? result : null;
  } catch (e) {
    console.error("Vision confirm error:", e);
    return null;
  }
}

// ─── RENDER VISION RESULT ────────────────────
function renderVisionResult(vision) {
  // Tampilkan di signal hero — tambahkan vision panel
  const hero = document.getElementById("signal-result");
  if (!hero) return;

  // Hapus panel vision lama jika ada
  const old = document.getElementById("vision-panel");
  if (old) old.remove();

  const verdict = vision.verdict || "SKIP";
  const vColor  = verdict === "VALID"              ? "var(--green)"
                : verdict === "WAIT_FOR_PULLBACK"  ? "var(--gold)"
                : "var(--red)";
  const vEmoji  = verdict === "VALID" ? "✅" : verdict === "WAIT_FOR_PULLBACK" ? "⏳" : "⛔";

  const obsHtml  = (vision.key_observations || [])
    .map(o => `<li>${o}</li>`).join("");
  const riskHtml = (vision.risk_notes || [])
    .map(r => `<li>⚠ ${r}</li>`).join("");

  const panel = document.createElement("div");
  panel.id    = "vision-panel";
  panel.style.cssText = `
    background: var(--bg2);
    border: 1px solid ${vColor}44;
    border-left: 3px solid ${vColor};
    border-radius: 8px;
    padding: 14px 16px;
    margin-top: 14px;
  `;
  panel.innerHTML = `
    <div style="font-family:var(--mono);font-size:9px;letter-spacing:.12em;color:var(--text-dim);margin-bottom:10px">
      👁 GEMINI VISION ANALYSIS
    </div>
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
      <div style="font-family:var(--mono);font-size:22px;font-weight:700;color:${vColor}">
        ${vEmoji} ${verdict.replace(/_/g," ")}
      </div>
      <div style="text-align:right;margin-left:auto">
        <div style="font-size:9px;color:var(--text-dim)">COMBINED CONFIDENCE</div>
        <div style="font-family:var(--mono);font-size:20px;font-weight:700;color:var(--blue)">
          ${vision.combined_confidence || 0}%
        </div>
      </div>
    </div>
    <div style="font-size:11px;color:var(--text-sec);line-height:1.6;margin-bottom:10px;padding:8px;background:var(--bg3);border-radius:5px">
      ${vision.reasoning || "-"}
    </div>
    ${vision.suggested_sl ? `
    <div style="margin-top:10px;margin-bottom:6px;padding:8px;background:var(--bg3);border:1px solid var(--gold)22;border-radius:6px;display:grid;grid-template-columns:repeat(4, 1fr);gap:8px;text-align:center">
      <div>
        <div style="font-size:8px;color:var(--text-dim)">REFINED SL</div>
        <div style="font-family:var(--mono);font-size:11px;font-weight:700;color:var(--red)">$${vision.suggested_sl}</div>
      </div>
      <div>
        <div style="font-size:8px;color:var(--text-dim)">REFINED TP1</div>
        <div style="font-family:var(--mono);font-size:11px;font-weight:700;color:var(--green)">$${vision.suggested_tp1}</div>
      </div>
      <div>
        <div style="font-size:8px;color:var(--text-dim)">REFINED TP2</div>
        <div style="font-family:var(--mono);font-size:11px;font-weight:700;color:var(--green)">$${vision.suggested_tp2}</div>
      </div>
      <div>
        <div style="font-size:8px;color:var(--text-dim)">REFINED TP3</div>
        <div style="font-family:var(--mono);font-size:11px;font-weight:700;color:var(--green)">$${vision.suggested_tp3}</div>
      </div>
    </div>
    <div style="display:flex;gap:12px;margin-bottom:10px;justify-content:center">
      ${vision.visual_support_level ? `<span style="font-size:9px;color:var(--text-dim)">Visual Support: <b style="color:var(--green)">$${vision.visual_support_level}</b></span>` : ""}
      ${vision.visual_resistance_level ? `<span style="font-size:9px;color:var(--text-dim)">Visual Resistance: <b style="color:var(--red)">$${vision.visual_resistance_level}</b></span>` : ""}
    </div>
    ` : ""}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      ${obsHtml ? `<div>
        <div style="font-size:9px;color:var(--green);letter-spacing:.1em;margin-bottom:4px">✓ OBSERVASI</div>
        <ul style="font-size:10px;color:var(--text-sec);line-height:1.7;padding-left:14px">${obsHtml}</ul>
      </div>` : ""}
      ${riskHtml ? `<div>
        <div style="font-size:9px;color:var(--red);letter-spacing:.1em;margin-bottom:4px">⚠ RISIKO VISUAL</div>
        <ul style="font-size:10px;color:var(--text-sec);line-height:1.7;padding-left:14px">${riskHtml}</ul>
      </div>` : ""}
    </div>
    <div style="display:flex;gap:16px;margin-top:10px;padding-top:8px;border-top:1px solid var(--border)">
      <span style="font-size:10px;color:var(--text-dim)">
        PA Quality: <span style="color:var(--text-pri)">${vision.price_action_quality || "-"}</span>
      </span>
      <span style="font-size:10px;color:var(--text-dim)">
        Timing: <span style="color:var(--text-pri)">${vision.entry_timing || "-"}</span>
      </span>
      <span style="font-size:10px;color:var(--text-dim)">
        Chart: <span style="color:${vision.tg_sent ? "var(--green)" : "var(--text-dim)"}">
          ${vision.tg_sent ? "✓ Terkirim ke Telegram" : "Telegram tidak aktif"}
        </span>
      </span>
    </div>
    ${vision.chart_b64 ? `
    <div style="margin-top:10px">
      <img src="data:image/png;base64,${vision.chart_b64}"
           style="width:100%;border-radius:6px;border:1px solid var(--border)"
           alt="XAU/USD Chart">
    </div>` : ""}
  `;

  // Sisipkan setelah narrative box
  const narrativeBox = hero.querySelector(".narrative-box");
  if (narrativeBox) {
    narrativeBox.after(panel);
  } else {
    hero.appendChild(panel);
  }
}

// ═══════════════════════════════════════════════
// SERVER POLLING MODE
// ═══════════════════════════════════════════════

// ─── START POLLING ───────────────────────────
function startServerPolling() {
  // Live signal polling only matters where the signal card actually
  // renders (the dashboard). On pages like /history or /performance that
  // just reuse this shared script, this used to still poll every 5s,
  // throwing on the dashboard-only DOM it tried to update.
  if (!document.getElementById("signal-hero")) return;

  pollLatestSignal();
  pollTimer = setInterval(pollLatestSignal, 5000);
  console.log("[Polling] Active — checking every 5s");
}

// ─── POLL LATEST SIGNAL ──────────────────────
async function pollLatestSignal() {
  try {
    const res  = await fetch("/api/latest_signal");
    const data = await res.json();
    processReceivedSignal(data);
  } catch(e) {
    console.error("[Polling] Error fetching latest signal:", e);
  }
}

// ─── PROCESS RECEIVED SIGNAL DATA ────────────
async function processReceivedSignal(data) {
  if (!data || !data.ok) {
    // DB kosong dan cache kosong — tampilkan loading state
    if (data && data.pending) {
      const pendingEl = document.getElementById("signal-empty");
      if (pendingEl) {
        pendingEl.style.display = "block";
        const titleEl = pendingEl.querySelector(".empty-title");
        const subEl   = pendingEl.querySelector(".empty-sub, #signal-empty-sub");
        if (titleEl) titleEl.textContent = "Server scheduler aktif";
        if (subEl)   subEl.textContent   = data.message || "Menunggu analisis pertama...";
      }
      document.getElementById("signal-result").style.display = "none";
    }
    return;
  }

  // Ada data (dari live cache atau DB) — selalu render
  window._lastSignalData = data.analysis || null;

  // Update terminal widget harga & status
  if (data.price > 0) {
    updateDashTerminal(data.price, data.data_source || '', data.analysis || null);
  }
  // Update status bar dengan data Berkah Signal
  updateTerminalStatus(data.analysis || null);

  // Render signal UI & parameters on every data check for real-time responsiveness
  const currentSig  = data.analysis?.signal || "WAIT";
  const lastSigType = window._renderedSigType || null;
  const isNewSignal = (data.signal_id && data.signal_id !== lastSignalId) || (currentSig !== lastSigType);

  renderSignal(data);
  renderIndicators(data.indicators, data.price);
  renderSMC(data.smc);

  if (isNewSignal) {
    lastSignalId = data.signal_id;
    window._renderedSigType = currentSig;
    await loadHistory();
    await loadStats();
    await loadActiveMonitors();
    await loadPerformance();
    // Tidak play sound jika data dari DB (bukan signal live baru)
    const sig = data.analysis?.signal;
    if ((sig === "BUY" || sig === "SELL") && !data.from_db) playAlertSound(sig);
  } else {
    // Signal sama — update harga topbar dari sumber manapun
    if (data.price) {
      const priceEl = document.getElementById("topbar-price");
      if (priceEl) {
        priceEl.textContent = "$" + Number(data.price).toLocaleString("en-US",
          { minimumFractionDigits: 2 });
      }
    }
  }

  // Update topbar price selalu dari latest signal
  const priceEl = document.getElementById("topbar-price");
  if (priceEl && data.price) {
    priceEl.textContent = "$" + Number(data.price).toLocaleString("en-US",
      { minimumFractionDigits: 2 });
  }

  // Update bridge status indicator
  updateBridgeStatus(data);
}

// ─── SYNC COUNTDOWN KE SERVER SCHEDULER ─────
async function syncSchedulerCountdown() {
  // Server-info panel + mobile info bar are dashboard-only — every DOM
  // target here is null-safe, but without this it still opened a repeating
  // 1s interval and re-fetched /api/scheduler_status forever on pages that
  // have nothing to show it in.
  if (!document.getElementById("signal-hero")) return;
  try {
    const res  = await fetch("/api/scheduler_status");
    const data = await res.json();
    if (!data.ok) return;

    const secsLeft = data.next_run_sec;
    const interval = data.interval_sec;

    // Update UI
    const statusEl = document.getElementById("auto-status");
    if (statusEl) {
      statusEl.innerHTML =
        `<span class="auto-active">● Server scheduler aktif — ${Math.round(interval/60)} menit</span>`;
    }
    const wrapEl = document.getElementById("countdown-wrap");
    if (wrapEl) wrapEl.style.display = "block";

    // Sync countdown ke jadwal server
    totalSec     = interval;
    countdownSec = secsLeft;
    updateCountdownUI();

    // Clear timer lama
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      countdownSec--;
      if (countdownSec <= 0) {
        countdownSec = interval;
        // Re-sync ke server saat countdown habis
        syncSchedulerCountdown();
      }
      updateCountdownUI();
    }, 1000);

    console.log(`[Scheduler] Next run in ${secsLeft}s at ${data.next_run_time}`);
    window._lastSchedulerData = data;
    updateMobileInfoBar(data, null);

    // Update server info panel
    const dotEl      = document.getElementById("server-dot");
    const labelEl    = document.getElementById("server-label");
    const tfEl       = document.getElementById("server-tf");
    const intEl      = document.getElementById("server-interval");

    if (!data.market_open) {
      // Market tutup — thread tetap hidup tapi tidak menganalisis
      if (dotEl)   dotEl.style.color   = "var(--text-dim)";
      if (labelEl) labelEl.textContent = "🌙 Standby — market tutup";
    } else if (data.thread_alive) {
      if (dotEl)   dotEl.style.color   = "var(--green)";
      if (labelEl) labelEl.textContent = "Scheduler aktif — " + data.next_run_time;
    } else {
      if (dotEl)   dotEl.style.color   = "var(--red)";
      if (labelEl) labelEl.textContent = "Scheduler tidak aktif!";
    }

    if (tfEl)     tfEl.textContent     = data.timeframe || "1M";
    if (intEl)    intEl.textContent    = Math.round(interval / 60) + " menit";

    // Update market status badge + banner
    updateMarketStatus(data.market_open, data.market_closed_reason);

    // Update data source badge — fetch dari get_config (cek bridge vs twelve data)
    try {
      const cfgRes  = await fetch("/api/get_config");
      const cfgData = await cfgRes.json();
      if (cfgData.ok) {
        updateBridgeStatus({ data_source: cfgData.price_source || cfgData.data_source || "" });
      }
    } catch(e) { /* silent fail */ }

  } catch(e) {
    console.error("[Scheduler] Status error:", e);
  }

  // Re-sync setiap 5 menit agar tidak drift
  setTimeout(syncSchedulerCountdown, 5 * 60 * 1000);
}

// ═══════════════════════════════════════════════
// TAB NAVIGATION
// ═══════════════════════════════════════════════
function switchTab(tab) {
  // Update buttons
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
  document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));

  const btnEl  = document.getElementById(`tab-${tab}-btn`);
  const tabEl  = document.getElementById(`tab-${tab}`);
  if (btnEl) btnEl.classList.add("active");
  if (tabEl) tabEl.classList.add("active");

  // Mobile/tablet: saat tab News (kalender) atau Sentimen aktif, sembunyikan
  // .mobile-sections di bawahnya (XAU/USD widget, Performa, dst) supaya fokus
  // ke konten tab yang dipilih — hanya tab Sinyal yang menampilkannya.
  const mobileSections = document.getElementById("mobile-sections");
  if (mobileSections) mobileSections.classList.toggle("gx-focus-hide", tab !== "signal");

  // Load data saat pertama kali buka tab sentimen
  if (tab === "sentimen") {
    const sentBadge = document.getElementById("sent-badge");
    if (!sentBadge || sentBadge.textContent === "NEUTRAL") {
      loadNewsSentiment(false);
      loadCalendar(false);
    }
  }
}

// ── News Real Time sub-tab switcher ──
function switchMfxTab(name, btn) {
  document.querySelectorAll(".mfx-panel").forEach(p => p.style.display = "none");
  document.querySelectorAll(".mfx-tab").forEach(b => b.classList.remove("active"));
  const panel = document.getElementById("mfx-" + name);
  if (panel) panel.style.display = "block";
  if (btn)   btn.classList.add("active");

  // Widget TradingView (kalender/berita) baru dimuat pas tab-nya BENERAN
  // dibuka, bukan langsung saat halaman dashboard dibuka — dua-duanya
  // duduk di tab "Kalender Ekonomi" yang defaultnya tersembunyi, jadi
  // tidak ada gunanya ikut nge-load network request di initial page load.
  if (name === "calendar") loadCalendarWidget();
  if (name === "news")     loadNewsWidget();
}

let _calendarWidgetLoaded = false;
function loadCalendarWidget() {
  if (_calendarWidgetLoaded) return;
  _calendarWidgetLoaded = true;
  const container = document.getElementById("mfx-calendar-widget");
  if (!container) return;
  const script = document.createElement("script");
  script.type = "text/javascript";
  script.src  = "https://s3.tradingview.com/external-embedding/embed-widget-events.js";
  script.async = true;
  script.text = JSON.stringify({
    colorTheme: "dark", isTransparent: true, width: "100%", height: "465",
    locale: "en", importanceFilter: "-1,0,1", countryFilter: "us",
  });
  container.appendChild(script);
}

let _newsWidgetLoaded = false;
function loadNewsWidget() {
  if (_newsWidgetLoaded) return;
  _newsWidgetLoaded = true;
  const iframe = document.getElementById("mfx-news-iframe");
  if (iframe && iframe.dataset.src) iframe.src = iframe.dataset.src;
}

// ── Iframe TradingView di tab yang aktif secara default (mis. chart live
// di dashboard) — ditunda sampai benar-benar mendekati viewport, bukan
// langsung fetch semua widget berat begitu halaman dibuka. ──
document.addEventListener("DOMContentLoaded", () => {
  const lazyIframes = document.querySelectorAll("iframe.lazy-iframe[data-src]");
  if (!lazyIframes.length) return;
  if (!("IntersectionObserver" in window)) {
    lazyIframes.forEach(el => { el.src = el.dataset.src; });
    return;
  }
  const io = new IntersectionObserver((entries, obs) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.src = entry.target.dataset.src;
        obs.unobserve(entry.target);
      }
    });
  }, { rootMargin: "200px" });
  lazyIframes.forEach(el => io.observe(el));
});

// ═══════════════════════════════════════════════
// NEWS & SENTIMENT
// ═══════════════════════════════════════════════

// ─── LOAD SENTIMENT ──────────────────────────
async function loadNewsSentiment(force = false) {
  const loadEl   = document.getElementById("sentiment-loading");
  const contentEl = document.getElementById("sentiment-content");
  const btnEl    = document.getElementById("btn-refresh-news");

  if (loadEl)  { loadEl.style.display = "block"; loadEl.textContent = "🔍 Mencari berita terkini..."; }
  if (contentEl) contentEl.style.display = "none";
  if (btnEl)   btnEl.disabled = true;

  try {
    const res  = await fetch(`/api/news_sentiment?force=${force}`);
    const data = await res.json();

    if (!data.ok && !data.overall_sentiment) {
      if (loadEl) loadEl.textContent = "❌ Gagal memuat: " + (data.error || "Unknown error");
      return;
    }

    renderSentiment(data);
    if (loadEl)    loadEl.style.display   = "none";
    if (contentEl) contentEl.style.display = "block";

  } catch(e) {
    if (loadEl) loadEl.textContent = "❌ Error: " + e.message;
    console.error("Sentiment error:", e);
  } finally {
    if (btnEl) btnEl.disabled = false;
  }
}

// ─── RENDER SENTIMENT ────────────────────────
function renderSentiment(data) {
  const sent  = data.overall_sentiment || "NEUTRAL";
  const score = parseInt(data.sentiment_score || 0);

  // Badge
  const badgeEl = document.getElementById("sent-badge");
  if (badgeEl) {
    badgeEl.textContent = sent;
    badgeEl.className   = "sentiment-badge " + sent;
  }

  // Score
  const scoreEl = document.getElementById("sent-score");
  if (scoreEl) {
    scoreEl.textContent = (score >= 0 ? "+" : "") + score;
    scoreEl.className   = "sent-score " + (score > 10 ? "pos" : score < -10 ? "neg" : "neu");
  }

  // Summary
  const sumEl = document.getElementById("sent-summary");
  if (sumEl) sumEl.textContent = data.summary || "-";

  // Watch out
  const watchEl = document.getElementById("sent-watch");
  if (watchEl && data.watch_out) {
    watchEl.textContent  = "⚠ " + data.watch_out;
    watchEl.style.display = "block";
  }

  // Updated + source
  const updEl    = document.getElementById("sent-updated");
  const srcLabel = document.getElementById("news-source-label");
  if (updEl)    updEl.textContent    = "Update: " + (data.updated || "-");
  if (srcLabel) srcLabel.textContent = data.source || "RSS Feeds";

  // Show errors kalau ada feed yang gagal
  if (data.errors && data.errors.length > 0) {
    console.warn("[News] Some feeds failed:", data.errors);
  }

  // Key Factors
  const factorsCard = document.getElementById("factors-card");
  const factorsList = document.getElementById("factors-list");
  if (factorsList && data.key_factors?.length) {
    factorsList.innerHTML = data.key_factors.map(f => {
      const impact = f.impact || "NEUTRAL";
      return `<div class="factor-item ${impact}">
        <span class="factor-badge ${impact}">${impact}</span>
        <div class="factor-content">
          <div class="factor-name">${f.factor || "-"}</div>
          <div class="factor-desc">${f.desc || ""}</div>
        </div>
      </div>`;
    }).join("");
    if (factorsCard) factorsCard.style.display = "block";
  }

  // Headlines
  const headCard = document.getElementById("headlines-card");
  const headList = document.getElementById("headlines-list");
  if (headList && data.headlines?.length) {
    headList.innerHTML = data.headlines.slice(0, 8).map(h => {
      const sent2 = h.sentiment || "NEUTRAL";
      return `<div class="headline-item ${sent2}">
        <div class="headline-title">${h.title || "-"}</div>
        <div class="headline-meta">
          <span class="headline-sent ${sent2}">${sent2}</span>
          <span class="headline-source">${h.source || "-"}</span>
          <span class="headline-time">${h.time || ""}</span>
        </div>
      </div>`;
    }).join("");
    if (headCard) headCard.style.display = "block";
  }
}

// ─── LOAD CALENDAR ───────────────────────────
async function loadCalendar(force = false) {
  const loadEl = document.getElementById("calendar-loading");
  const listEl = document.getElementById("calendar-list");
  if (!loadEl && !listEl) return; // below-hero mini calendar removed from the dashboard

  if (loadEl) { loadEl.style.display = "block"; loadEl.textContent = "Memuat jadwal ekonomi..."; }
  if (listEl) listEl.style.display = "none";

  try {
    const res  = await fetch(`/api/economic_calendar?force=${force}`);
    const data = await res.json();
    if (!data.ok || !data.data?.length) {
      if (loadEl) loadEl.textContent = "Tidak ada event high-impact minggu ini";
      return;
    }
    renderCalendar(data.data);
    if (loadEl) loadEl.style.display = "none";
    if (listEl) listEl.style.display = "block";
  } catch(e) {
    if (loadEl) loadEl.textContent = "❌ " + e.message;
  }
}

// ─── RENDER CALENDAR ─────────────────────────
function renderCalendar(events) {
  const listEl = document.getElementById("calendar-list");
  if (!listEl) return;

  listEl.innerHTML = events.map(ev => {
    const isSoon  = !ev.past && ev.diff_hours >= 0 && ev.diff_hours <= 1;
    const pastCls = ev.past ? "past" : "";
    const soonCls = isSoon ? "cal-soon" : "";
    const actual  = ev.actual ? ev.actual : (ev.past ? "-" : "");
    const timeStr = ev.past
      ? `<del>${ev.time_wib}</del>`
      : isSoon
        ? `⚡ ${ev.time_wib}`
        : ev.time_wib;

    return `<div class="cal-item ${ev.impact} ${pastCls} ${soonCls}">
      <span class="cal-time">${timeStr}</span>
      <span class="cal-title">${ev.title} <span style="color:var(--text-dim);font-size:9px">${ev.currency}</span></span>
      <span class="cal-impact ${ev.impact}">${ev.impact.toUpperCase()}</span>
      <span class="cal-actual">${actual || ev.forecast || "-"}</span>
    </div>`;
  }).join("");

  // Badge di topbar jika ada event < 1 jam
  const upcoming = events.filter(e => !e.past && e.diff_hours <= 1);
  if (upcoming.length > 0) {
    const badge = document.getElementById("live-badge");
    if (badge) {
      badge.textContent = `⚡ ${upcoming.length} EVENT SOON`;
      badge.style.color = "var(--red)";
    }
  }
}

// ═══════════════════════════════════════════════
// DATA SOURCE STATUS MONITOR (Twelve Data)
// ═══════════════════════════════════════════════
let _dataOfflineSince = null;
let _dataAlertSent    = false;

function updateBridgeStatus(data) {
  const src      = data.data_source || "";
  const isBridge = src.includes("MT5") || src.includes("BRIDGE");
  const isTwelve = src.includes("Twelve") || src.includes("TWELVE");
  const badgeEl  = document.getElementById("data-source-badge");
  const topPrice = document.getElementById("topbar-price");

  if (isBridge) {
    _dataOfflineSince = null;
    _dataAlertSent    = false;
    if (badgeEl) {
      badgeEl.textContent = "● MT5 Broker Live — Harga Identik";
      badgeEl.style.color = "var(--gold)";
    }
    if (topPrice) { topPrice.style.color = "var(--gold)"; topPrice.title = ""; }
  } else if (isTwelve) {
    _dataOfflineSince = null;
    _dataAlertSent    = false;
    if (badgeEl) {
      badgeEl.textContent = "⚡ Twelve Data (Fallback — Bridge Offline)";
      badgeEl.style.color = "#4c9eff";
    }
    if (topPrice) { topPrice.style.color = "#4c9eff"; topPrice.title = "Bridge offline, pakai Twelve Data"; }
  } else {
    if (!_dataOfflineSince) _dataOfflineSince = Date.now();
    const offlineSec = Math.round((Date.now() - _dataOfflineSince) / 1000);
    const offlineMin = Math.round(offlineSec / 60);
    if (badgeEl) {
      badgeEl.textContent = `⚠ Semua Sumber Offline${offlineSec > 60 ? " (" + offlineMin + " mnt)" : ""}`;
      badgeEl.style.color = "var(--red)";
    }
    if (offlineSec > 300 && topPrice) {
      topPrice.style.color = "var(--red)";
      topPrice.title = "⚠ Semua sumber data offline";
    }
    if (offlineSec > 0 && offlineSec % 600 < 30 && !_dataAlertSent) {
      _dataAlertSent = true;
      showToast(`⚠ Semua sumber data offline ${offlineMin} menit`, "error");
      setTimeout(() => { _dataAlertSent = false; }, 600000);
    }
  }
}

// Poll bridge status langsung setiap 30 detik (terpisah dari signal poll)
async function pollBridgeHealth() {
  try {
    const res  = await fetch("/api/scheduler_status");
    const data = await res.json();
    if (!data.ok) return;

    const dotEl   = document.getElementById("server-dot");
    const labelEl = document.getElementById("server-label");

    if (!data.thread_alive) {
      if (dotEl)   dotEl.style.color   = "var(--red)";
      if (labelEl) labelEl.textContent = "⚠ Scheduler mati!";
      showToast("⚠ Server scheduler tidak aktif!", "error");
    }
  } catch(e) {
    console.warn("[BridgeHealth]", e);
  }
}

// Run bridge health check setiap 60 detik
setInterval(pollBridgeHealth, 60000);

// ═══════════════════════════════════════════════
// MARKET OPEN/CLOSED STATUS
// ═══════════════════════════════════════════════
function updateMarketStatus(isOpen, reason) {
  const liveBadge = document.getElementById("live-badge");
  const banner    = document.getElementById("market-closed-banner");
  const reasonEl  = document.getElementById("mcb-reason");

  if (isOpen) {
    if (liveBadge) {
      liveBadge.textContent = "● LIVE";
      liveBadge.classList.remove("market-closed");
    }
    if (banner) banner.style.display = "none";
  } else {
    if (liveBadge) {
      liveBadge.textContent = "🌙 MARKET TUTUP";
      liveBadge.classList.add("market-closed");
    }
    if (banner) {
      banner.style.display = "flex";
      if (reasonEl && reason) reasonEl.textContent = reason;
    }
  }
}

// ══════════════════════════════════════════════
// MOBILE INFO BAR — update dari scheduler + stats
// ══════════════════════════════════════════════
function updateMobileInfoBar(schedulerData, statsData) {
  const dot   = document.getElementById("mib-dot");
  const label = document.getElementById("mib-label");

  // Scheduler status
  if (dot && label) {
    if (!schedulerData.market_open) {
      dot.textContent   = "🌙";
      dot.className     = "mib-dot off";
      label.textContent = "Market tutup";
    } else if (schedulerData.thread_alive) {
      dot.textContent   = "●";
      dot.className     = "mib-dot";
      label.textContent = schedulerData.next_run_time || "Aktif";
    } else {
      dot.textContent   = "●";
      dot.className     = "mib-dot off";
      label.textContent = "Tidak aktif!";
    }
  }

  // Stats
  if (statsData) {
    const buyEl  = document.getElementById("mib-buy");
    const sellEl = document.getElementById("mib-sell");
    const confEl = document.getElementById("mib-conf");
    if (buyEl)  buyEl.textContent  = statsData.total_buy  || 0;
    if (sellEl) sellEl.textContent = statsData.total_sell || 0;
    if (confEl) confEl.textContent = (statsData.avg_confidence || 0) + "%";
  }
}

// Hook ke syncSchedulerCountdown yang sudah ada
const _origSync = syncSchedulerCountdown;
// Update mobile bar saat sync
async function updateMobileBarFromStats() {
  try {
    const res  = await fetch("/api/stats");
    const data = await res.json();
    if (data.ok && window._lastSchedulerData) {
      updateMobileInfoBar(window._lastSchedulerData, data);
    }
  } catch(e) {}
}
setInterval(updateMobileBarFromStats, 60000);

// ══════════════════════════════════════════════
// MOBILE SECTIONS — Sync data ke elemen mobile
// ══════════════════════════════════════════════
function syncMobileSections(statsData, perfData, monitorsData, historyData, tradeHistoryData) {
  const isMobile = window.innerWidth <= 768;
  if (!isMobile) return;

  // Sync Statistik
  if (statsData) {
    const fields = {
      "m-stat-total": statsData.total_signals || 0,
      "m-stat-buy":   statsData.total_buy     || 0,
      "m-stat-sell":  statsData.total_sell    || 0,
      "m-stat-wait":  statsData.total_wait    || 0,
      "m-stat-conf":  (statsData.avg_confidence || 0) + "%",
    };
    Object.entries(fields).forEach(([id, val]) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    });
  }

  // Sync Performa
  if (perfData) {
    const fields = {
      "m-perf-total":  perfData.total_trades  || 0,
      "m-perf-wins":   perfData.wins          || 0,
      "m-perf-losses": perfData.losses        || 0,
      "m-perf-rate":   (perfData.win_rate     || 0) + "%",
      "m-perf-pips":   "$" + (perfData.total_pnl || 0),
      "m-perf-avg":    "$" + (perfData.avg_pnl   || 0),
    };
    Object.entries(fields).forEach(([id, val]) => {
      const el = document.getElementById(id);
      if (el) el.textContent = val;
    });
  }

  // Sync Monitor list
  const mMonitorList = document.getElementById("m-monitor-list");
  const mMonitorCount = document.getElementById("m-monitor-count");
  const desktopMonitorList = document.getElementById("monitor-list");
  if (mMonitorList && desktopMonitorList) {
    mMonitorList.innerHTML = desktopMonitorList.innerHTML;
  }
  if (mMonitorCount) {
    const cnt = document.getElementById("monitor-count");
    if (cnt) mMonitorCount.textContent = cnt.textContent;
  }

  // Sync History Signal
  const mHistList = document.getElementById("m-history-list");
  const desktopHistList = document.getElementById("history-list");
  if (mHistList && desktopHistList) {
    mHistList.innerHTML = desktopHistList.innerHTML;
  }

  // Sync Trade Outcomes
  const mTradeList = document.getElementById("m-trade-history-list");
  const desktopTradeList = document.getElementById("trade-history-list");
  if (mTradeList && desktopTradeList) {
    mTradeList.innerHTML = desktopTradeList.innerHTML;
  }
}

// Jalankan sync setiap kali data diupdate
// Hook ke loadStats, loadPerformance, loadActiveMonitors, loadHistory
const _origLoadStats = typeof loadStats === "function" ? loadStats : null;
setInterval(() => {
  if (window.innerWidth <= 768) {
    syncMobileSections(null, null, null, null, null);
  }
}, 5000);

// ══════════════════════════════════════════════
// REAL-TIME PRICE POLL — setiap 5 detik
// Ambil harga live dari bridge via /api/get_config
// Supaya topbar selalu menampilkan harga terkini
// bukan harga saat signal terakhir dibuat
// ══════════════════════════════════════════════
async function pollRealtimePrice() {
  try {
    const res  = await fetch("/api/get_config");
    const data = await res.json();
    if (!data.ok) return;

    const price = data.bridge_price > 0 ? data.bridge_price
                : data.live_price   > 0 ? data.live_price
                : data.twelve_price > 0 ? data.twelve_price
                : 0;

    if (price > 0) {
      const priceEl = document.getElementById("topbar-price");
      if (priceEl) {
        priceEl.textContent = "$" + Number(price).toLocaleString("en-US",
          { minimumFractionDigits: 2 });
      }
    }
  } catch(e) { /* silent fail */ }
}

// Poll harga real-time setiap 5 detik
setInterval(pollRealtimePrice, 5000);
pollRealtimePrice(); // langsung poll saat load

// ══════════════════════════════════════════════
// DASHBOARD LIVE TERMINAL WIDGET
// Update harga, candles, dan status Berkah Signal
// ══════════════════════════════════════════════

// Generate candle bars awal
(function initDashTerminal() {
  const patterns = [1,0,1,1,0,1,0,1,1,0,1,1,0,1,0,1,1,1,0,1];
  // Init desktop candles
  const container = document.getElementById('dt-candles');
  if (container) {
    patterns.forEach((up) => {
      const el = document.createElement('div');
      el.className = 'dt-candle ' + (up ? 'up' : 'dn');
      el.style.height = (30 + Math.random() * 70) + '%';
      container.appendChild(el);
    });
  }
  // Init mobile candles
  const mContainer = document.getElementById('m-dt-candles');
  if (mContainer) {
    patterns.forEach((up) => {
      const el = document.createElement('div');
      el.className = 'dt-candle ' + (up ? 'up' : 'dn');
      el.style.height = (30 + Math.random() * 70) + '%';
      mContainer.appendChild(el);
    });
  }
})();

let _dtBasePrice  = 0;
let _dtLastPrice  = 0;
let _dtNoiseTimer = null;

function updateDashTerminal(price, dataSource, signalData) {
  const priceEl  = document.getElementById('dt-price');
  const chgEl    = document.getElementById('dt-chg');
  const sourceEl = document.getElementById('dt-source');
  const statusEl = document.getElementById('dt-status');

  if (!priceEl) return;

  // Update harga
  if (price && price > 0) {
    const prev = _dtLastPrice || price;
    const diff = price - prev;
    const pct  = prev > 0 ? ((diff / prev) * 100) : 0;

    priceEl.textContent = price.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
    priceEl.style.color = diff >= 0 ? 'var(--gold)' : 'var(--red)';

    if (chgEl && _dtLastPrice > 0) {
      chgEl.textContent = (diff >= 0 ? '+' : '') + '$' + diff.toFixed(2) +
                          ' (' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%)';
      chgEl.style.color = diff >= 0 ? 'var(--green)' : 'var(--red)';
    }

    _dtLastPrice = price;

    // Animasi candle terakhir saat harga berubah
    const candles = document.querySelectorAll('#dt-candles .dt-candle');
    if (candles.length > 0) {
      const last = candles[candles.length - 1];
      last.className = 'dt-candle ' + (diff >= 0 ? 'up' : 'dn');
      last.style.height = (40 + Math.random() * 60) + '%';
    }
    // Sync candle mobile
    const mCandles = document.querySelectorAll('#m-dt-candles .dt-candle');
    if (mCandles.length > 0) {
      const mLast = mCandles[mCandles.length - 1];
      mLast.className = 'dt-candle ' + (diff >= 0 ? 'up' : 'dn');
      mLast.style.height = (40 + Math.random() * 60) + '%';
    }
  }

  // Update data source label
  if (sourceEl && dataSource) {
    const isBridge = dataSource.includes('MT5') || dataSource.includes('BRIDGE');
    sourceEl.textContent = isBridge
      ? '● Live via MT5 Bridge · ' + new Date().toLocaleTimeString('id-ID', {hour:'2-digit',minute:'2-digit'}) + ' WIB'
      : '⚡ Via Twelve Data · ' + new Date().toLocaleTimeString('id-ID', {hour:'2-digit',minute:'2-digit'}) + ' WIB';
    sourceEl.style.color = isBridge ? 'var(--green)' : '#4c9eff';
  }

  // Update status bar dari signal terakhir
  if (statusEl && signalData) {
    const mc  = signalData.method_confluence || {};
    const adx = mc.rsi_momentum ? mc.rsi_momentum.replace('RSI ','RSI ') : '--';
    const sig = signalData.signal || 'WAIT';

    let statusText = '';
    if (sig === 'BUY') {
      statusText = '🟢 BUY SIGNAL · ADX ' + (adx || '--');
      statusEl.style.color = 'var(--green)';
    } else if (sig === 'SELL') {
      statusText = '🔴 SELL SIGNAL · ADX ' + (adx || '--');
      statusEl.style.color = 'var(--red)';
    } else {
      // Ambil info dari reason
      const narrative = (signalData.narrative || '').substring(0, 40);
      statusText = '● SCANNING · ' + (narrative || 'Menunggu setup...');
      statusEl.style.color = 'var(--gold)';
    }
    statusEl.textContent = statusText;
  }

  // ── Sync ke widget mobile (m-dt-*) ──
  const mPriceEl  = document.getElementById('m-dt-price');
  const mChgEl    = document.getElementById('m-dt-chg');
  const mSourceEl = document.getElementById('m-dt-source');
  const mStatusEl = document.getElementById('m-dt-status');

  if (mPriceEl && priceEl) {
    mPriceEl.textContent  = priceEl.textContent;
    mPriceEl.style.color  = priceEl.style.color;
  }
  if (mChgEl && chgEl) {
    mChgEl.textContent = chgEl.textContent;
    mChgEl.style.color = chgEl.style.color;
  }
  if (mSourceEl && sourceEl) {
    mSourceEl.textContent = sourceEl.textContent;
    mSourceEl.style.color = sourceEl.style.color;
  }
  if (mStatusEl && statusEl) {
    mStatusEl.textContent = statusEl.textContent;
    mStatusEl.style.color = statusEl.style.color;
  }
}

// Hook ke pollLatestSignal — update widget setiap sinyal masuk
const _origPollSignal = pollLatestSignal;
// Patch: tambahkan update terminal setelah data masuk
// (sudah dilakukan via updateDashTerminalFromCache di bawah)

// Update terminal dari realtime price polling
async function updateDashTerminalFromPrice() {
  try {
    const res  = await fetch('/api/get_config');
    const data = await res.json();
    if (data.ok) {
      const price  = data.bridge_price > 0 ? data.bridge_price
                   : data.live_price > 0   ? data.live_price : 0;
      const source = data.price_source || '';
      updateDashTerminal(price, source, window._lastSignalData || null);
    }
  } catch(e) {}
}

// Poll harga untuk terminal setiap 3 detik
setInterval(updateDashTerminalFromPrice, 3000);
updateDashTerminalFromPrice();

// Update status bar dari signal data terbaru
function updateTerminalStatus(analysis) {
  const statusEl = document.getElementById('dt-status');
  if (!statusEl || !analysis) return;

  const sig  = analysis.signal || 'WAIT';
  const raw  = analysis.berkah_raw || {};
  // adx_available=false artinya ADX bukan pengukuran nyata untuk setup itu
  // (mis. Mean-Reversion yang memang tidak mengukur kekuatan trend) -- jangan
  // tampilkan angkanya. Sinyal lama di DB belum punya flag ini, jadi kalau
  // undefined tetap pakai cek nilai lama supaya riwayat tidak ikut jadi '--'.
  const adx  = (raw.adx_available === false || !raw.adx) ? '--' : raw.adx.toFixed(1);
  const cond = raw.conditions || {};

  if (sig === 'BUY') {
    statusEl.textContent = '🟢 BUY DETECTED · ADX ' + adx + ' · Berkah Confirmed';
    statusEl.style.color = 'var(--green)';
  } else if (sig === 'SELL') {
    statusEl.textContent = '🔴 SELL DETECTED · ADX ' + adx + ' · Berkah Confirmed';
    statusEl.style.color = 'var(--red)';
  } else {
    // Tampilkan kondisi yang sudah terpenuhi
    const met = [];
    if (cond.bull) {
      if (cond.bull.bos_bull)     met.push('BoS✓');
      if (cond.bull.liq_buy)      met.push('Liq✓');
      if (cond.bull.pin_bar_bull) met.push('Pin✓');
      if (cond.bull.adx_ok)       met.push('ADX' + adx + '✓');
    } else if (cond.bear) {
      if (cond.bear.bos_bear)     met.push('BoS✓');
      if (cond.bear.liq_sell)     met.push('Liq✓');
      if (cond.bear.pin_bar_bear) met.push('Pin✓');
      if (cond.bear.adx_ok)       met.push('ADX' + adx + '✓');
    }
    const metStr = met.length > 0 ? met.join(' · ') : 'ADX ' + adx;
    statusEl.textContent = '● SCANNING · ' + metStr;
    statusEl.style.color = 'var(--gold)';
  }

  // Sync ke mobile widget
  const mStatusEl = document.getElementById('m-dt-status');
  if (mStatusEl) {
    mStatusEl.textContent = statusEl.textContent;
    mStatusEl.style.color = statusEl.style.color;
  }
}


// ══════════════════════════════════════════════════════
// SESSION SCHEDULE — superadmin toggle panel
// ══════════════════════════════════════════════════════
const SESSION_LABELS = {
  london:   '🇬🇧 London',
  new_york: '🇺🇸 New York',
  tokyo:    '🇯🇵 Tokyo',
  sydney:   '🇦🇺 Sydney',
  off:      'Off-Hours',
};

let _schedState = {};   // mirror state dari server

async function loadSessionSchedule() {
  try {
    const res  = await fetch('/api/admin/session_schedule');
    if (!res.ok) return;   // bukan superadmin — diam saja
    const data = await res.json();
    if (!data.ok) return;

    _schedState = data.schedule;
    renderSessionSchedule(data.schedule, data.current_session, data.session_active);
  } catch (e) {}
}

function renderSessionSchedule(schedule, currentSess, sessActive) {
  if (typeof gxUpdateMapPins === "function") gxUpdateMapPins(currentSess);
  // Badge sesi sekarang — desktop & mobile
  const label = SESSION_LABELS[currentSess] || currentSess;
  const badgeClass = 'sched-curr-badge ' +
    (currentSess === 'off' ? '' : sessActive ? 'active-sess' : 'paused-sess');

  ['sched-curr-badge', 'm-sched-curr-badge'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = label; el.className = badgeClass; }
  });

  // Render tiap toggle — desktop (sched-toggle-*) dan mobile (m-sched-toggle-*)
  for (const [sess, enabled] of Object.entries(schedule)) {
    ['sched-toggle-' + sess, 'm-sched-toggle-' + sess].forEach(id => {
      const btn  = document.getElementById(id);
      const item = btn?.closest('.sched-item');
      if (!btn) return;
      btn.classList.toggle('on', enabled);
      if (item) {
        item.classList.toggle('is-current',  sess === currentSess);
        item.classList.toggle('is-disabled', !enabled);
      }
    });
  }

  // Status footer — desktop & mobile
  let statusText  = '';
  let statusColor = 'var(--text-dim)';
  if (currentSess === 'off') {
    statusText = 'Diluar jam sesi aktif';
  } else if (sessActive) {
    statusText  = '✅ Sistem aktif — ' + (SESSION_LABELS[currentSess] || currentSess);
    statusColor = 'var(--green)';
  } else {
    statusText  = '⏸ Dinonaktifkan untuk sesi ini';
    statusColor = 'var(--red)';
  }
  ['sched-status', 'm-sched-status'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = statusText; el.style.color = statusColor; }
  });
}

async function toggleSession(sessKey) {
  const currentEnabled = _schedState[sessKey] ?? true;
  const newEnabled     = !currentEnabled;

  // Optimistic update
  _schedState[sessKey] = newEnabled;
  const btn  = document.getElementById('sched-toggle-' + sessKey);
  const item = btn?.closest('.sched-item');
  if (btn) btn.classList.toggle('on', newEnabled);
  if (item) item.classList.toggle('is-disabled', !newEnabled);

  try {
    const res  = await fetch('/api/admin/session_schedule', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ [sessKey]: newEnabled }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error('Server error');

    // Re-render dengan state terbaru dari server
    _schedState = data.schedule;
    await loadSessionSchedule();   // refresh badge & status

    const label  = SESSION_LABELS[sessKey] || sessKey;
    const action = newEnabled ? '✅ Diaktifkan' : '⏸ Dinonaktifkan';
    showToast(`${action}: Sesi ${label}`);
  } catch (e) {
    // Rollback optimistic update
    _schedState[sessKey] = currentEnabled;
    if (btn) btn.classList.toggle('on', currentEnabled);
    if (item) item.classList.toggle('is-disabled', !currentEnabled);
    showToast('❌ Gagal update — coba lagi');
  }
}

// Load saat halaman buka, refresh tiap 30 detik
if (document.getElementById('session-sched-panel') || document.getElementById('m-session-sched-panel')) {
  loadSessionSchedule();
  setInterval(loadSessionSchedule, 30000);
}


// ── SESSION STATUS (user read-only panel) ──────────────────────────
async function loadUserSessionStatus() {
  const panel  = document.getElementById('session-status-panel');
  const mPanel = document.getElementById('m-session-status-panel');
  if (!panel && !mPanel) return;   // tidak ada panel user sama sekali

  try {
    const res  = await fetch('/api/session_status');
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok) return;

    const { current_session: curr, session_active: active, schedule } = data;
    if (typeof gxUpdateMapPins === "function") gxUpdateMapPins(curr);

    const labels = { london:'🇬🇧 London', new_york:'🇺🇸 New York', tokyo:'🇯🇵 Tokyo', sydney:'🇦🇺 Sydney', off:'Off-Hours' };
    const badgeClass = 'sched-curr-badge ' +
      (curr === 'off' ? '' : active ? 'active-sess' : 'paused-sess');

    // Badge — desktop & mobile
    ['user-sess-badge', 'm-user-sess-badge'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.textContent = labels[curr] || curr; el.className = badgeClass; }
    });

    // Dots — desktop (user-dot-*) dan mobile (m-user-dot-*)
    const sessKeys = ['london', 'new_york', 'tokyo', 'sydney'];
    for (const sess of sessKeys) {
      ['user-dot-' + sess, 'm-user-dot-' + sess].forEach(id => {
        const dot  = document.getElementById(id);
        const item = dot?.closest('.sched-item');
        if (!dot) return;

        const isCurrent = sess === curr;
        const isEnabled = schedule?.[sess] ?? true;

        dot.textContent = '●';
        dot.className   = 'sess-status-dot';
        dot.style.opacity = '';

        if (isCurrent && isEnabled) {
          dot.classList.add('dot-active', 'dot-current');
        } else if (isCurrent && !isEnabled) {
          dot.classList.add('dot-paused', 'dot-current');
        } else if (isEnabled) {
          dot.classList.add('dot-active');
          dot.style.opacity = '0.35';
        } else {
          dot.classList.add('dot-paused');
          dot.style.opacity = '0.35';
        }

        if (item) {
          item.classList.toggle('is-current',  isCurrent);
          item.classList.toggle('is-disabled', !isEnabled);
        }
      });
    }

    // Status footer — desktop & mobile
    let statusText  = '';
    let statusColor = 'var(--text-dim)';
    if (curr === 'off') {
      statusText = 'Diluar jam sesi aktif';
    } else if (active) {
      const lbl = { london:'London', new_york:'New York', tokyo:'Tokyo', sydney:'Sydney' };
      statusText  = '✅ Sistem aktif — Sesi ' + (lbl[curr] || curr);
      statusColor = 'var(--green)';
    } else {
      statusText  = '⏸ Sistem dijeda untuk sesi ini oleh admin';
      statusColor = 'var(--red)';
    }
    ['user-sess-status', 'm-user-sess-status'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.textContent = statusText; el.style.color = statusColor; }
    });

  } catch (e) {}
}

// Inisialisasi panel user jika ada (desktop atau mobile)
if (document.getElementById('session-status-panel') || document.getElementById('m-session-status-panel')) {
  loadUserSessionStatus();
  setInterval(loadUserSessionStatus, 30000);
}
