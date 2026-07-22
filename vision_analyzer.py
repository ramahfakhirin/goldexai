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
    import requests
    import json

    # Resolving API key: prioritaskan parameter api_key, lalu ANTHROPIC_API_KEY, lalu GEMINI_API_KEY
    key = api_key or os.getenv("ANTHROPIC_API_KEY", "") or os.getenv("GEMINI_API_KEY", "")
    if not key:
        raise ValueError("API Key AI tidak ditemukan (set ANTHROPIC_API_KEY atau GEMINI_API_KEY)")

    # Deteksi tipe Key (Gemini diawali AIzaSy atau mengandung kata gemini)
    is_gemini = key.startswith("AIzaSy") or "gemini" in key.lower()

    # Build prompt yang kaya konteks
    prompt = f"""You are a senior XAU/USD trader with expertise in SMC (Smart Money Concepts) and price action.

I will send you a chart for XAU/USD timeframe {timeframe.upper()} along with analysis data from the trading system.

═══════════════════════════════════
SYSTEM DATA (from technical calculations)
═══════════════════════════════════

Signal   : {signal}
Timeframe: {timeframe.upper()}
Price    : ${price:,.2f}
Confidence: {confidence}%

ENTRY PLAN:
• Entry   : {entry}
• SL      : {stop_loss}  
• TP1     : {tp1}
• TP2     : {tp2}
• TP3     : {tp3}

INDICATORS:
• EMA 21  : {indicators.get('ema_21', '-')} {'(price above = bullish)' if price > float(indicators.get('ema_21', price)) else '(price below = bearish)'}
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
YOUR TASK
═══════════════════════════════════

Examine the provided chart carefully. Pay attention to:

1. **Visual price action** — candle shapes, momentum, rejection/acceptance
2. **Position relative to EMAs** — does price respect or ignore EMAs?
3. **Visual market structure** — is bullish/bearish/ranging clearly visible?
4. **Entry zone quality** — is the entry price at a logically sound area visually?
5. **Risk area** — are there strong support/resistance levels blocking movement towards TP?
6. **Confirmation or contradiction** — does the visual chart SUPPORT or CONTRADICT the system signal?

Provide analysis in English in JSON format (ONLY JSON, without other text):

{{
  "verdict": "VALID" | "SKIP" | "WAIT_FOR_PULLBACK",
  "confidence_vision": <number 0-100>,
  "reasoning": "<2-3 sentence main reasoning for your decision in English>",
  "key_observations": [
    "<important visual observation 1 in English>",
    "<important visual observation 2 in English>",
    "<important visual observation 3 in English>"
  ],
  "risk_notes": [
    "<visual risk note 1 in English>",
    "<visual risk note 2 in English>"
  ],
  "price_action_quality": "STRONG" | "MODERATE" | "WEAK",
  "entry_timing": "IDEAL" | "ACCEPTABLE" | "PREMATURE" | "LATE",
  "visual_trend": "BULLISH" | "BEARISH" | "RANGING"
}}

Verdict explanations:
- VALID: Chart supports signal, entry makes sense, execution recommended
- WAIT_FOR_PULLBACK: Direction is correct but entry is too aggressive, wait for pullback to a better zone
- SKIP: Chart does not support signal, too many visual risks
"""

    if is_gemini:
        # Panggil Gemini Vision API menggunakan requests
        url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key={key}"
        headers = {"Content-Type": "application/json"}
        payload = {
            "contents": [
                {
                    "parts": [
                        {
                            "inlineData": {
                                "mimeType": "image/png",
                                "data": chart_b64
                            }
                        },
                        {
                            "text": prompt
                        }
                    ]
                }
            ],
            "generationConfig": {
                "responseMimeType": "application/json"
            }
        }
        resp = requests.post(url, headers=headers, json=payload, timeout=45)
        if resp.status_code != 200:
            raise Exception(f"Gemini Vision API returned error {resp.status_code}: {resp.text}")
        raw = resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
    else:
        # Gunakan Anthropic
        import anthropic
        client = anthropic.Anthropic(api_key=key)
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
    signal_id:     int = None,
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

    id_header = f" | ID #{signal_id}" if signal_id else ""
    id_line   = f"🆔 <b>Signal ID: #{signal_id}</b>\n" if signal_id else ""

    msg = (
        f"{sig_emoji} <b>XAU/USD {signal}</b> — {timeframe.upper()}{id_header}\n"
        f"{verdict_emoji} Vision: <b>{verdict.replace('_', ' ')}</b>\n"
        f"{id_line}"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"💰 Price   : <b>${price:,.2f}</b>\n"
        f"🎯 Entry   : {entry}\n"
        f"🛑 SL      : {stop_loss}\n"
        f"✅ TP1     : {tp1}\n"
        f"✅ TP2     : {tp2}\n"
        f"✅ TP3     : {tp3}\n"
        f"📊 RR      : {rr_ratio}\n"
        f"🔥 Conf    : {combined}% (Vision+AI)\n"
        f"━━━━━━━━━━━━━━━━━━\n"
        f"👁 <b>Visual Analysis:</b>\n"
        f"{reasoning}\n"
    )

    if obs_text:
        msg += f"\n📌 <b>Observations:</b>\n{obs_text}\n"

    if risk_text:
        msg += f"\n{risk_text}\n"

    msg += (
        f"━━━━━━━━━━━━━━━━━━\n"
        f"📈 PA: {pa_qual}  |  ⏰ Timing: {timing}\n"
        "🕐 " + now_wib_str()
    )

    return msg
