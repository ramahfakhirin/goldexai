"""
XAU/USD Chart Generator
=======================
Fetch OHLCV dari Twelve Data → render candlestick chart PNG
untuk dikirim ke Claude Vision API.

Output: base64 PNG string siap pakai di Anthropic messages API
"""

import base64
import io
import os
import urllib.request
import json
from datetime import datetime, timezone
from typing import Optional

import matplotlib
matplotlib.use("Agg")  # non-interactive backend untuk server
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import matplotlib.dates as mdates
import numpy as np
import pandas as pd


# ─────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────
TWELVE_BASE = "https://api.twelvedata.com"

CHART_STYLE = {
    "bg":        "#0f1117",
    "panel_bg":  "#0a0b0d",
    "grid":      "#1e2130",
    "text":      "#7b8099",
    "text_pri":  "#e8eaf0",
    "candle_up": "#26c17e",
    "candle_dn": "#e05252",
    "ema_21":    "#f0b429",
    "ema_50":    "#4c9eff",
    "ema_200":   "#e05252",
    "fvg_bull":  "#26c17e",
    "fvg_bear":  "#e05252",
    "volume_up": "#26c17e44",
    "volume_dn": "#e0525244",
    "signal_buy":  "#26c17e",
    "signal_sell": "#e05252",
}

TIMEFRAME_OUTPUTSIZE = {
    "5m":  100,
    "15m": 100,
    "1h":  80,
    "4h":  80,
    "1d":  60,
}


# ─────────────────────────────────────────────
# 1. FETCH DATA DARI TWELVE DATA
# ─────────────────────────────────────────────
def fetch_ohlcv(timeframe: str = "15min",
                api_key: str = "",
                outputsize: int = 100) -> pd.DataFrame:
    """Fetch OHLCV dari Twelve Data, return DataFrame."""

    # Twelve Data pakai format: 1min, 5min, 15min, 1h, 4h, 1day
    tf_map = {
        "5m": "5min", "15m": "15min",
        "1h": "1h",   "4h": "4h", "1d": "1day"
    }
    interval = tf_map.get(timeframe, "15min")

    url = (f"{TWELVE_BASE}/time_series"
           f"?symbol=XAU/USD"
           f"&interval={interval}"
           f"&outputsize={outputsize}"
           f"&apikey={api_key}")

    try:
        req  = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        resp = urllib.request.urlopen(req, timeout=15)
        data = json.loads(resp.read())
    except Exception as e:
        raise ValueError(f"Gagal fetch Twelve Data: {e}")

    if data.get("status") == "error":
        raise ValueError(f"Twelve Data error: {data.get('message')}")

    values = data.get("values", [])
    if not values:
        raise ValueError("Data kosong dari Twelve Data")

    df = pd.DataFrame(values)
    df["datetime"] = pd.to_datetime(df["datetime"])
    df = df.set_index("datetime").sort_index()

    for col in ["open", "high", "low", "close", "volume"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")

    return df.dropna()


# ─────────────────────────────────────────────
# 2. HITUNG EMA
# ─────────────────────────────────────────────
def calc_ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False).mean()


def detect_fvg(df: pd.DataFrame, lookback: int = 30) -> list:
    """Deteksi FVG terdekat dari harga sekarang."""
    zones = []
    current = df["close"].iloc[-1]

    for i in range(2, min(lookback, len(df))):
        idx   = -(i + 1)
        c1    = df.iloc[idx - 1]
        c3    = df.iloc[idx + 1] if abs(idx + 1) <= len(df) else df.iloc[-1]
        gap_b = c3["low"] - c1["high"]
        gap_s = c1["low"] - c3["high"]

        if gap_b > 0 and (gap_b / c1["high"]) > 0.0002:
            zones.append({
                "type": "BULL",
                "low":  float(c1["high"]),
                "high": float(c3["low"]),
                "dt":   df.index[len(df) + idx],
            })
        if gap_s > 0 and (gap_s / c1["low"]) > 0.0002:
            zones.append({
                "type": "BEAR",
                "low":  float(c3["high"]),
                "high": float(c1["low"]),
                "dt":   df.index[len(df) + idx],
            })

    # Sort by distance to current price
    zones.sort(key=lambda z: abs((z["low"] + z["high"]) / 2 - current))
    return zones[:4]


# ─────────────────────────────────────────────
# 3. RENDER CHART
# ─────────────────────────────────────────────
def render_chart(
    df: pd.DataFrame,
    timeframe: str,
    signal: str,            # "BUY" | "SELL" | "WAIT"
    entry: float = 0,
    stop_loss: float = 0,
    tp1: float = 0,
    tp2: float = 0,
    tp3: float = 0,
    confidence: int = 0,
    fvg_zones: list = None,
) -> bytes:
    """Render chart ke PNG bytes."""

    S   = CHART_STYLE
    dpi = 120

    # ── Setup figure ──
    fig = plt.figure(figsize=(14, 9), facecolor=S["bg"])
    fig.patch.set_facecolor(S["bg"])

    # Layout: main chart (70%) + volume (15%) + info panel (15%)
    gs = fig.add_gridspec(
        3, 1,
        height_ratios=[0.72, 0.15, 0.13],
        hspace=0.06,
        left=0.05, right=0.95,
        top=0.93, bottom=0.06
    )
    ax_main = fig.add_subplot(gs[0])
    ax_vol  = fig.add_subplot(gs[1], sharex=ax_main)
    ax_info = fig.add_subplot(gs[2])

    for ax in [ax_main, ax_vol, ax_info]:
        ax.set_facecolor(S["panel_bg"])
        ax.tick_params(colors=S["text"], labelsize=8)
        for spine in ax.spines.values():
            spine.set_color(S["grid"])

    # ── Candlestick ──
    n = len(df)
    x = np.arange(n)

    for i, (idx, row) in enumerate(df.iterrows()):
        op, hi, lo, cl = row["open"], row["high"], row["low"], row["close"]
        color  = S["candle_up"] if cl >= op else S["candle_dn"]
        body_b = min(op, cl)
        body_h = max(abs(cl - op), 0.1)

        # Wick
        ax_main.plot([i, i], [lo, hi], color=color, linewidth=0.7, zorder=2)
        # Body
        ax_main.bar(i, body_h, bottom=body_b,
                    color=color, width=0.7, zorder=3,
                    edgecolor=color, linewidth=0.3)

    # ── EMAs ──
    close = df["close"]
    ema21  = calc_ema(close, 21)
    ema50  = calc_ema(close, 50)
    ema200 = calc_ema(close, 200)

    ax_main.plot(x, ema21,  color=S["ema_21"],  linewidth=1.2, label="EMA 21",  zorder=4, alpha=0.9)
    ax_main.plot(x, ema50,  color=S["ema_50"],  linewidth=1.2, label="EMA 50",  zorder=4, alpha=0.9)
    ax_main.plot(x, ema200, color=S["ema_200"], linewidth=1.0, label="EMA 200", zorder=4, alpha=0.7, linestyle="--")

    # ── FVG Zones ──
    if fvg_zones:
        for fvg in fvg_zones[:3]:
            fcolor = S["fvg_bull"] if fvg["type"] == "BULL" else S["fvg_bear"]
            ax_main.axhspan(fvg["low"], fvg["high"],
                            alpha=0.08, color=fcolor, zorder=1)
            ax_main.axhline(fvg["low"],  color=fcolor, linewidth=0.4,
                            alpha=0.4, linestyle=":", zorder=1)
            ax_main.axhline(fvg["high"], color=fcolor, linewidth=0.4,
                            alpha=0.4, linestyle=":", zorder=1)

    # ── Signal Lines ──
    sig_color = S["signal_buy"] if signal == "BUY" else S["signal_sell"]

    if entry > 0:
        ax_main.axhline(entry, color=S["ema_50"], linewidth=1.2,
                        linestyle="--", alpha=0.8, zorder=5)
        ax_main.text(n - 1, entry, f" Entry {entry:.2f}",
                     color=S["ema_50"], fontsize=7, va="center",
                     fontweight="bold")

    if stop_loss > 0:
        ax_main.axhline(stop_loss, color=S["candle_dn"], linewidth=1.2,
                        linestyle="--", alpha=0.9, zorder=5)
        ax_main.text(n - 1, stop_loss, f" SL {stop_loss:.2f}",
                     color=S["candle_dn"], fontsize=7, va="center")

    tp_colors = ["#26c17e", "#4c9eff", "#f0b429"]
    for i_tp, (tp_val, tp_lbl) in enumerate(
        [(tp1, "TP1"), (tp2, "TP2"), (tp3, "TP3")]
    ):
        if tp_val > 0:
            ax_main.axhline(tp_val, color=tp_colors[i_tp],
                            linewidth=0.9, linestyle=":", alpha=0.8, zorder=5)
            ax_main.text(n - 1, tp_val, f" {tp_lbl} {tp_val:.2f}",
                         color=tp_colors[i_tp], fontsize=7, va="center")

    # ── Signal arrow di candle terakhir ──
    last_close = df["close"].iloc[-1]
    last_x     = n - 1
    if signal in ("BUY", "SELL"):
        arrow_dy = df["high"].std() * 0.6
        if signal == "BUY":
            ax_main.annotate("▲ BUY",
                xy=(last_x, last_close - arrow_dy * 0.3),
                xytext=(last_x - 4, last_close - arrow_dy * 1.5),
                color=sig_color, fontsize=10, fontweight="bold",
                arrowprops=dict(arrowstyle="->", color=sig_color, lw=1.5),
                zorder=6)
        else:
            ax_main.annotate("▼ SELL",
                xy=(last_x, last_close + arrow_dy * 0.3),
                xytext=(last_x - 4, last_close + arrow_dy * 1.5),
                color=sig_color, fontsize=10, fontweight="bold",
                arrowprops=dict(arrowstyle="->", color=sig_color, lw=1.5),
                zorder=6)

    # ── Price scale & grid ──
    ax_main.yaxis.set_label_position("right")
    ax_main.yaxis.tick_right()
    ax_main.grid(color=S["grid"], linewidth=0.4, alpha=0.6, zorder=0)
    ax_main.set_xlim(-1, n + 8)

    # Price range padding
    price_range = df["high"].max() - df["low"].min()
    ax_main.set_ylim(
        df["low"].min()  - price_range * 0.04,
        df["high"].max() + price_range * 0.08
    )

    # ── Legend ──
    legend_patches = [
        mpatches.Patch(color=S["ema_21"],  label="EMA 21"),
        mpatches.Patch(color=S["ema_50"],  label="EMA 50"),
        mpatches.Patch(color=S["ema_200"], label="EMA 200"),
    ]
    ax_main.legend(
        handles=legend_patches,
        loc="upper left", fontsize=7,
        framealpha=0.3,
        facecolor=S["bg"], edgecolor=S["grid"],
        labelcolor=S["text_pri"],
    )

    # ── X-axis labels (time) ──
    step    = max(1, n // 10)
    xticks  = list(range(0, n, step))
    xlabels = [df.index[i].strftime("%H:%M\n%d/%m") for i in xticks]
    ax_main.set_xticks(xticks)
    ax_main.set_xticklabels(xlabels, fontsize=7, color=S["text"])
    plt.setp(ax_main.get_xticklabels(), visible=False)

    # ── Volume bars ──
    if "volume" in df.columns:
        vol_colors = [
            S["volume_up"] if df["close"].iloc[i] >= df["open"].iloc[i]
            else S["volume_dn"]
            for i in range(n)
        ]
        ax_vol.bar(x, df["volume"], color=vol_colors, width=0.7, zorder=2)
        ax_vol.set_ylabel("Vol", color=S["text"], fontsize=7)
        ax_vol.grid(color=S["grid"], linewidth=0.3, alpha=0.5)
        ax_vol.set_xticks(xticks)
        ax_vol.set_xticklabels(xlabels, fontsize=6.5, color=S["text"])
        ax_vol.yaxis.tick_right()
        ax_vol.yaxis.set_label_position("right")
        ax_vol.tick_params(axis="y", labelsize=6)

    # ── Info bar ──
    ax_info.axis("off")

    current_price = df["close"].iloc[-1]
    prev_price    = df["close"].iloc[-2]
    pct_change    = (current_price - prev_price) / prev_price * 100

    sig_emoji = "🟢 BUY" if signal == "BUY" else "🔴 SELL" if signal == "SELL" else "🟡 WAIT"
    info_text = (
        f"XAU/USD  •  {timeframe.upper()}  •  "
        f"Price: ${current_price:,.2f}  "
        f"({'▲' if pct_change >= 0 else '▼'}{abs(pct_change):.2f}%)  •  "
        f"Signal: {sig_emoji}  •  "
        f"Confidence: {confidence}%  •  "
        f"{datetime.now().strftime('%d %b %Y  %H:%M WIB')}"
    )
    ax_info.text(
        0.01, 0.5, info_text,
        transform=ax_info.transAxes,
        fontsize=8.5, color=S["text_pri"],
        va="center", fontfamily="monospace",
        bbox=dict(boxstyle="round,pad=0.3",
                  facecolor=S["bg3"] if hasattr(S, "bg3") else "#1e2130",
                  edgecolor=S["grid"], alpha=0.8)
    )

    # ── Title ──
    title_color = (S["signal_buy"] if signal == "BUY"
                   else S["signal_sell"] if signal == "SELL"
                   else S["text_sec"] if True else "")
    fig.suptitle(
        f"XAU/USD  {timeframe.upper()}  —  {signal}",
        color=title_color if signal != "WAIT" else S["text"],
        fontsize=13, fontweight="bold", y=0.97,
        fontfamily="monospace"
    )

    # ── Render ke bytes ──
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=dpi,
                facecolor=S["bg"], bbox_inches="tight")
    plt.close(fig)
    buf.seek(0)
    return buf.read()


# ─────────────────────────────────────────────
# 4. MAIN FUNCTION — Generate + encode ke base64
# ─────────────────────────────────────────────
def generate_chart_b64(
    timeframe: str,
    api_key: str,
    signal: str,
    entry: float = 0,
    stop_loss: float = 0,
    tp1: float = 0,
    tp2: float = 0,
    tp3: float = 0,
    confidence: int = 0,
) -> dict:
    """
    Fetch data, render chart, return dict:
    {
        "b64": "<base64 PNG string>",
        "mime": "image/png",
        "price": float,
        "candles": int,
    }
    """
    outputsize = TIMEFRAME_OUTPUTSIZE.get(timeframe, 100)

    # Fetch OHLCV
    df = fetch_ohlcv(timeframe, api_key, outputsize)

    # Deteksi FVG
    fvgs = detect_fvg(df)

    # Render chart
    png_bytes = render_chart(
        df         = df,
        timeframe  = timeframe,
        signal     = signal,
        entry      = entry,
        stop_loss  = stop_loss,
        tp1        = tp1,
        tp2        = tp2,
        tp3        = tp3,
        confidence = confidence,
        fvg_zones  = fvgs,
    )

    return {
        "b64":     base64.b64encode(png_bytes).decode("utf-8"),
        "mime":    "image/png",
        "bytes":   png_bytes,
        "price":   float(df["close"].iloc[-1]),
        "candles": len(df),
        "fvgs":    fvgs,
    }


# ─────────────────────────────────────────────
# TEST (jalankan langsung untuk test)
# ─────────────────────────────────────────────
if __name__ == "__main__":
    import sys
    key = os.getenv("TWELVE_DATA_KEY", "")
    if not key:
        print("Set TWELVE_DATA_KEY dulu!")
        sys.exit(1)

    print("Generating test chart...")
    result = generate_chart_b64(
        timeframe  = "15m",
        api_key    = key,
        signal     = "SELL",
        entry      = 4326.0,
        stop_loss  = 4332.0,
        tp1        = 4318.0,
        tp2        = 4310.0,
        tp3        = 4300.0,
        confidence = 72,
    )
    with open("test_chart.png", "wb") as f:
        f.write(result["bytes"])
    print(f"Chart saved: test_chart.png ({result['candles']} candles, price ${result['price']:.2f})")
