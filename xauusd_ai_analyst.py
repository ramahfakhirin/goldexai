"""
XAU/USD AI Trading Analyst
===========================
Fetch harga XAU/USD → hitung indikator teknikal → deteksi struktur SMC
→ kirim ke Claude API → output signal trading terstruktur

Setup:
    pip install anthropic yfinance ta

Jalankan:
    python xauusd_ai_analyst.py
    python xauusd_ai_analyst.py --timeframe 1h
    python xauusd_ai_analyst.py --timeframe 15m --save
"""

import argparse
import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime

import anthropic
import numpy as np
import pandas as pd
import requests
import yfinance as yf
import ta

# ─────────────────────────────────────────────
# KONFIGURASI
# ─────────────────────────────────────────────
ANTHROPIC_API_KEY  = os.getenv("ANTHROPIC_API_KEY",  "YOUR_ANTHROPIC_KEY")
TWELVE_DATA_KEY    = os.getenv("TWELVE_DATA_KEY",   "")   # set di environment

# MT5 Bridge OHLCV injection — di-set oleh app.py sebelum memanggil fetch_market_data
BRIDGE_DF = None

# ── Twelve Data interval mapping ──
TWELVE_INTERVAL = {
    "1m":  {"interval": "1min",  "outputsize": 500,  "label": "1 Menit"},
    "5m":  {"interval": "5min",  "outputsize": 500,  "label": "5 Menit"},
    "15m": {"interval": "15min", "outputsize": 500,  "label": "15 Menit"},
    "1h":  {"interval": "1h",    "outputsize": 500,  "label": "1 Jam"},
    "4h":  {"interval": "4h",    "outputsize": 500,  "label": "4 Jam"},
    "1d":  {"interval": "1day",  "outputsize": 500,  "label": "Daily"},
}

# ── Yahoo Finance fallback config ──
TIMEFRAME_CONFIG = {
    "5m":  {"period": "5d",   "interval": "5m",  "label": "5 Menit"},
    "15m": {"period": "30d",  "interval": "15m", "label": "15 Menit"},
    "1h":  {"period": "60d",  "interval": "1h",  "label": "1 Jam"},
    "4h":  {"period": "180d", "interval": "4h",  "label": "4 Jam"},
    "1d":  {"period": "2y",   "interval": "1d",  "label": "Daily"},
}

SYMBOL = "XAUUSD=X"  # Yahoo Finance fallback symbol


# ─────────────────────────────────────────────
# DATA CLASSES
# ─────────────────────────────────────────────
@dataclass
class MarketData:
    timeframe: str
    symbol: str
    current_price: float
    open_: float
    high: float
    low: float
    close: float
    volume: float
    df: pd.DataFrame


@dataclass
class Indicators:
    ema_21: float
    ema_50: float
    ema_55: float        # untuk metode EMA 55 channel
    ema_200: float
    rsi_14: float
    macd: float
    macd_signal: float
    macd_hist: float
    atr_14: float
    bb_upper: float
    bb_lower: float
    bb_middle: float
    stoch_k: float
    stoch_d: float
    ha_bias: str = "NEUTRAL"       # Heiken Ashi bias: BULLISH / BEARISH / NEUTRAL
    ha_trend_strength: str = "WEAK" # STRONG / MODERATE / WEAK


@dataclass
class SMCStructure:
    trend: str              # BULLISH / BEARISH / RANGING
    last_bos: str           # BOS UP / BOS DOWN / NONE
    last_choch: str         # CHoCH UP / CHoCH DOWN / NONE
    fvg_zones: list         # list of (price_low, price_high, type)
    ob_zones: list          # list of (price_low, price_high, type)
    support_levels: list    # key support levels
    resistance_levels: list # key resistance levels
    swing_high: float
    swing_low: float


# ─────────────────────────────────────────────
# 1. FETCH MARKET DATA
# ─────────────────────────────────────────────
def _fetch_twelve_data(timeframe: str) -> pd.DataFrame:
    """
    Ambil OHLCV dari Twelve Data API (primary source).
    Return DataFrame kosong kalau gagal.
    """
    if not TWELVE_DATA_KEY:
        return pd.DataFrame()

    cfg = TWELVE_INTERVAL.get(timeframe, TWELVE_INTERVAL["1h"])
    url = "https://api.twelvedata.com/time_series"
    params = {
        "symbol":     "XAU/USD",
        "interval":   cfg["interval"],
        "outputsize": cfg["outputsize"],
        "apikey":     TWELVE_DATA_KEY,
        "format":     "JSON",
        "order":      "ASC",   # oldest → newest
    }

    try:
        resp = requests.get(url, params=params, timeout=15)
        resp.raise_for_status()
        data = resp.json()

        if data.get("status") == "error" or "values" not in data:
            print(f"  ⚠️  Twelve Data error: {data.get('message', 'unknown')}")
            return pd.DataFrame()

        values = data["values"]
        df = pd.DataFrame(values)
        df.index = pd.to_datetime(df["datetime"])
        df = df.drop(columns=["datetime"])
        df = df.rename(columns={"open": "open", "high": "high",
                                 "low": "low", "close": "close",
                                 "volume": "volume"})
        # Twelve Data returns strings — convert to float
        for col in ["open", "high", "low", "close"]:
            df[col] = pd.to_numeric(df[col], errors="coerce")
        # volume tidak selalu ada untuk forex
        if "volume" in df.columns:
            df["volume"] = pd.to_numeric(df["volume"], errors="coerce").fillna(0)
        else:
            df["volume"] = 0.0

        df = df[["open", "high", "low", "close", "volume"]].dropna(
            subset=["open", "high", "low", "close"]
        )
        return df

    except Exception as e:
        print(f"  ⚠️  Twelve Data fetch error: {e}")
        return pd.DataFrame()


def _fetch_yahoo_data(timeframe: str) -> tuple[pd.DataFrame, str]:
    """
    Ambil OHLCV dari Yahoo Finance (fallback).
    Return (DataFrame, source_label).
    """
    config = TIMEFRAME_CONFIG.get(timeframe, TIMEFRAME_CONFIG["1h"])
    for sym in [SYMBOL, "GC=F"]:
        try:
            ticker = yf.Ticker(sym)
            df = ticker.history(period=config["period"], interval=config["interval"])
            if not df.empty:
                df = df.dropna()
                df.index = pd.to_datetime(df.index)
                df.columns = [c.lower() for c in df.columns]
                df = df[["open", "high", "low", "close", "volume"]]
                label = "Spot (Yahoo)" if sym == SYMBOL else "Futures GC=F (Yahoo)"
                return df, label
        except Exception as e:
            print(f"  ⚠️  Yahoo Finance {sym} error: {e}")
    return pd.DataFrame(), ""


def fetch_market_data(timeframe: str = "1h") -> MarketData:
    """
    Ambil data XAU/USD OHLCV dari Twelve Data (satu-satunya sumber).
    """
    tf_label = TWELVE_INTERVAL.get(timeframe, {}).get("label", timeframe)
    print(f"  📡 Mengambil data XAU/USD [{tf_label}] dari Twelve Data...")

    # ── Twelve Data (satu-satunya sumber) ──
    if BRIDGE_DF is not None and not BRIDGE_DF.empty:
        # BRIDGE_DF di-inject oleh app.py (sudah berisi data dari Twelve Data,
        # nama variabel dipertahankan untuk kompatibilitas)
        df          = BRIDGE_DF.copy()
        data_source = "Twelve Data (Real-time Spot)"
        print(f"  ✅ {data_source} — {len(df)} candles")
    else:
        df = _fetch_twelve_data(timeframe)
        data_source = "Twelve Data (Real-time Spot)"
        if df.empty:
            raise ValueError(
                "Gagal mengambil data dari Twelve Data. "
                "Cek TWELVE_DATA_KEY di Railway Variables dan kuota harian."
            )
        print(f"  ✅ {data_source} — {len(df)} candles")

    latest = df.iloc[-1]

    return MarketData(
        timeframe=timeframe,
        symbol=f"XAU/USD ({data_source})",
        current_price=round(float(latest["close"]), 2),
        open_=round(float(latest["open"]), 2),
        high=round(float(latest["high"]), 2),
        low=round(float(latest["low"]), 2),
        close=round(float(latest["close"]), 2),
        volume=round(float(latest["volume"]), 0),
        df=df,
    )


# ─────────────────────────────────────────────
# 2. HITUNG INDIKATOR TEKNIKAL
# ─────────────────────────────────────────────
def calculate_indicators(market: MarketData) -> Indicators:
    """Hitung semua indikator teknikal dari OHLCV data."""
    print("  📊 Menghitung indikator teknikal...")

    df = market.df
    close = df["close"]
    high = df["high"]
    low = df["low"]

    # EMA
    ema_21  = ta.trend.EMAIndicator(close, window=21).ema_indicator()
    ema_50  = ta.trend.EMAIndicator(close, window=50).ema_indicator()
    ema_200 = ta.trend.EMAIndicator(close, window=200).ema_indicator()

    # RSI
    rsi = ta.momentum.RSIIndicator(close, window=14).rsi()

    # MACD
    macd_ind = ta.trend.MACD(close)
    
    # ATR
    atr = ta.volatility.AverageTrueRange(high, low, close, window=14).average_true_range()

    # Bollinger Bands
    bb = ta.volatility.BollingerBands(close, window=20, window_dev=2)

    # Stochastic
    stoch = ta.momentum.StochasticOscillator(high, low, close)

    def safe_val(series, default=0.0):
        """Ambil nilai terakhir yang valid dari series."""
        try:
            val = series.dropna().iloc[-1]
            return round(float(val), 4)
        except (IndexError, TypeError):
            return default

    # EMA 55
    ema_55 = ta.trend.EMAIndicator(close, window=55).ema_indicator()

    # ── Heiken Ashi calculation ──
    ha_close = (df["open"] + df["high"] + df["low"] + df["close"]) / 4
    ha_open  = ha_close.copy()
    for i in range(1, len(ha_close)):
        ha_open.iloc[i] = (ha_open.iloc[i-1] + ha_close.iloc[i-1]) / 2
    ha_high  = pd.concat([df["high"], ha_open, ha_close], axis=1).max(axis=1)
    ha_low   = pd.concat([df["low"],  ha_open, ha_close], axis=1).min(axis=1)

    # Bias dari 3 candle HA terakhir
    recent_ha = pd.DataFrame({"open": ha_open, "close": ha_close}).iloc[-5:]
    bull_count = (recent_ha["close"] > recent_ha["open"]).sum()
    bear_count = (recent_ha["close"] < recent_ha["open"]).sum()
    if bull_count >= 4:
        ha_bias = "BULLISH"
        ha_strength = "STRONG" if bull_count == 5 else "MODERATE"
    elif bear_count >= 4:
        ha_bias = "BEARISH"
        ha_strength = "STRONG" if bear_count == 5 else "MODERATE"
    elif bull_count >= 3:
        ha_bias = "BULLISH"
        ha_strength = "WEAK"
    elif bear_count >= 3:
        ha_bias = "BEARISH"
        ha_strength = "WEAK"
    else:
        ha_bias = "NEUTRAL"
        ha_strength = "WEAK"

    return Indicators(
        ema_21=safe_val(ema_21),
        ema_50=safe_val(ema_50),
        ema_55=safe_val(ema_55),
        ema_200=safe_val(ema_200),
        rsi_14=safe_val(rsi),
        macd=safe_val(macd_ind.macd()),
        macd_signal=safe_val(macd_ind.macd_signal()),
        macd_hist=safe_val(macd_ind.macd_diff()),
        atr_14=safe_val(atr),
        bb_upper=safe_val(bb.bollinger_hband()),
        bb_lower=safe_val(bb.bollinger_lband()),
        bb_middle=safe_val(bb.bollinger_mavg()),
        stoch_k=safe_val(stoch.stoch()),
        stoch_d=safe_val(stoch.stoch_signal()),
        ha_bias=ha_bias,
        ha_trend_strength=ha_strength,
    )


# ─────────────────────────────────────────────
# 3. DETEKSI STRUKTUR SMC
# ─────────────────────────────────────────────
def detect_smc_structure(market: MarketData) -> SMCStructure:
    """Deteksi struktur market Smart Money Concepts (SMC)."""
    print("  🔍 Mendeteksi struktur SMC...")

    df = market.df.copy()
    close = df["close"]
    high  = df["high"]
    low   = df["low"]

    # ── Swing Highs & Lows (lookback 5 candle) ──
    lookback = 5
    swing_highs = []
    swing_lows  = []

    for i in range(lookback, len(df) - lookback):
        if high.iloc[i] == high.iloc[i-lookback:i+lookback+1].max():
            swing_highs.append((i, high.iloc[i]))
        if low.iloc[i] == low.iloc[i-lookback:i+lookback+1].min():
            swing_lows.append((i, low.iloc[i]))

    # Ambil swing terakhir
    last_sh = swing_highs[-1][1] if swing_highs else high.iloc[-20:].max()
    last_sl = swing_lows[-1][1]  if swing_lows  else low.iloc[-20:].min()

    # ── Trend Bias ──
    recent_highs = [sh[1] for sh in swing_highs[-3:]]
    recent_lows  = [sl[1] for sl in swing_lows[-3:]]

    if len(recent_highs) >= 2 and len(recent_lows) >= 2:
        hh = recent_highs[-1] > recent_highs[-2]
        hl = recent_lows[-1]  > recent_lows[-2]
        lh = recent_highs[-1] < recent_highs[-2]
        ll = recent_lows[-1]  < recent_lows[-2]

        if hh and hl:
            trend = "BULLISH"
        elif lh and ll:
            trend = "BEARISH"
        else:
            trend = "RANGING"
    else:
        trend = "RANGING"

    # ── BOS / CHoCH Detection ──
    bos  = "NONE"
    choch = "NONE"
    current_close = close.iloc[-1]

    if swing_highs and current_close > swing_highs[-1][1]:
        if trend == "BEARISH":
            choch = "CHoCH UP (potential reversal)"
        else:
            bos = "BOS UP (bullish continuation)"

    elif swing_lows and current_close < swing_lows[-1][1]:
        if trend == "BULLISH":
            choch = "CHoCH DOWN (potential reversal)"
        else:
            bos = "BOS DOWN (bearish continuation)"

    # ── Fair Value Gap (FVG) Detection ──
    fvg_zones = []
    min_gap_pct = 0.0003  # 0.03% minimum gap

    for i in range(2, len(df)):
        candle_1 = df.iloc[i-2]  # candle pertama
        candle_3 = df.iloc[i]    # candle ketiga

        # Bullish FVG: low candle-3 > high candle-1
        gap_bull = candle_3["low"] - candle_1["high"]
        if gap_bull > 0 and gap_bull / candle_1["high"] > min_gap_pct:
            fvg_zones.append({
                "type": "BULLISH FVG",
                "low":  round(float(candle_1["high"]), 2),
                "high": round(float(candle_3["low"]), 2),
                "index": i,
            })

        # Bearish FVG: high candle-3 < low candle-1
        gap_bear = candle_1["low"] - candle_3["high"]
        if gap_bear > 0 and gap_bear / candle_1["low"] > min_gap_pct:
            fvg_zones.append({
                "type": "BEARISH FVG",
                "low":  round(float(candle_3["high"]), 2),
                "high": round(float(candle_1["low"]), 2),
                "index": i,
            })

    # Ambil 5 FVG terdekat dengan harga sekarang
    fvg_zones = sorted(
        fvg_zones[-30:],
        key=lambda z: abs((z["low"] + z["high"]) / 2 - current_close)
    )[:5]

    # ── Order Block Detection (simplified) ──
    ob_zones = []
    ob_lookback = min(30, len(df) - 1)

    for i in range(1, ob_lookback):
        idx = -(i + 1)
        candle = df.iloc[idx]
        next_c = df.iloc[idx + 1]

        body_size = abs(candle["close"] - candle["open"])
        avg_body  = abs(df["close"] - df["open"]).rolling(10).mean().iloc[idx]

        if body_size < avg_body * 0.5:  # small body = potential OB
            continue

        # Bullish OB: bearish candle diikuti strong bullish move
        if candle["close"] < candle["open"] and next_c["close"] > candle["high"]:
            ob_zones.append({
                "type": "BULLISH OB",
                "low":  round(float(candle["low"]), 2),
                "high": round(float(candle["open"]), 2),
                "index": idx,
            })

        # Bearish OB: bullish candle diikuti strong bearish move
        elif candle["close"] > candle["open"] and next_c["close"] < candle["low"]:
            ob_zones.append({
                "type": "BEARISH OB",
                "low":  round(float(candle["close"]), 2),
                "high": round(float(candle["high"]), 2),
                "index": idx,
            })

    ob_zones = sorted(
        ob_zones,
        key=lambda z: abs((z["low"] + z["high"]) / 2 - current_close)
    )[:4]

    # ── Key Levels ──
    recent_highs_prices = [sh[1] for sh in swing_highs[-5:]]
    recent_lows_prices  = [sl[1] for sl in swing_lows[-5:]]

    support_levels    = sorted([round(l, 2) for l in recent_lows_prices],  reverse=True)[:3]
    resistance_levels = sorted([round(h, 2) for h in recent_highs_prices])[:3]

    return SMCStructure(
        trend=trend,
        last_bos=bos,
        last_choch=choch,
        fvg_zones=fvg_zones,
        ob_zones=ob_zones,
        support_levels=support_levels,
        resistance_levels=resistance_levels,
        swing_high=round(last_sh, 2),
        swing_low=round(last_sl, 2),
    )


# ─────────────────────────────────────────────
# 3B. GAINZALGO V2 — SIGNAL DETECTION (Python native)
# ─────────────────────────────────────────────
def detect_gainzalgo_signal(
    market: MarketData,
    indicators: Indicators,
    rrr: str = "1:2",
    tp_sl_multi: float = 1.0,
    candle_stability_index: float = 0.7,
    rsi_index: float = 80.0,
    candle_delta_length: int = 10,
) -> dict:
    """
    Replikasi logika GainzAlgo V2 Pine Script ke Python.

    BUY conditions (semua harus True):
      1. Bullish Engulfing: close[1]<open[1], close>open, close>open[1]
      2. Stable Candle: |close-open| / true_range > 0.7
      3. RSI < 80
      4. Decrease Over 10: close < close[10] (pullback dari atas)

    SELL conditions (semua harus True):
      1. Bearish Engulfing: close[1]>open[1], close<open, close<open[1]
      2. Stable Candle: |close-open| / true_range > 0.7
      3. RSI > 20 (100 - 80)
      4. Increase Over 10: close > close[10] (pullback dari bawah)

    TP/SL: berbasis ATR × tp_sl_multi, RRR 1:2 default
    """
    df  = market.df.copy()
    atr = indicators.atr_14
    rsi = indicators.rsi_14

    if len(df) < candle_delta_length + 2:
        return {"signal": "WAIT", "reason": "Data tidak cukup"}

    # Candle sekarang (indeks -1) dan sebelumnya (-2)
    c_now  = df.iloc[-1]   # candle terkini (confirmed)
    c_prev = df.iloc[-2]   # candle sebelumnya

    o_now,  c_now_close  = float(c_now["open"]),  float(c_now["close"])
    o_prev, c_prev_close = float(c_prev["open"]), float(c_prev["close"])
    h_now  = float(c_now["high"])
    l_now  = float(c_now["low"])

    # True Range untuk candle sekarang
    true_range = max(
        h_now - l_now,
        abs(h_now - c_prev_close),
        abs(l_now  - c_prev_close),
    )
    body = abs(c_now_close - o_now)
    stable_candle = (body / true_range > candle_stability_index) if true_range > 0 else False

    # Close 10 candle lalu
    close_n_ago = float(df.iloc[-1 - candle_delta_length]["close"])

    # ── Evaluasi kondisi BUY ──
    bull_engulfing  = (c_prev_close < o_prev) and (c_now_close > o_now) and (c_now_close > o_prev)
    rsi_below       = rsi < rsi_index
    decrease_over   = c_now_close < close_n_ago

    bull_conditions = {
        "bullish_engulfing": bull_engulfing,
        "stable_candle":     stable_candle,
        "rsi_below_80":      rsi_below,
        "decrease_over_10":  decrease_over,
    }
    bull_signal = all(bull_conditions.values())

    # ── Evaluasi kondisi SELL ──
    bear_engulfing  = (c_prev_close > o_prev) and (c_now_close < o_now) and (c_now_close < o_prev)
    rsi_above       = rsi > (100 - rsi_index)
    increase_over   = c_now_close > close_n_ago

    bear_conditions = {
        "bearish_engulfing": bear_engulfing,
        "stable_candle":     stable_candle,
        "rsi_above_20":      rsi_above,
        "increase_over_10":  increase_over,
    }
    bear_signal = all(bear_conditions.values())

    # ── Hitung TP/SL ──
    dist = atr * tp_sl_multi
    rrr_map = {"2:3": 1.5, "1:2": 2.0, "1:4": 4.0, "1:1": 1.0}
    tp_mult = rrr_map.get(rrr, 2.0)
    tp_dist = dist * tp_mult

    price = c_now_close

    if bull_signal:
        signal   = "BUY"
        tp       = round(price + tp_dist, 2)
        sl       = round(price - dist, 2)
        entry    = price
        reason   = f"Bullish engulfing + stable candle + RSI {rsi:.1f}<80 + price turun dari {close_n_ago:.2f} ({candle_delta_length}c lalu)"
    elif bear_signal:
        signal   = "SELL"
        tp       = round(price - tp_dist, 2)
        sl       = round(price + dist, 2)
        entry    = price
        reason   = f"Bearish engulfing + stable candle + RSI {rsi:.1f}>20 + price naik dari {close_n_ago:.2f} ({candle_delta_length}c lalu)"
    else:
        signal   = "WAIT"
        tp       = 0.0
        sl       = 0.0
        entry    = price

        # Bangun reason detail untuk log
        missing_bull = [k for k, v in bull_conditions.items() if not v]
        missing_bear = [k for k, v in bear_conditions.items() if not v]
        reason = f"No setup — bull_miss={missing_bull} | bear_miss={missing_bear}"

    return {
        "signal":     signal,
        "entry":      round(entry, 2),
        "tp":         tp,
        "sl":         sl,
        "atr":        round(atr, 2),
        "dist":       round(dist, 2),
        "rsi":        round(rsi, 2),
        "rrr":        rrr,
        "reason":     reason,
        "conditions": {
            "bull": bull_conditions,
            "bear": bear_conditions,
        },
    }



def build_analysis_prompt(
    market: MarketData,
    indicators: Indicators,
    smc: SMCStructure,
    timeframe: str = "5m",
) -> str:
    """
    Build prompt analisis XAU/USD — Multi-Method Scalping:
    EMA Trend Filter + RSI Momentum + Break & Retest +
    Heiken Ashi Bias + ATR Risk Management + Session Filter
    """
    from datetime import timezone, timedelta
    WIB = timezone(timedelta(hours=7))

    price = market.current_price
    atr   = indicators.atr_14

    # ── EMA Trend ──
    ema_trend  = "BULLISH" if indicators.ema_21 > indicators.ema_50 else "BEARISH"
    ema_strong = "STRONG"  if abs(indicators.ema_21 - indicators.ema_50) > atr * 0.5 else "WEAK"
    above_200  = "DI ATAS" if price > indicators.ema_200 else "DI BAWAH"

    # EMA 55 Channel
    ema55_pos = "ABOVE" if price > indicators.ema_55 else "BELOW"

    # ── RSI Zone ──
    rsi = indicators.rsi_14
    if rsi >= 70:
        rsi_zone = "OVERBOUGHT (>70) — potensi reversal/koreksi"
    elif rsi <= 30:
        rsi_zone = "OVERSOLD (<30) — potensi bounce/reversal"
    elif rsi >= 55:
        rsi_zone = "BULLISH_MOMENTUM (55–70) — momentum naik kuat"
    elif rsi <= 45:
        rsi_zone = "BEARISH_MOMENTUM (30–45) — momentum turun kuat"
    else:
        rsi_zone = "NEUTRAL (45–55) — tidak ada momentum jelas"

    # ── MACD ──
    macd_cross = "BULLISH" if indicators.macd > indicators.macd_signal else "BEARISH"
    hist_dir   = "NAIK" if indicators.macd_hist > 0 else "TURUN"

    # ── Session Filter ──
    now_wib    = datetime.now(WIB)
    hour_wib   = now_wib.hour
    if 14 <= hour_wib <= 23:
        session      = "LONDON/NY_OVERLAP"
        session_qual = "HIGHEST — likuiditas tertinggi, pergerakan paling valid"
    elif 8 <= hour_wib <= 13:
        session_qual = "HIGH — London session, bagus untuk trade"
        session      = "LONDON"
    elif 0 <= hour_wib <= 2:
        session      = "NY_CLOSE"
        session_qual = "MEDIUM — NY closing, volatilitas menurun"
    else:
        session      = "ASIA_OR_OFF"
        session_qual = "LOW — sesi Asia/off-hours, hindari entry baru"

    # ── ATR-based SL/TP (adaptif per timeframe) ──
    tf_sl = {"5m": (0.8,1.0,1.2), "15m": (1.0,1.2,1.5), "1h": (1.2,1.5,2.0), "4h": (1.5,2.0,2.5), "1d": (2.0,2.5,3.0)}
    tf_tp = {"5m": (1.2,2.0,3.0), "15m": (1.3,2.2,3.5), "1h": (1.5,2.5,4.0), "4h": (1.5,2.5,4.0), "1d": (1.5,3.0,5.0)}
    sl_mult_min, sl_mult_opt, sl_mult_max = tf_sl.get(timeframe, (1.0,1.2,1.5))
    tp1_rr, tp2_rr, tp3_rr              = tf_tp.get(timeframe, (1.3,2.2,3.5))

    sl_min  = round(atr * sl_mult_min, 2)
    sl_opt  = round(atr * sl_mult_opt, 2)
    sl_max  = round(atr * sl_mult_max, 2)

    buy_sl  = round(price - sl_opt, 2)
    buy_tp1 = round(price + sl_opt * tp1_rr, 2)
    buy_tp2 = round(price + sl_opt * tp2_rr, 2)
    buy_tp3 = round(price + sl_opt * tp3_rr, 2)

    sell_sl  = round(price + sl_opt, 2)
    sell_tp1 = round(price - sl_opt * tp1_rr, 2)
    sell_tp2 = round(price - sl_opt * tp2_rr, 2)
    sell_tp3 = round(price - sl_opt * tp3_rr, 2)

    lot_per_1000 = round(10 / (sl_opt * 10), 2) if sl_opt > 0 else 0.01

    # ── Key Levels ──
    sup  = ", ".join(map(str, smc.support_levels[:3]))     if smc.support_levels else "-"
    res  = ", ".join(map(str, smc.resistance_levels[:3]))  if smc.resistance_levels else "-"

    prompt = f"""XAU/USD {timeframe.upper()} | {datetime.now(WIB).strftime('%d/%m %H:%M')} WIB | Price: ${price:,.2f} | Session: {session} ({session_qual})

[EMA] 21={indicators.ema_21:.2f} 50={indicators.ema_50:.2f} 55={indicators.ema_55:.2f} 200={indicators.ema_200:.2f} | Trend={ema_trend} {ema_strong} | Price {above_200} EMA200
[RSI] {rsi:.1f} → {rsi_zone}
[MACD] line={indicators.macd:.4f} signal={indicators.macd_signal:.4f} hist={indicators.macd_hist:.4f} | Cross={macd_cross}
[HA] bias={indicators.ha_bias} strength={indicators.ha_trend_strength}
[LEVELS] sup={sup} | res={res} | swing_H={smc.swing_high} swing_L={smc.swing_low} | ATR={atr:.2f}
[RISK] SL_opt={sl_opt} | BUY: entry={price:.2f} sl={buy_sl} tp1={buy_tp1} tp2={buy_tp2} tp3={buy_tp3} | SELL: entry={price:.2f} sl={sell_sl} tp1={sell_tp1} tp2={sell_tp2} tp3={sell_tp3} | lot={lot_per_1000}/1000USD

RULES: Signal BUY/SELL hanya jika >=3 metode align searah. Confidence=20% per metode+10% bonus HIGH session. Max 90%. WAIT jika <3 align atau RSI neutral.

Balas JSON:
{{"signal":"BUY|SELL|WAIT","confidence":0-90,"bias":"BULLISH|BEARISH|NEUTRAL","method_confluence":{{"ema_trend":"","rsi_momentum":"","macd":"","heiken_ashi":"","break_retest":"YES|NO|PARTIAL","session":"{session}","aligned_methods":0}},"entry":{{"ideal_price":0.0,"entry_zone":"","type":"MARKET|LIMIT","notes":""}},"risk_management":{{"atr_value":{atr},"sl_minimum_distance":{sl_min},"sl_optimal_distance":{sl_opt},"stop_loss":0.0,"take_profit_1":0.0,"take_profit_2":0.0,"take_profit_3":0.0,"risk_reward_ratio":"","recommended_lot":"{lot_per_1000} lot per $1000","max_lot_warning":"Buka maksimal 1 posisi"}},"market_structure":{{"primary_trend":"","key_support":0.0,"key_resistance":0.0,"price_position":"","current_phase":"","invalidation":""}},"confluence_factors":[],"warning_signs":[],"narrative":"","session_timing":{{"best_entry_window":"","avoid_trading":""}},"next_analysis":""}}"""
    return prompt.strip()


def call_claude_api(prompt: str) -> dict:
    """Kirim data ke Claude/Gemini API dan parse hasilnya."""
    import requests

    # Resolving API key: prioritaskan environment variable, lalu fallback ke global variable
    ant_key = os.getenv("ANTHROPIC_API_KEY", "")
    gem_key = os.getenv("GEMINI_API_KEY", "")

    if not ant_key and ANTHROPIC_API_KEY not in ("YOUR_API_KEY_HERE", "YOUR_ANTHROPIC_KEY"):
        ant_key = ANTHROPIC_API_KEY

    # Tentukan key dan apakah menggunakan Gemini
    api_key = ant_key or gem_key
    use_gemini = False

    if not api_key:
        raise ValueError(
            "❌ API key belum diset!\n"
            "   Set environment variable ANTHROPIC_API_KEY atau GEMINI_API_KEY di dashboard."
        )

    if api_key.startswith("AIzaSy") or "gemini" in api_key.lower():
        use_gemini = True

    if use_gemini:
        print("  🤖 Mengirim data ke Gemini API...")
        url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key={api_key}"
        headers = {"Content-Type": "application/json"}
        payload = {
            "contents": [{"parts": [{"text": prompt}]}],
            "systemInstruction": {
                "parts": [{"text": (
                    "Kamu adalah analis trading profesional. Selalu berikan respons dalam format JSON "
                    "yang valid dan terstruktur sesuai template yang diminta. Jangan tambahkan teks "
                    "di luar JSON. Gunakan data yang diberikan secara akurat."
                )}]
            },
            "generationConfig": {"responseMimeType": "application/json"}
        }
        resp = requests.post(url, headers=headers, json=payload, timeout=30)
        if resp.status_code != 200:
            raise Exception(f"Gemini API returned error {resp.status_code}: {resp.text}")
        raw_text = resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
    else:
        print("  🤖 Mengirim data ke Claude API...")
        client = anthropic.Anthropic(api_key=api_key)
        message = client.messages.create(
            model="claude-sonnet-4-6",
            max_tokens=2000,
            system=(
                "Kamu adalah analis trading profesional. Selalu berikan respons dalam format JSON "
                "yang valid dan terstruktur sesuai template yang diminta. Jangan tambahkan teks "
                "di luar JSON. Gunakan data yang diberikan secara akurat."
            ),
            messages=[{"role": "user", "content": prompt}],
        )
        raw_text = message.content[0].text.strip()

    # Bersihkan markdown code block jika ada
    if raw_text.startswith("```"):
        raw_text = raw_text.split("```")[1]
        if raw_text.startswith("json"):
            raw_text = raw_text[4:]
        raw_text = raw_text.strip()

    result = json.loads(raw_text)
    return result



# ─────────────────────────────────────────────
# 3C. BERKAH ENTRY SIGNAL — FULL REPLICATION
# ─────────────────────────────────────────────
def detect_berkah_signal(
    market: MarketData,
    indicators: Indicators,
    # Confluence Score System — parameter tuning
    liquidity_lookback: int   = 5,
    pin_bar_body_ratio: float = 0.25,
    adx_length: int           = 14,
    adx_threshold: int        = 22,
    sl_buffer_points: float   = 1.0,
    reward_risk_ratio: float  = 1.0,
    tp1_ratio: float          = 0.7,
    capital: float            = 2000.0,
    risk_percent: float       = 1.5,
    value_per_lot: float      = 10.0,
    # Confluence Score thresholds
    score_threshold: int      = 4,   # minimum skor untuk sinyal normal (default naik ke 4)
    score_high_conf: int      = 5,   # minimum skor untuk label HIGH CONFIDENCE
    # HTF asli & kalibrasi entry
    htf_bias_override: str | None = None,  # "BULL"|"BEAR"|"RANGING" dari data H1 asli (jika ada)
    htf_agg_factor: int       = 12,  # agregasi candle → struktur HTF (12xM5 = H1, 15xM1 = M15)
    max_extension_atr: float  = 1.5, # veto entry telat: jarak price↔EMA21 maks (xATR)
) -> dict:
    """
    Confluence Score System untuk XAUUSD Scalping.

    Menggantikan logika AND yang rigid dengan sistem poin 0–7:
      +1  BoS searah bias (Break of Structure M5)
      +1  HTF BoS align (struktur H1 konfirmasi)
      +1  Liquidity Sweep terjadi
      +1  Pin Bar / candle konfirmasi
      +1  ADX > threshold (trend cukup kuat)
      +1  EMA trend align (price > EMA50 > EMA200 untuk BUY, sebaliknya SELL)
      +1  Session London/NY (08–23 WIB)

    Threshold:
      skor >= score_high_conf  → SINYAL + label "HIGH_CONFIDENCE"  (default ≥5)
      skor >= score_threshold  → SINYAL normal                       (default ≥3)
      skor < score_threshold   → WAIT

    HTF Bias adalah NON-NEGOTIABLE — sinyal tidak bisa keluar kalau HTF berlawanan.
    """
    from datetime import timezone, timedelta as _td

    df = market.df.copy()

    if len(df) < max(adx_length + 5, liquidity_lookback + 5, 30):
        return {"signal": "WAIT", "reason": "Data tidak cukup untuk Confluence Score Signal"}

    high  = df["high"].values
    low   = df["low"].values
    close = df["close"].values
    open_ = df["open"].values

    n     = len(df)
    price = float(close[-1])
    atr_val = float(indicators.atr_14)

    # ─────────────────────────────────────────────
    # LAYER 1 — HTF BIAS (NON-NEGOTIABLE)
    # Hanya BUY kalau EMA50 > EMA200, hanya SELL kalau EMA50 < EMA200
    # Kalau EMA50 ≈ EMA200 (ranging) → block semua sinyal
    # ─────────────────────────────────────────────
    ema_50_val  = float(indicators.ema_50)
    ema_200_val = float(indicators.ema_200)
    ema_gap     = ema_50_val - ema_200_val

    if htf_bias_override in ("BULL", "BEAR", "RANGING"):
        # ── HTF ASLI dari data H1 (bukan EMA timeframe lokal) ──
        htf_bias_bull = htf_bias_override == "BULL"
        htf_bias_bear = htf_bias_override == "BEAR"
        htf_src = "H1 asli"
    else:
        # Fallback lama: EMA50 vs EMA200 di timeframe lokal
        # (di M1 ini hanya tren ~3.3 jam — bukan HTF sebenarnya)
        min_gap = price * 0.002
        htf_bias_bull = ema_gap >  min_gap
        htf_bias_bear = ema_gap < -min_gap
        htf_src = "EMA lokal (fallback)"

    # Kalau ranging (tidak ada bias jelas), return WAIT langsung
    if not htf_bias_bull and not htf_bias_bear:
        return {
            "signal":     "WAIT",
            "entry":      round(price, 2),
            "tp":         0.0, "tp1": 0.0, "tp2": 0.0, "tp3": 0.0, "sl": 0.0,
            "lot_size":   0.0,
            "score":      0,
            "max_score":  7,
            "confidence": "RANGING",
            "reason":     f"HTF RANGING [{htf_src}] — tidak ada bias tren jelas, semua sinyal diblokir",
            "conditions": {"score_buy": 0, "score_sell": 0},
        }

    # ─────────────────────────────────────────────
    # VETO OVEREXTENSION — cegah entry telat / kejar harga
    # Kalau harga sudah menjauh > max_extension_atr x ATR dari EMA21,
    # pergerakan kemungkinan besar sudah berjalan — menunggu pullback.
    # ─────────────────────────────────────────────
    ema_21_val = float(getattr(indicators, "ema_21", 0) or 0)
    if ema_21_val > 0 and atr_val > 0:
        extension = abs(price - ema_21_val)
        if extension > max_extension_atr * atr_val:
            return {
                "signal":     "WAIT",
                "entry":      round(price, 2),
                "tp":         0.0, "tp1": 0.0, "tp2": 0.0, "tp3": 0.0, "sl": 0.0,
                "lot_size":   0.0,
                "score":      0,
                "max_score":  7,
                "confidence": "OVEREXTENDED",
                "reason":     (f"OVEREXTENDED — harga {extension:.2f} poin dari EMA21 "
                               f"(> {max_extension_atr}xATR={max_extension_atr*atr_val:.2f}). "
                               f"Menunggu pullback, hindari entry telat."),
                "conditions": {"score_buy": 0, "score_sell": 0},
            }

    # ─────────────────────────────────────────────
    # HITUNG ADX (Wilder RMA)
    # ─────────────────────────────────────────────
    plus_dm  = np.zeros(n)
    minus_dm = np.zeros(n)
    tr_arr   = np.zeros(n)

    for i in range(1, n):
        h_chg = high[i] - high[i-1]
        l_chg = low[i-1] - low[i]
        plus_dm[i]  = h_chg if (h_chg > l_chg and h_chg > 0) else 0.0
        minus_dm[i] = l_chg if (l_chg > h_chg and l_chg > 0) else 0.0
        tr_arr[i]   = max(high[i] - low[i],
                          abs(high[i] - close[i-1]),
                          abs(low[i]  - close[i-1]))

    alpha     = 1.0 / adx_length
    rma_plus  = np.zeros(n)
    rma_minus = np.zeros(n)
    rma_tr    = np.zeros(n)

    rma_plus[adx_length]  = plus_dm[1:adx_length+1].mean()
    rma_minus[adx_length] = minus_dm[1:adx_length+1].mean()
    rma_tr[adx_length]    = tr_arr[1:adx_length+1].mean()

    for i in range(adx_length + 1, n):
        rma_plus[i]  = (1 - alpha) * rma_plus[i-1]  + alpha * plus_dm[i]
        rma_minus[i] = (1 - alpha) * rma_minus[i-1] + alpha * minus_dm[i]
        rma_tr[i]    = (1 - alpha) * rma_tr[i-1]    + alpha * tr_arr[i]

    with np.errstate(divide="ignore", invalid="ignore"):
        plus_di  = np.where(rma_tr > 0, 100 * rma_plus  / rma_tr, 0)
        minus_di = np.where(rma_tr > 0, 100 * rma_minus / rma_tr, 0)
        dx       = np.where(
            (plus_di + minus_di) > 0,
            100 * np.abs(plus_di - minus_di) / (plus_di + minus_di),
            0
        )
    plus_di  = np.nan_to_num(plus_di)
    minus_di = np.nan_to_num(minus_di)
    dx       = np.nan_to_num(dx)

    adx_arr   = np.zeros(n)
    start_adx = adx_length * 2
    if start_adx < n:
        adx_arr[start_adx] = dx[adx_length:start_adx+1].mean()
        for i in range(start_adx + 1, n):
            adx_arr[i] = (1 - alpha) * adx_arr[i-1] + alpha * dx[i]

    adx_current = float(adx_arr[-1])

    # ─────────────────────────────────────────────
    # DETEKSI KONDISI INDIVIDUAL
    # ─────────────────────────────────────────────

    # ── BoS (Break of Structure M5) ──
    last_high_bos = None
    last_low_bos  = None
    for i in range(2, n):
        if high[i] > high[i-1] and high[i-1] > high[i-2]:
            last_high_bos = float(high[i-1])
        if low[i] < low[i-1] and low[i-1] < low[i-2]:
            last_low_bos = float(low[i-1])

    # Break HARUS sungguhan (harga melewati level) dan masih segar
    # (belum menjauh > 3xATR — kalau sudah jauh berarti telat).
    # Toleransi persen lama (0.5% = ~$20 di gold $4rb) membuat kondisi ini
    # nyaris selalu true — sumber inflasi skor.
    bos_bull = (last_high_bos is not None) and (price > last_high_bos) \
               and ((price - last_high_bos) <= 3.0 * atr_val)
    bos_bear = (last_low_bos  is not None) and (price < last_low_bos) \
               and ((last_low_bos - price) <= 3.0 * atr_val)

    # ── HTF BoS — agregasi candle ke struktur HTF sebenarnya ──
    # 12xM5 = H1, 15xM1 = M15 (bukan 5 candle = 25 menit seperti sebelumnya)
    htf_window = max(2, int(htf_agg_factor))
    htf_highs  = [high[max(0, i-htf_window):i].max() for i in range(htf_window, n, htf_window)]
    htf_lows   = [low[max(0, i-htf_window):i].min()  for i in range(htf_window, n, htf_window)]
    htf_high_bos = None
    htf_low_bos  = None

    for i in range(2, len(htf_highs)):
        if htf_highs[i] > htf_highs[i-1] and htf_highs[i-1] > htf_highs[i-2]:
            htf_high_bos = float(htf_highs[i-1])
        if htf_lows[i] < htf_lows[i-1] and htf_lows[i-1] < htf_lows[i-2]:
            htf_low_bos = float(htf_lows[i-1])

    htf_bos_bull = (htf_high_bos is not None) and (price > htf_high_bos) \
                   and ((price - htf_high_bos) <= 5.0 * atr_val)
    htf_bos_bear = (htf_low_bos  is not None) and (price < htf_low_bos) \
                   and ((htf_low_bos - price) <= 5.0 * atr_val)

    # ── OHLC candle terakhir (dipakai sweep & pin bar) ──
    o_now = float(open_[-1])
    c_now = float(close[-1])
    h_now = float(high[-1])
    l_now = float(low[-1])

    # ── Liquidity Sweep ──
    low_now   = float(low[-1])
    high_now  = float(high[-1])
    lowest_n  = float(low[-1-liquidity_lookback:-1].min())  if n > liquidity_lookback + 1 else low_now
    highest_n = float(high[-1-liquidity_lookback:-1].max()) if n > liquidity_lookback + 1 else high_now

    # Sweep sungguhan: wick menembus level likuiditas LALU close balik.
    # Definisi lama (toleransi 1% = ~$41 di gold) nyaris selalu true.
    liq_buy  = (low_now  < lowest_n)  and (c_now > lowest_n)
    liq_sell = (high_now > highest_n) and (c_now < highest_n)

    # ── Pin Bar ──
    body_size    = abs(c_now - o_now)
    candle_range = h_now - l_now
    upper_wick   = h_now - max(c_now, o_now)
    lower_wick   = min(c_now, o_now) - l_now
    stable_ratio = (body_size / candle_range) if candle_range > 0 else 1.0

    is_bull_pin = (lower_wick > upper_wick * 2) and (stable_ratio < pin_bar_body_ratio)
    is_bear_pin = (upper_wick > lower_wick * 2) and (stable_ratio < pin_bar_body_ratio)

    # ── EMA Price Position (Layer 2 score) ──
    ema_price_bull = price > ema_50_val  # price di atas EMA50
    ema_price_bear = price < ema_50_val  # price di bawah EMA50

    # ── Session ──
    _WIB      = timezone(_td(hours=7))
    _hour_wib = datetime.now(_WIB).hour
    session_ok = (8 <= _hour_wib <= 23)

    # ─────────────────────────────────────────────
    # LAYER 2 — CONFLUENCE SCORE (0–7)
    # ─────────────────────────────────────────────
    # Hitung skor BUY dan SELL secara terpisah
    # Kondisi individual tidak harus semua True — cukup ≥ score_threshold

    score_detail_buy = {
        "bos_bull":      (bos_bull,         "+1 BoS↑ M5 break struktur"),
        "htf_bos_bull":  (htf_bos_bull,     "+1 HTF BoS↑ struktur H1 align"),
        "liq_sweep_buy": (liq_buy,          "+1 Liquidity Sweep bawah"),
        "pin_bar_bull":  (is_bull_pin,      "+1 Bull Pin Bar / Hammer"),
        "adx_ok":        (adx_current > adx_threshold,
                                            f"+1 ADX {adx_current:.1f}>{adx_threshold}"),
        "ema_price":     (ema_price_bull,   f"+1 Price {price:.2f} > EMA50 {ema_50_val:.2f}"),
        "session":       (session_ok,       f"+1 Session OK jam {_hour_wib}:xx WIB"),
    }

    score_detail_sell = {
        "bos_bear":       (bos_bear,        "+1 BoS↓ M5 break struktur"),
        "htf_bos_bear":   (htf_bos_bear,   "+1 HTF BoS↓ struktur H1 align"),
        "liq_sweep_sell": (liq_sell,        "+1 Liquidity Sweep atas"),
        "pin_bar_bear":   (is_bear_pin,     "+1 Bear Pin Bar / Shooting Star"),
        "adx_ok":         (adx_current > adx_threshold,
                                            f"+1 ADX {adx_current:.1f}>{adx_threshold}"),
        "ema_price":      (ema_price_bear,  f"+1 Price {price:.2f} < EMA50 {ema_50_val:.2f}"),
        "session":        (session_ok,      f"+1 Session OK jam {_hour_wib}:xx WIB"),
    }

    score_buy  = sum(1 for v, _ in score_detail_buy.values()  if v)
    score_sell = sum(1 for v, _ in score_detail_sell.values() if v)

    # ─────────────────────────────────────────────
    # TENTUKAN SINYAL
    # HTF Bias WAJIB align — tidak bisa BUY kalau HTF bearish, dan sebaliknya
    # ─────────────────────────────────────────────
    can_buy  = htf_bias_bull and (score_buy  >= score_threshold)
    can_sell = htf_bias_bear and (score_sell >= score_threshold)

    # Kalau keduanya bisa (edge case), pilih yang skor lebih tinggi
    if can_buy and can_sell:
        can_buy  = score_buy >= score_sell
        can_sell = not can_buy

    # ─────────────────────────────────────────────
    # TP / SL CALCULATION
    # TP1 = 1:1 dengan SL distance
    # TP2 = 1:1.5 dengan SL distance
    # TP3 = 1:2 dengan SL distance
    # ─────────────────────────────────────────────
    if can_buy:
        sl       = float(l_now - sl_buffer_points - atr_val * 0.8)
        sl_dist  = price - sl
        tp1      = float(price + sl_dist * 1.0)   # RR 1:1
        tp2      = float(price + sl_dist * 1.5)   # RR 1:1.5
        tp_full  = float(price + sl_dist * 2.0)   # RR 1:2 (TP3)
        lot_risk = (capital * risk_percent / 100) / (sl_dist * value_per_lot) if sl_dist > 0 else 0.01
        signal   = "BUY"
        score    = score_buy
        conf_label = "HIGH_CONFIDENCE" if score >= score_high_conf else "NORMAL"

        active_factors = [desc for v, desc in score_detail_buy.values() if v]
        reason = (
            f"Confluence BUY [{score}/7] {conf_label} — "
            f"HTF BULL [{htf_src}] | "
            + " | ".join(active_factors)
        )

    elif can_sell:
        sl       = float(h_now + sl_buffer_points + atr_val * 0.8)
        sl_dist  = sl - price
        tp1      = float(price - sl_dist * 1.0)   # RR 1:1
        tp2      = float(price - sl_dist * 1.5)   # RR 1:1.5
        tp_full  = float(price - sl_dist * 2.0)   # RR 1:2 (TP3)
        lot_risk = (capital * risk_percent / 100) / (sl_dist * value_per_lot) if sl_dist > 0 else 0.01
        signal   = "SELL"
        score    = score_sell
        conf_label = "HIGH_CONFIDENCE" if score >= score_high_conf else "NORMAL"

        active_factors = [desc for v, desc in score_detail_sell.values() if v]
        reason = (
            f"Confluence SELL [{score}/7] {conf_label} — "
            f"HTF BEAR [{htf_src}] | "
            + " | ".join(active_factors)
        )

    else:
        signal   = "WAIT"
        tp_full  = 0.0
        tp1      = 0.0
        tp2      = 0.0   # FIX: sebelumnya tidak diset → NameError tertelan try/except
        sl       = 0.0
        lot_risk = 0.0
        score    = max(score_buy, score_sell)
        conf_label = "WAIT"

        # Detail miss untuk debug — tunjukkan skor dan kondisi yang tidak terpenuhi
        miss_buy  = [desc for v, desc in score_detail_buy.values()  if not v]
        miss_sell = [desc for v, desc in score_detail_sell.values() if not v]
        htf_note  = (
            f"HTF BULL (skor buy={score_buy}/{score_threshold})" if htf_bias_bull
            else f"HTF BEAR (skor sell={score_sell}/{score_threshold})" if htf_bias_bear
            else "HTF RANGING"
        )
        reason = (
            f"WAIT — {htf_note} | "
            f"BUY miss [{score_buy}/7 < {score_threshold}]: {miss_buy} | "
            f"SELL miss [{score_sell}/7 < {score_threshold}]: {miss_sell}"
        )

    return {
        "signal":     signal,
        "entry":      round(price, 2),
        "tp":         round(tp_full, 2),   # TP3 = RR 1:2
        "tp1":        round(tp1, 2),        # RR 1:1
        "tp2":        round(tp2, 2),        # RR 1:1.5
        "tp3":        round(tp_full, 2),    # RR 1:2 (sama dengan tp)
        "sl":         round(sl, 2),
        "atr":        round(atr_val, 2),
        "adx":        round(adx_current, 2),
        "lot_size":   round(lot_risk, 2),
        "rrr":        "1:1 / 1:1.5 / 1:2",
        "score":      score,
        "max_score":  7,
        "confidence": conf_label,
        "reason":     reason,
        "conditions": {
            "htf_bias_bull":  htf_bias_bull,
            "htf_bias_bear":  htf_bias_bear,
            "bos_bull":       bos_bull,
            "bos_bear":       bos_bear,
            "htf_bos_bull":   htf_bos_bull,
            "htf_bos_bear":   htf_bos_bear,
            "liq_buy":        liq_buy,
            "liq_sell":       liq_sell,
            "pin_bar_bull":   is_bull_pin,
            "pin_bar_bear":   is_bear_pin,
            "adx_ok":         adx_current > adx_threshold,
            "adx_value":      round(adx_current, 2),
            "ema_price_bull": ema_price_bull,
            "ema_price_bear": ema_price_bear,
            "session_ok":     session_ok,
            "score_buy":      score_buy,
            "score_sell":     score_sell,
            "score_threshold": score_threshold,
        },
    }


# ─────────────────────────────────────────────
# 6. FORMAT & TAMPILKAN HASIL
# ─────────────────────────────────────────────
def print_signal(
    analysis: dict,
    market: MarketData,
    indicators: Indicators,
    smc: SMCStructure,
) -> None:
    """Tampilkan hasil analisis dengan format yang rapi."""

    signal  = analysis.get("signal", "WAIT")
    conf    = analysis.get("confidence", 0)
    bias    = analysis.get("bias", "NEUTRAL")
    entry   = analysis.get("entry", {})
    rm      = analysis.get("risk_management", {})
    ms      = analysis.get("market_structure", {})
    conf_f  = analysis.get("confluence_factors", [])
    warns   = analysis.get("warning_signs", [])
    narr    = analysis.get("narrative", "")
    timing  = analysis.get("session_timing", {})

    # Emoji berdasarkan signal
    signal_emoji = {"BUY": "🟢", "SELL": "🔴", "WAIT": "🟡"}.get(signal, "⚪")
    conf_bar = "█" * (conf // 10) + "░" * (10 - conf // 10)

    SEP = "═" * 60

    print(f"\n{SEP}")
    print(f"  📈 XAU/USD SIGNAL ANALYSIS — {market.timeframe.upper()} TIMEFRAME")
    print(f"  🕐 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print(SEP)

    print(f"\n  {signal_emoji} SIGNAL   : {signal}")
    print(f"  📊 BIAS     : {bias}")
    print(f"  🎯 CONFIDENCE: [{conf_bar}] {conf}%")
    print(f"  💰 HARGA    : ${market.current_price:,.2f}")

    print(f"\n{'─' * 60}")
    print("  ENTRY")
    print(f"{'─' * 60}")
    print(f"  Ideal Entry  : {entry.get('ideal_price', '-')}")
    print(f"  Entry Zone   : {entry.get('entry_zone', '-')}")
    print(f"  Entry Type   : {entry.get('entry_type', '-')}")

    print(f"\n{'─' * 60}")
    print("  RISK MANAGEMENT")
    print(f"{'─' * 60}")
    print(f"  Stop Loss    : {rm.get('stop_loss', '-')}")
    print(f"  TP 1         : {rm.get('take_profit_1', '-')}")
    print(f"  TP 2         : {rm.get('take_profit_2', '-')}")
    print(f"  TP 3         : {rm.get('take_profit_3', '-')}")
    print(f"  Risk/Reward  : {rm.get('risk_reward_ratio', '-')}")
    print(f"  Lot Size     : {rm.get('recommended_lot', '-')}")

    print(f"\n{'─' * 60}")
    print("  MARKET STRUCTURE")
    print(f"{'─' * 60}")
    print(f"  Trend        : {ms.get('primary_trend', smc.trend)}")
    print(f"  Fase Market  : {ms.get('current_phase', '-')}")
    print(f"  Level Pantau : {ms.get('key_level_watching', '-')}")
    print(f"  Invalidasi   : {ms.get('invalidation', '-')}")

    if conf_f:
        print(f"\n{'─' * 60}")
        print("  CONFLUENCE FACTORS")
        print(f"{'─' * 60}")
        for i, f in enumerate(conf_f, 1):
            print(f"  {i}. {f}")

    if warns:
        print(f"\n{'─' * 60}")
        print("  ⚠️  WARNING SIGNS")
        print(f"{'─' * 60}")
        for w in warns:
            print(f"  • {w}")

    if narr:
        print(f"\n{'─' * 60}")
        print("  ANALISIS NARASI")
        print(f"{'─' * 60}")
        # Word-wrap narasi di 55 karakter
        words = narr.split()
        line = "  "
        for word in words:
            if len(line) + len(word) + 1 > 58:
                print(line)
                line = "  " + word + " "
            else:
                line += word + " "
        if line.strip():
            print(line)

    if timing:
        print(f"\n{'─' * 60}")
        print("  TIMING")
        print(f"{'─' * 60}")
        print(f"  Best Window  : {timing.get('best_entry_window', '-')}")
        print(f"  Hindari      : {timing.get('avoid_trading', '-')}")
        next_a = analysis.get('next_analysis', '-')
        print(f"  Next Review  : {next_a}")

    print(f"\n{SEP}")
    print("  ⚠️  DISCLAIMER: Signal ini bersifat edukatif. Selalu gunakan")
    print("     money management dan DYOR sebelum membuka posisi nyata.")
    print(SEP)


# ─────────────────────────────────────────────
# 7. SIMPAN LOG
# ─────────────────────────────────────────────
def save_log(
    analysis: dict,
    market: MarketData,
    indicators: Indicators,
    smc: SMCStructure,
    filename: str = None,
) -> str:
    """Simpan hasil analisis ke file JSON."""
    if filename is None:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"xauusd_signal_{market.timeframe}_{ts}.json"

    log_data = {
        "timestamp": datetime.now().isoformat(),
        "symbol": market.symbol,
        "timeframe": market.timeframe,
        "price": market.current_price,
        "indicators": {
            "ema_21": indicators.ema_21,
            "ema_50": indicators.ema_50,
            "ema_200": indicators.ema_200,
            "rsi": indicators.rsi_14,
            "macd": indicators.macd,
            "macd_signal": indicators.macd_signal,
            "atr": indicators.atr_14,
        },
        "smc": {
            "trend": smc.trend,
            "bos": smc.last_bos,
            "choch": smc.last_choch,
            "support": smc.support_levels,
            "resistance": smc.resistance_levels,
        },
        "analysis": analysis,
    }

    with open(filename, "w", encoding="utf-8") as f:
        json.dump(log_data, f, indent=2, ensure_ascii=False)

    return filename


# ─────────────────────────────────────────────
# MULTI-TIMEFRAME SCAN (M1 + M5)
# ─────────────────────────────────────────────
def compute_htf_bias_from_h1(df_h1: "pd.DataFrame | None") -> tuple:
    """
    Hitung HTF bias dari data H1 ASLI (bukan simulasi rolling window).
    Return: ("BULL"|"BEAR"|"RANGING"|None, keterangan)
    None = data tidak cukup → caller pakai fallback lama.
    """
    if df_h1 is None or getattr(df_h1, "empty", True):
        return None, "H1 tidak tersedia"
    try:
        closes = df_h1["close"].astype(float)
        n = len(closes)
        if n >= 210:
            fast = float(closes.ewm(span=50,  adjust=False).mean().iloc[-1])
            slow = float(closes.ewm(span=200, adjust=False).mean().iloc[-1])
            pair = "EMA50/200 H1"
        elif n >= 60:
            fast = float(closes.ewm(span=20, adjust=False).mean().iloc[-1])
            slow = float(closes.ewm(span=50, adjust=False).mean().iloc[-1])
            pair = "EMA20/50 H1"
        else:
            return None, f"H1 hanya {n} candle (butuh >=60)"

        price_h1 = float(closes.iloc[-1])
        gap      = fast - slow
        min_gap  = price_h1 * 0.001   # 0.1% dari harga — ~$4 di gold $4rb

        if gap > min_gap:
            return "BULL", f"{pair} bull, gap {gap:+.2f}"
        if gap < -min_gap:
            return "BEAR", f"{pair} bear, gap {gap:+.2f}"
        return "RANGING", f"{pair} flat, gap {gap:+.2f} < {min_gap:.2f}"
    except Exception as e:
        return None, f"H1 error: {e}"


def run_multi_timeframe_scan(
    bridge_df_m1: "pd.DataFrame | None" = None,
    bridge_df_m5: "pd.DataFrame | None" = None,
    bridge_df_h1: "pd.DataFrame | None" = None,
    capital: float       = 2000.0,
    risk_percent: float  = 1.5,
    value_per_lot: float = 10.0,
) -> dict:
    """
    Jalankan Confluence Score Signal di dua timeframe sekaligus:
      - M5  → sinyal utama (score_threshold=3, ADX=22)
      - M1  → sinyal scalping cepat (score_threshold=3, ADX=18, lookback lebih pendek)

    Return dict dengan struktur:
    {
        "m5":  { ...hasil detect_berkah_signal... },
        "m1":  { ...hasil detect_berkah_signal... },
        "best": { ...sinyal terbaik dari keduanya... },
        "summary": "...",
    }

    Cara pakai dari app.py:
        import xauusd_ai_analyst as analyst
        analyst.BRIDGE_DF = df_m5   # inject M5 dulu
        result = analyst.run_multi_timeframe_scan(
            bridge_df_m1=df_m1,
            bridge_df_m5=df_m5,
        )
    """
    global BRIDGE_DF

    results = {}

    # ── HTF BIAS dari H1 ASLI (satu bias untuk M1 & M5) ──
    htf_bias, htf_note = compute_htf_bias_from_h1(bridge_df_h1)
    if htf_bias is not None:
        print(f"  🧭 HTF H1 → {htf_bias} ({htf_note})")
    else:
        print(f"  🧭 HTF H1 tidak tersedia ({htf_note}) — fallback EMA lokal per-TF")
    results["htf"] = {"bias": htf_bias or "FALLBACK", "note": htf_note}

    # ── SCAN M5 ──
    try:
        BRIDGE_DF = bridge_df_m5 if bridge_df_m5 is not None else BRIDGE_DF
        market_m5 = fetch_market_data("5m")
        indic_m5  = calculate_indicators(market_m5)
        _max_ext = float(os.getenv("MAX_EXTENSION_ATR", "1.5"))
        sig_m5    = detect_berkah_signal(
            market_m5, indic_m5,
            max_extension_atr = _max_ext,
            score_threshold = 4,      # M5 lebih ketat — butuh 4/7 kondisi
            score_high_conf = 5,
            htf_bias_override = htf_bias,   # HTF H1 asli
            htf_agg_factor    = 12,          # 12xM5 = struktur H1
            capital         = capital,
            risk_percent    = risk_percent,
            value_per_lot   = value_per_lot,
        )
        sig_m5["timeframe"] = "M5"
        results["m5"] = sig_m5
        print(f"  📊 M5  → {sig_m5['signal']} | score={sig_m5.get('score', 0)}/7 | {sig_m5.get('confidence','')}")
    except Exception as e:
        print(f"  ⚠️  M5 scan error: {e}")
        results["m5"] = {"signal": "WAIT", "timeframe": "M5", "reason": str(e), "score": 0}

    # ── SCAN M1 ──
    try:
        # M1 butuh inject df_m1 ke BRIDGE_DF
        if bridge_df_m1 is not None and not bridge_df_m1.empty:
            BRIDGE_DF = bridge_df_m1
        else:
            # Fetch M1 langsung dari Twelve Data
            df_m1 = _fetch_twelve_data("1m")
            if df_m1.empty:
                raise ValueError("M1 data kosong dari Twelve Data")
            BRIDGE_DF = df_m1

        market_m1 = fetch_market_data("1m")
        indic_m1  = calculate_indicators(market_m1)
        sig_m1    = detect_berkah_signal(
            market_m1, indic_m1,
            max_extension_atr = float(os.getenv("MAX_EXTENSION_ATR", "1.5")),
            score_threshold  = 4,     # M1 juga 4/7 untuk kualitas lebih baik
            score_high_conf  = 5,
            liquidity_lookback = 3,   # lookback lebih pendek untuk M1
            adx_threshold    = 18,    # ADX lebih rendah di M1
            htf_bias_override = htf_bias,   # HTF H1 asli (bukan EMA 3.3 jam)
            htf_agg_factor    = 15,          # 15xM1 = struktur M15
            capital          = capital,
            risk_percent     = risk_percent,
            value_per_lot    = value_per_lot,
        )
        sig_m1["timeframe"] = "M1"
        results["m1"] = sig_m1
        print(f"  📊 M1  → {sig_m1['signal']} | score={sig_m1.get('score', 0)}/7 | {sig_m1.get('confidence','')}")
    except Exception as e:
        print(f"  ⚠️  M1 scan error: {e}")
        results["m1"] = {"signal": "WAIT", "timeframe": "M1", "reason": str(e), "score": 0}

    # ── RESTORE BRIDGE_DF ke M5 (default) ──
    BRIDGE_DF = bridge_df_m5

    # ── M1 SUBORDINAT KE M5 ──
    # Sinyal M1 hanya valid jika M5 searah, ATAU skor arah M5 >= 3
    # (M5 hampir setuju). Mencegah M1 solo melawan struktur M5.
    _m1 = results.get("m1") or {}
    _m5 = results.get("m5") or {}
    if _m1.get("signal") in ("BUY", "SELL"):
        _d          = _m1["signal"]
        _m5_sig     = _m5.get("signal", "WAIT")
        _m5_conds   = _m5.get("conditions") or {}
        _m5_d_score = _m5_conds.get("score_buy" if _d == "BUY" else "score_sell", 0)
        if _m5_sig != _d and _m5_d_score < 3:
            print(f"  🚫 M1 {_d} diveto — M5={_m5_sig}, skor arah M5={_m5_d_score}/7 < 3")
            results["m1"] = {
                **_m1,
                "signal":     "WAIT",
                "confidence": "M1_VETOED",
                "reason":     (f"M1 {_d} diveto — M5 tidak konfirmasi "
                               f"(M5={_m5_sig}, skor {_d.lower()} M5={_m5_d_score}/7). "
                               + str(_m1.get("reason", ""))[:120]),
            }

    # ── PILIH SINYAL TERBAIK ──
    # Prioritas: HIGH_CONFIDENCE > NORMAL, M5 > M1 jika skor sama
    active = [
        r for r in [results.get("m5"), results.get("m1")]
        if r and r.get("signal") in ("BUY", "SELL")
    ]

    if not active:
        best = {"signal": "WAIT", "timeframe": "BOTH", "reason": "Tidak ada sinyal aktif di M1 maupun M5"}
    elif len(active) == 1:
        best = active[0]
    else:
        # Keduanya ada sinyal — pilih berdasarkan confidence lalu skor
        def _priority(r):
            conf_score = 2 if r.get("confidence") == "HIGH_CONFIDENCE" else 1
            tf_score   = 2 if r.get("timeframe") == "M5" else 1
            return (conf_score, r.get("score", 0), tf_score)
        best = max(active, key=_priority)

    results["best"] = best

    # ── SUMMARY ──
    m5_sig  = results["m5"].get("signal", "WAIT")
    m1_sig  = results["m1"].get("signal", "WAIT")
    m5_sc   = results["m5"].get("score", 0)
    m1_sc   = results["m1"].get("score", 0)
    m5_conf = results["m5"].get("confidence", "")
    m1_conf = results["m1"].get("confidence", "")

    results["summary"] = (
        f"MTF Scan — "
        f"M5: {m5_sig} [{m5_sc}/7 {m5_conf}] | "
        f"M1: {m1_sig} [{m1_sc}/7 {m1_conf}] | "
        f"BEST: {best.get('signal')} dari {best.get('timeframe','?')}"
    )

    print(f"  ✅ {results['summary']}")
    return results


def get_m1_dataframe() -> "pd.DataFrame":
    """
    Helper untuk fetch M1 OHLCV langsung dari Twelve Data.
    Dipakai app.py untuk inject bridge_df_m1 ke run_multi_timeframe_scan.
    """
    df = _fetch_twelve_data("1m")
    if df.empty:
        raise ValueError("Gagal fetch M1 dari Twelve Data — cek kuota API")
    return df


# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="XAU/USD AI Trading Analyst menggunakan Claude API"
    )
    parser.add_argument(
        "--timeframe", "-t",
        default="1h",
        choices=list(TIMEFRAME_CONFIG.keys()),
        help="Timeframe analisis (default: 1h)",
    )
    parser.add_argument(
        "--save", "-s",
        action="store_true",
        help="Simpan hasil analisis ke file JSON",
    )
    args = parser.parse_args()

    print("\n╔══════════════════════════════════════════════╗")
    print("║     XAU/USD AI TRADING ANALYST v1.0         ║")
    print("║     Powered by Claude (Anthropic)            ║")
    print("╚══════════════════════════════════════════════╝\n")

    print("🔄 Memproses analisis...\n")

    try:
        # Step 1: Fetch data
        market = fetch_market_data(args.timeframe)

        # Step 2: Hitung indikator
        indicators = calculate_indicators(market)

        # Step 3: Deteksi SMC
        smc = detect_smc_structure(market)

        # Step 4: Build prompt
        prompt = build_analysis_prompt(market, indicators, smc, args.timeframe)

        # Step 5: Panggil Claude API
        analysis = call_claude_api(prompt)

        # Step 6: Tampilkan hasil
        print_signal(analysis, market, indicators, smc)

        # Step 7: Simpan log (opsional)
        if args.save:
            saved_file = save_log(analysis, market, indicators, smc)
            print(f"\n  💾 Log disimpan: {saved_file}")

        return analysis

    except ValueError as e:
        print(f"\n❌ Error: {e}")
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"\n❌ Gagal parse respons Claude: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Unexpected error: {e}")
        raise


if __name__ == "__main__":
    main()
