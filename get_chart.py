import sys
import json
import os
from chart_generator import generate_chart_b64

def main():
    try:
        # Read parameters from stdin or env
        params = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
        
        timeframe = params.get("timeframe", "15m")
        signal = params.get("signal", "WAIT")
        entry = float(params.get("entry", 0))
        stop_loss = float(params.get("stop_loss", 0))
        tp1 = float(params.get("tp1", 0))
        tp2 = float(params.get("tp2", 0))
        tp3 = float(params.get("tp3", 0))
        confidence = int(params.get("confidence", 0))
        
        api_key = os.getenv("TWELVE_DATA_KEY", "")
        
        result = generate_chart_b64(
            timeframe=timeframe,
            api_key=api_key,
            signal=signal,
            entry=entry,
            stop_loss=stop_loss,
            tp1=tp1,
            tp2=tp2,
            tp3=tp3,
            confidence=confidence
        )
        
        # We output JSON back to Node.js
        print(json.dumps({
            "ok": True,
            "b64": result["b64"],
            "mime": result["mime"],
            "price": result["price"],
            "candles": result["candles"],
            "fvgs": [
                {
                    "type": z["type"],
                    "low": z["low"],
                    "high": z["high"],
                    "dt": str(z["dt"])
                }
                for z in result.get("fvgs", [])
            ]
        }))
    except Exception as e:
        print(json.dumps({
            "ok": False,
            "error": str(e)
        }))

if __name__ == "__main__":
    main()
