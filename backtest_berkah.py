"""
Backtest — replikasi engine sinyal production (Confluence Score / "Berkah Signal")
====================================================================================
Simulasi walk-forward atas data historis GC=F (Gold Futures, Yahoo Finance) untuk
mengukur seberapa sering sistem BUY/SELL production akan profit kalau dijalankan
apa adanya selama N hari terakhir.

Mereplikasi PERSIS dari app.py + xauusd_ai_analyst.py:
  - HTF bias H1 (EMA50/200 vs ATR*0.5, fallback EMA20/50)         -> compute_htf_bias_from_h1
  - Confluence Score M5 (BoS, HTF BoS, Liquidity Sweep, Pin Bar,
    ADX, EMA price position, Session)                              -> detect_berkah_signal
  - Mean-Reversion M5 saat HTF RANGING                              -> detect_mean_reversion_signal
  - Gate skor: score >= MIN_CONFLUENCE_SCORE(5) auto-pass;
    3 <= score < 5 = zona Vision-rescue (di-skip, lihat batasan);
    score < 3 = WAIT
  - Signal cooldown 900s antar sinyal baru
  - Directional loss guard rolling-window (>=3 SL_HIT dari 6 trade CLOSED
    terakhir di arah itu -> blokir arah tsb 3 jam sejak SL terakhir).
    Cocok dengan is_direction_blocked() di app.py; BE_HIT bukan loss.
  - Satu trade aktif dalam satu waktu
  - Model posisi 3-way split: TP1 -> SL ke breakeven; TP2 -> SL ke TP1;
    TP3 -> full close; SL sebelum TP1 -> SL_HIT (loss penuh);
    SL setelah breakeven -> BE_HIT (bukan loss)

BATASAN (lihat laporan akhir):
  - Data GC=F (gold futures Yahoo) BUKAN spot XAU/USD yang dipakai production
    (Twelve Data) -- harga & likuiditas bisa sedikit berbeda.
  - Hanya M5 + Mean-Reversion yang disimulasikan. Layer M1 scalping production
    TIDAK ada di sini (Yahoo cuma kasih 7 hari data M1, jauh dari cukup untuk
    60 hari backtest) -- jadi jumlah sinyal riil real production kemungkinan
    LEBIH BANYAK dari yang tercatat di sini.
  - Zona "Vision-rescue" (skor 3-4) di-skip total (tidak disimulasikan sebagai
    WAIT ataupun sebagai trade) karena butuh panggilan Claude/Gemini Vision
    per candle -- assumsi konservatif, backtest ini HANYA menghitung sinyal
    high-confidence (skor >=5).
  - Order intra-candle SL vs TP saat keduanya tersentuh di candle 5m yang sama
    diasumsikan lewat heuristik "bullish candle: low dulu baru high" dan
    sebaliknya -- OHLC 5m tidak bisa membuktikan urutan sebenarnya.
"""

import os
import sys
import json
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
import yfinance as yf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import xauusd_ai_analyst as analyst
from xauusd_ai_analyst import (
    MarketData,
    calculate_indicators,
    detect_berkah_signal,
    detect_mean_reversion_signal,
    compute_htf_bias_from_h1,
)

# ── Konstanta production (disalin dari app.py) ──
MIN_CONFLUENCE_SCORE   = 5
VISION_RESCUE_MIN      = 3
SIGNAL_COOLDOWN_SEC    = 900
LOSS_STREAK_WINDOW     = 6
LOSS_STREAK_THRESHOLD  = 3
LOSS_STREAK_BLOCK_HRS  = 3.0
EARLY_BE_TRIGGER_RATIO = 0.85
EARLY_BE_MIN_POINTS    = 2.5
DISPLAY_LOT_SIZE       = 0.10
POINT_VALUE_PER_LOT    = 100.0
PNL_MULT               = DISPLAY_LOT_SIZE * POINT_VALUE_PER_LOT  # $10 / poin

WARMUP_BARS = 250  # cukup untuk EMA200 + ADX + swing lookback


def fetch_data():
    print("Fetching GC=F 5m (60d) dan 1h (200d) dari Yahoo Finance...")
    t = yf.Ticker("GC=F")
    df5 = t.history(period="60d", interval="5m")
    df1h = t.history(period="200d", interval="1h")

    for df in (df5, df1h):
        df.columns = [c.lower() for c in df.columns]

    df5 = df5[["open", "high", "low", "close", "volume"]].dropna()
    df1h = df1h[["open", "high", "low", "close", "volume"]].dropna()
    print(f"  M5: {len(df5)} candles ({df5.index.min()} -> {df5.index.max()})")
    print(f"  H1: {len(df1h)} candles ({df1h.index.min()} -> {df1h.index.max()})")
    return df5, df1h


def build_signal(df_m5_slice: pd.DataFrame, df_h1_slice: pd.DataFrame):
    """Replikasi persis app.py run_scheduled_analysis: HTF bias -> berkah M5 ->
    mean-reversion (kalau ranging) -> pilih 'best'."""
    htf_bias, _note = compute_htf_bias_from_h1(df_h1_slice)

    analyst.BRIDGE_DF = df_m5_slice
    market = MarketData(
        timeframe="5m", symbol="XAU/USD (Backtest)",
        current_price=round(float(df_m5_slice["close"].iloc[-1]), 2),
        open_=round(float(df_m5_slice["open"].iloc[-1]), 2),
        high=round(float(df_m5_slice["high"].iloc[-1]), 2),
        low=round(float(df_m5_slice["low"].iloc[-1]), 2),
        close=round(float(df_m5_slice["close"].iloc[-1]), 2),
        volume=round(float(df_m5_slice["volume"].iloc[-1]), 0),
        df=df_m5_slice,
    )
    indicators = calculate_indicators(market)

    sig_m5 = detect_berkah_signal(
        market, indicators,
        max_extension_atr=1.5,
        score_threshold=VISION_RESCUE_MIN,
        score_high_conf=5,
        htf_bias_override=htf_bias,
        htf_agg_factor=12,
    )
    sig_m5["timeframe"] = "M5"

    active = []
    if sig_m5.get("signal") in ("BUY", "SELL"):
        active.append(sig_m5)

    if htf_bias not in ("BULL", "BEAR"):
        sig_mr = detect_mean_reversion_signal(market, indicators)
        sig_mr["timeframe"] = "M5-MR"
        if sig_mr.get("signal") in ("BUY", "SELL"):
            active.append(sig_mr)

    if not active:
        return {"signal": "WAIT"}
    if len(active) == 1:
        return active[0]
    return max(active, key=lambda r: (
        2 if r.get("confidence") == "HIGH_CONFIDENCE" else 1, r.get("score", 0)))


def gain(direction, entry, price):
    return (price - entry) if direction == "BUY" else (entry - price)


def apply_tick(trade, price):
    """Port 1:1 dari app.py run_monitor_check() inner loop -- satu 'tick' harga."""
    direction = trade["direction"]
    entry, sl = trade["entry"], trade["sl"]
    tp1, tp2, tp3 = trade["tp1"], trade["tp2"], trade["tp3"]
    tp_hit = trade["tp_hit"]
    realized = trade["realized"]
    be_moved = trade["be_moved"]

    if direction == "BUY":
        hit_sl, hit_tp1, hit_tp2, hit_tp3 = price <= sl, price >= tp1, price >= tp2, price >= tp3
    else:
        hit_sl, hit_tp1, hit_tp2, hit_tp3 = price >= sl, price <= tp1, price <= tp2, price <= tp3

    outcome, should_close = None, False
    new_tp_hit, new_sl = tp_hit, sl

    if hit_sl:
        remaining = max(0.0, (3 - tp_hit) / 3.0)
        pnl = round(realized + remaining * gain(direction, entry, sl), 2)
        outcome = "SL_HIT" if (tp_hit == 0 and not be_moved) else "BE_HIT"
        should_close = True
        trade["realized"] = pnl
        trade["pnl"] = pnl
        trade["outcome"] = outcome
        trade["closed"] = True
        return outcome

    if hit_tp1 or hit_tp2 or hit_tp3:
        if hit_tp1 and new_tp_hit < 1:
            realized += gain(direction, entry, tp1) / 3.0
            new_tp_hit, new_sl, be_moved = 1, entry, 1
        if hit_tp2 and new_tp_hit < 2:
            realized += gain(direction, entry, tp2) / 3.0
            new_tp_hit, new_sl = 2, (tp1 or entry)
        if hit_tp3 and new_tp_hit < 3:
            realized += gain(direction, entry, tp3) / 3.0
            new_tp_hit = 3
            should_close = True

        if new_tp_hit > tp_hit:
            outcome = f"TP{new_tp_hit}_HIT"
            trade["tp_hit"], trade["sl"], trade["be_moved"] = new_tp_hit, new_sl, be_moved
            trade["realized"] = round(realized, 2)
            if should_close:
                trade["pnl"] = round(realized, 2)
                trade["outcome"] = "TP3_HIT"
                trade["closed"] = True
            return outcome

    elif be_moved == 0 and tp1 > 0:
        tp1_dist = abs(tp1 - entry)
        if tp1_dist > 0:
            best_gain = gain(direction, entry, price)
            ratio = best_gain / tp1_dist
            if ratio >= EARLY_BE_TRIGGER_RATIO and best_gain >= EARLY_BE_MIN_POINTS:
                trade["sl"], trade["be_moved"] = entry, 1
                return "EARLY_BE_MOVE"

    return None


def simulate_trade_forward(df_m5: pd.DataFrame, start_idx: int, trade: dict):
    """Walk forward candle demi candle sampai trade closed atau data habis."""
    n = len(df_m5)
    for i in range(start_idx, n):
        bar = df_m5.iloc[i]
        o, h, l, c = float(bar["open"]), float(bar["high"]), float(bar["low"]), float(bar["close"])
        # Heuristik urutan intra-candle: bullish -> low dulu baru high; bearish -> sebaliknya
        path = [l, h] if c >= o else [h, l]
        for px in path:
            outcome = apply_tick(trade, px)
            if trade.get("closed"):
                return i, trade["outcome"], trade["pnl"], df_m5.index[i]
        # end-of-bar tick di close (untuk EARLY_BE check dengan harga penutupan)
        apply_tick(trade, c)
        if trade.get("closed"):
            return i, trade["outcome"], trade["pnl"], df_m5.index[i]
    # Data habis sebelum closed -> mark-to-market di harga terakhir, exclude dari stats
    last_price = float(df_m5["close"].iloc[-1])
    unrealized = trade["realized"] + gain(trade["direction"], trade["entry"], last_price) * max(0, (3 - trade["tp_hit"]) / 3.0)
    return n - 1, "STILL_OPEN", round(unrealized, 2), df_m5.index[-1]


def run_backtest(df_m5: pd.DataFrame, df_h1: pd.DataFrame):
    trades = []
    last_signal_ts = None
    # Riwayat SEMUA trade CLOSED per arah (terbaru di akhir) -- window guard
    # butuh penyebutnya juga, bukan cuma SL, untuk hitung "3 dari 6".
    riwayat_arah = {"BUY": [], "SELL": []}

    i = WARMUP_BARS
    n = len(df_m5)
    skipped_vision_zone = 0

    while i < n:
        now_ts = df_m5.index[i]
        # Rolling window 500 candle -- sama seperti production (fetch_ohlcv_primary count=500),
        # bukan seluruh histori (menghindari O(n^2) sekaligus meniru perilaku asli).
        df_slice = df_m5.iloc[max(0, i + 1 - 500): i + 1]
        df_h1_slice = df_h1[df_h1.index <= now_ts].iloc[-300:]

        try:
            best = build_signal(df_slice, df_h1_slice)
        except Exception as e:
            i += 1
            continue

        sig = best.get("signal", "WAIT")
        score = best.get("score", 0)

        if sig in ("BUY", "SELL"):
            if score < MIN_CONFLUENCE_SCORE and best.get("confidence") != "HIGH_CONFIDENCE":
                if score < VISION_RESCUE_MIN:
                    sig = "WAIT"
                else:
                    skipped_vision_zone += 1
                    sig = "WAIT"

        if sig in ("BUY", "SELL"):
            # cooldown
            if last_signal_ts is not None and (now_ts - last_signal_ts).total_seconds() < SIGNAL_COOLDOWN_SEC:
                i += 1
                continue
            # Directional loss guard -- rolling window (lihat is_direction_blocked)
            window = riwayat_arah[sig][-LOSS_STREAK_WINDOW:]
            if len(window) >= LOSS_STREAK_THRESHOLD:
                sl_rows = [r for r in window if r[0] == "SL_HIT" and r[1] is not None]
                if len(sl_rows) >= LOSS_STREAK_THRESHOLD:
                    # Cooldown dari SL_HIT paling baru dalam window, bukan dari
                    # trade terakhir apa pun outcome-nya.
                    last_loss_ts = max(r[1] for r in sl_rows)
                    if (now_ts - last_loss_ts).total_seconds() < LOSS_STREAK_BLOCK_HRS * 3600:
                        i += 1
                        continue

            entry = float(best["entry"])
            sl, tp1, tp2, tp3 = float(best["sl"]), float(best["tp1"]), float(best["tp2"]), float(best["tp3"])
            if not sl or not tp1:
                i += 1
                continue

            trade = {
                "direction": sig, "entry": entry, "sl": sl, "tp1": tp1, "tp2": tp2, "tp3": tp3,
                "tp_hit": 0, "realized": 0.0, "be_moved": 0, "closed": False,
                "score": score, "confidence": best.get("confidence"), "timeframe": best.get("timeframe"),
                "opened_at": now_ts,
            }
            close_idx, outcome, pnl, closed_at = simulate_trade_forward(df_m5, i + 1, trade)
            cond = best.get("conditions", {}) or {}
            trades.append({
                "opened_at": now_ts, "closed_at": closed_at, "direction": sig,
                "entry": entry, "sl": sl, "tp1": tp1, "tp2": tp2, "tp3": tp3,
                "score": score, "confidence": best.get("confidence"), "timeframe": best.get("timeframe"),
                "outcome": outcome, "pnl_points": pnl,
                "pnl_usd": round(pnl * PNL_MULT, 2),
                # Faktor confluence individual -- dipakai buat analisa korelasi
                # faktor vs hasil trade (evaluasi apakah bobot +1 rata perlu
                # dikalibrasi ulang berdasarkan faktor mana yang benar prediktif).
                "f_bos":        cond.get("bos_bull") or cond.get("bos_bear") or False,
                "f_htf_bos":    cond.get("htf_bos_bull") or cond.get("htf_bos_bear") or False,
                "f_liq_sweep":  cond.get("liq_buy") or cond.get("liq_sell") or False,
                "f_pin_bar":    cond.get("pin_bar_bull") or cond.get("pin_bar_bear") or False,
                "f_adx_ok":     cond.get("adx_ok", False),
                "f_adx_value":  cond.get("adx_value", 0),
                "f_ema_price":  cond.get("ema_price_bull") or cond.get("ema_price_bear") or False,
                "f_session_ok": cond.get("session_ok", False),
            })

            last_signal_ts = now_ts
            riwayat_arah[sig].append((outcome, closed_at))

            i = close_idx + 1
            continue

        i += 1

    return trades, skipped_vision_zone


def summarize(trades):
    closed = [t for t in trades if t["outcome"] != "STILL_OPEN"]
    total = len(closed)
    wins = sum(1 for t in closed if t["pnl_usd"] > 0.01)
    losses = sum(1 for t in closed if t["pnl_usd"] < -0.01)
    neutral = total - wins - losses
    decisive = wins + losses
    win_rate = round(wins / decisive * 100, 1) if decisive else 0.0
    total_pnl = round(sum(t["pnl_usd"] for t in closed), 2)
    gross_profit = round(sum(t["pnl_usd"] for t in closed if t["pnl_usd"] > 0), 2)
    gross_loss = round(abs(sum(t["pnl_usd"] for t in closed if t["pnl_usd"] < 0)), 2)
    pf = round(gross_profit / gross_loss, 2) if gross_loss > 0 else (gross_profit or 0)
    by_outcome = {}
    for t in closed:
        by_outcome[t["outcome"]] = by_outcome.get(t["outcome"], 0) + 1

    return {
        "total_trades": total,
        "wins": wins, "losses": losses, "neutral": neutral,
        "win_rate_pct": win_rate,
        "total_pnl_usd": total_pnl,
        "gross_profit_usd": gross_profit,
        "gross_loss_usd": gross_loss,
        "profit_factor": pf,
        "by_outcome": by_outcome,
        "lot_size": DISPLAY_LOT_SIZE,
        "still_open_at_end": len(trades) - total,
    }


if __name__ == "__main__":
    df_m5, df_h1 = fetch_data()
    trades, skipped_vision = run_backtest(df_m5, df_h1)
    stats = summarize(trades)

    print("\n" + "=" * 60)
    print("BACKTEST RESULT — Confluence Score Engine (M5 + Mean-Reversion)")
    print("=" * 60)
    print(json.dumps(stats, indent=2))
    print(f"\nSinyal di zona Vision-rescue (skor 3-4) yang di-skip: {skipped_vision}")

    out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backtest_trades.csv")
    pd.DataFrame(trades).to_csv(out_path, index=False)
    print(f"\nDetail semua trade disimpan ke: {out_path}")

    stats_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backtest_summary.json")
    with open(stats_path, "w", encoding="utf-8") as f:
        json.dump({
            "period": {"m5_start": str(df_m5.index.min()), "m5_end": str(df_m5.index.max())},
            "stats": stats,
            "skipped_vision_zone_signals": skipped_vision,
        }, f, indent=2, default=str)
    print(f"Ringkasan JSON disimpan ke: {stats_path}")
