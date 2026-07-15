import { execFile } from "child_process";
import path from "path";

export interface ChartParams {
  timeframe: string;
  signal: string;
  entry: number;
  stop_loss: number;
  tp1: number;
  tp2: number;
  tp3: number;
  confidence: number;
}

export interface ChartResult {
  ok: boolean;
  b64?: string;
  mime?: string;
  price?: number;
  candles?: number;
  fvgs?: any[];
  error?: string;
}

export function generateChart(params: ChartParams): Promise<ChartResult> {
  return new Promise((resolve) => {
    const scriptPath = path.join(process.cwd(), "get_chart.py");
    const payload = JSON.stringify(params);

    execFile("python3", [scriptPath, payload], { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) {
        console.error("[Chart Bridge] Spawn error:", err, stderr);
        return resolve({ ok: false, error: err.message || stderr });
      }

      try {
        const result = JSON.parse(stdout.trim());
        resolve(result);
      } catch (parseErr) {
        console.error("[Chart Bridge] Parse error. Stdout was:", stdout, parseErr);
        resolve({ ok: false, error: "Failed to parse Python output JSON: " + String(parseErr) });
      }
    });
  });
}
