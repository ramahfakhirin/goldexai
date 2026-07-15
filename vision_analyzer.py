"""
XAU/USD Vision Analyzer
========================
Kirim chart PNG ke Claude Vision API untuk konfirmasi signal.
Dipanggil HANYA saat sistem angka mendeteksi BUY/SELL (bukan WAIT).

Output: konfirmasi VALID / SKIP / WAIT_FOR_PULLBACK + reasoning
"""

import json
import os
from datetime import datetime, timezone, timedelta

WIB = timezone(timedelta(hours=7))

def now_wib_str(fmt="%d/%m/%Y %H:%M WIB"):
    return datetime.now(WIB).strftime(fmt)


# ─────────────────────────────────────────────
# VISION CONFIRMATION
# ─────────────────────────────────────────────
def confirm_signal_vision(
    chart_b64:   str,
    signal:      str,
    price:       float,
    timeframe:   str,
    entry:       float,
    stop_loss:   float,
    tp1:         float,
    tp2:         float,
    tp3:         float,
    confidence:  int,
    indicators:  dict,
    smc:         dict,
    api_key:     str = "",
) -> dict:
    """
    Kirim chart ke Claude Vision untuk konfirmasi signal.

    Returns:
    {
        "verdict":    "VALID" | "SKIP" | "WAIT_FOR_PULLBACK",
        "confidence_vision": int (0-100),
        "reasoning":  str,
        "key_observations": list[str],
        "risk_notes": list[str],
        "final_signal": "BUY" | "SELL" | "WAIT",
        "combined_confidence": int,
    }
    """
    import anthropic

    key = api_key or os.getenv("ANTHROPIC_API_KEY", "")
    if not key:
        raise ValueError("ANTHROPIC_API_KEY tidak ditemukan")

    client = anthropic.Anthropic(api_key=key)

    # Build prompt yang kaya konteks
    prompt = f"""Kamu adalah senior trader XAU/USD dengan keahlian SMC (Smart Money Concepts) dan price action.

Aku akan kirimkan chart XAU/USD timeframe {timeframe.upper()} beserta data analisis dari sistem trading.

═══════════════════════════════════
DATA SISTEM (dari kalkulasi teknikal)
═══════════════════════════════════

Signal   : {signal}
Timeframe: {timeframe.upper()}
Harga    : ${price:,.2f}
Confidence: {confidence}%

ENTRY PLAN:
• Entry   : {entry}
• SL      : {stop_loss}  
• TP1     : {tp1}
• TP2     : {tp2}
• TP3     : {tp3}

INDIKATOR:
• EMA 21  : {indicators.get('ema_21', '-')} {'(price di atas = bullish)' if price > float(indicators.get('ema_21', price)) else '(price di bawah = bearish)'}
• EMA 50  : {indicators.get('ema_50', '-')}
• EMA 200 : {indicators.get('ema_200', '-')}
• RSI     : {indicators.get('rsi', '-')}
• MACD    : {indicators.get('macd', '-')} | Signal: {indicators.get('macd_signal', '-')}
• ATR     : {indicators.get('atr', '-')}

SMC STRUCTURE:
• Trend   : {smc.get('trend', '-')}
• BOS     : {smc.get('bos', 'NONE')}
• CHoCH   : {smc.get('choch', 'NONE')}
• Swing H : {smc.get('swing_high', '-')}
• Swing L : {smc.get('swing_low', '-')}

═══════════════════════════════════
TUGASMU
═══════════════════════════════════

Lihat chart yang aku kirim dengan seksama. Perhatikan:

1. **Price action visual** — bentuk candle, momentum, apakah ada rejection/acceptance
2. **Posisi terhadap EMA** — apakah harga respek EMA atau ignore?
3. **Struktur market visual** — apakah terlihat jelas bullish/bearish/ranging dari chart?
4. **Kualitas entry zone** — apakah entry price berada di area yang logis secara visual?
5. **Risk area** — apakah ada resistance/support kuat yang bisa halangi pergerakan menuju TP?
6. **Konfirmasi atau kontradiksi** — apakah visual chart MENDUKUNG atau BERTENTANGAN dengan signal sistem?

Berikan analisis dalam format JSON (HANYA JSON, tanpa teks lain):

{{
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
  "visual_trend": "BULLISH" | "BEARISH" | "RANGING"
}}

Penjelasan verdict:
- VALID: Chart mendukung signal, entry masuk akal, eksekusi bisa dilakukan
- WAIT_FOR_PULLBACK: Arah benar tapi entry terlalu agresif, tunggu pullback ke zona lebih baik
- SKIP: Chart tidak mendukung signal, terlalu banyak risiko visual
"""

    message = client.messages.create(
        model      = "claude-sonnet-4-6",
        max_tokens = 1000,
        messages   = [{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type":       "base64",
                        "media_type": "image/png",
                        "data":       chart_b64,
                    },
                },
                {
                    "type": "text",
                    "text": prompt,
                },
            ],
        }],
    )

    raw = message.content[0].text.strip()

    # Bersihkan markdown jika ada
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip()

    result = json.loads(raw)

    # Hitung combined confidence (rata-rata sistem + vision)
    vision_conf  = int(result.get("confidence_vision", 50))
    verdict      = result.get("verdict", "SKIP")

    # Weight: vision 60%, sistem 40%
    combined = round(vision_conf * 0.6 + confidence * 0.4)

    # Tentukan final signal
    if verdict == "VALID":
        final_signal = signal
    elif verdict == "WAIT_FOR_PULLBACK":
        final_signal = "WAIT"
    else:  # SKIP
        final_signal = "WAIT"

    result["final_signal"]        = final_signal
    result["combined_confidence"] = combined
    result["original_signal"]     = signal
    result["system_confidence"]   = confidence

    return result


# ─────────────────────────────────────────────
# FORMAT TELEGRAM MESSAGE (dengan Vision result)
# ─────────────────────────────────────────────
def format_telegram_vision_signal(
    vision_result: dict,
    price:         float,
    timeframe:     str,
    entry:         float,
    stop_loss:     float,
    tp1:           float,
    tp2:           float,
    tp3:           float,
    rr_ratio:      str,
) -> str:
    """Format pesan Telegram yang kaya dengan hasil Vision."""

    signal   = vision_result.get("original_signal", "WAIT")
    verdict  = vision_result.get("verdict", "SKIP")
    combined = vision_result.get("combined_confidence", 0)
    pa_qual  = vision_result.get("price_action_quality", "-")
    timing   = vision_result.get("entry_timing", "-")
    reasoning= vision_result.get("reasoning", "")
    obs      = vision_result.get("key_observations", [])
    risks    = vision_result.get("risk_notes", [])

    sig_emoji = "🟢" if signal == "BUY" else "🔴"
    verdict_emoji = "✅" if verdict == "VALID" else "⏳" if verdict == "WAIT_FOR_PULLBACK" else "⛔"

    obs_text  = "\n".join([f"  • {o}" for o in obs[:3]])
    risk_text = "\n".join([f"  ⚠ {r}" for r in risks[:2]])

    msg = (
        f"{sig_emoji} <b>XAU/USD {signal}</b> — {timeframe.upper()}\n"
        f"{verdict_emoji} Vision: <b>{verdict.replace('_', ' ')}</b>\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"💰 Harga   : <b>${price:,.2f}</b>\n"
        f"🎯 Entry   : {entry}\n"
        f"🛑 SL      : {stop_loss}\n"
        f"✅ TP1     : {tp1}\n"
        f"✅ TP2     : {tp2}\n"
        f"✅ TP3     : {tp3}\n"
        f"📊 RR      : {rr_ratio}\n"
        f"🔥 Conf    : {combined}% (Vision+AI)\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"👁 <b>Analisis Visual:</b>\n"
        f"{reasoning}\n"
    )

    if obs_text:
        msg += f"\n📌 <b>Observasi:</b>\n{obs_text}\n"

    if risk_text:
        msg += f"\n{risk_text}\n"

    msg += (
        f"━━━━━━━━━━━━━━━━━━\n"
        f"📈 PA: {pa_qual}  |  ⏰ Timing: {timing}\n"
        "🕐 " + now_wib_str()
    )

    return msg
