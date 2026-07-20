import { db, TradeMonitor } from "./db.js";
import { fetchCurrentPriceServer, sendTelegramMessage, nowWibStr } from "./api.js";

/**
 * Runs a check on all active trade monitors against the latest live price.
 * Follows the 3-stage partial close logic precisely:
 * - TP1 reached → 1/3 profit booked, SL moved to entry (break-even)
 * - TP2 reached → 1/3 profit booked, SL moved to TP1
 * - TP3 reached → final 1/3 profit booked, position CLOSED
 * - SL hit → remaining position closed at SL:
 *   - tp_hit == 0 → outcome SL_HIT (pure loss)
 *   - tp_hit >= 1 → outcome BE_HIT (trailing stop, overall positive/flat PnL)
 */
export async function runMonitorCheck(): Promise<any[]> {
  const updates: any[] = [];
  try {
    const monitors = db.getActiveMonitors();
    if (monitors.length === 0) return updates;

    const price = await fetchCurrentPriceServer();
    if (!price || price <= 0) return updates;

    const displayLotSize = parseFloat(process.env.DISPLAY_LOT_SIZE || "0.10");

    for (const m of monitors) {
      const mid = m.id;
      const direction = m.direction;
      const entry = m.entry_price;
      const sl = m.stop_loss;
      const tp1 = m.tp1 || 0;
      const tp2 = m.tp2 || 0;
      const tp3 = m.tp3 || 0;
      const tp_hit = m.tp_hit ?? 0;
      let realized = m.realized_pnl ?? 0;
      let be_moved = m.be_moved ?? 0;

      const gain = (px: number): number => {
        return direction === "BUY" ? (px - entry) : (entry - px);
      };

      let hit_sl = false;
      let hit_tp1 = false;
      let hit_tp2 = false;
      let hit_tp3 = false;

      if (direction === "BUY") {
        hit_sl = price <= sl;
        hit_tp1 = tp1 > 0 && price >= tp1;
        hit_tp2 = tp2 > 0 && price >= tp2;
        hit_tp3 = tp3 > 0 && price >= tp3;
      } else {
        hit_sl = price >= sl;
        hit_tp1 = tp1 > 0 && price <= tp1;
        hit_tp2 = tp2 > 0 && price <= tp2;
        hit_tp3 = tp3 > 0 && price <= tp3;
      }

      let outcome: string | undefined = undefined;
      let pnl = 0;
      let new_tp_hit = tp_hit;
      let new_sl = sl;
      let should_close = false;

      const tick_gain = gain(price);
      const new_mfe = Math.max(m.mfe ?? 0, tick_gain);
      const new_mae = Math.min(m.mae ?? 0, tick_gain);

      if (hit_sl) {
        const remaining = Math.max(0, (3 - tp_hit) / 3.0);
        pnl = Number((realized + remaining * gain(sl)).toFixed(2));
        outcome = tp_hit === 0 ? "SL_HIT" : "BE_HIT";
        should_close = true;
      } else if (hit_tp1 || hit_tp2 || hit_tp3) {
        if (hit_tp1 && new_tp_hit < 1) {
          realized += gain(tp1) / 3.0;
          new_tp_hit = 1;
          new_sl = entry; // SL to break-even (entry)
          be_moved = 1;
        }
        if (hit_tp2 && new_tp_hit < 2) {
          realized += gain(tp2) / 3.0;
          new_tp_hit = 2;
          new_sl = tp1 || entry; // SL to TP1
        }
        if (hit_tp3 && new_tp_hit < 3) {
          realized += gain(tp3) / 3.0;
          new_tp_hit = 3;
          should_close = true;
        }

        if (new_tp_hit > tp_hit) {
          outcome = `TP${new_tp_hit}_HIT`;
          pnl = Number(realized.toFixed(2));
        }
      } else if (be_moved === 0 && tp1 > 0) {
        const tp1_dist = Math.abs(tp1 - entry);
        if (tp1_dist > 0) {
          const traveled = gain(price);
          const ratio = traveled / tp1_dist;
          if (ratio >= 0.7) { // 70% progress towards TP1
            new_sl = entry;
            be_moved = 1;
            outcome = "EARLY_BE_MOVE";
            pnl = Number(realized.toFixed(2));
          }
        }
      }

      if (outcome) {
        const status = should_close ? "CLOSED" : "ACTIVE";
        
        // Update database
        const success = db.updateMonitor(mid, {
          status,
          outcome,
          outcome_price: price,
          outcome_time: new Date().toISOString(),
          closed_at: status === "CLOSED" ? new Date().toISOString() : undefined,
          pnl_pips: Number(pnl.toFixed(2)),
          realized_pnl: Number(realized.toFixed(2)),
          tp_hit: new_tp_hit,
          stop_loss: new_sl,
          be_moved,
          mfe: Number(new_mfe.toFixed(2)),
          mae: Number(new_mae.toFixed(2)),
        });

        if (success) {
          console.log(`[Monitor] #${mid} ${direction} -> ${outcome} @ ${price.toFixed(2)} (PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)})`);

          const pnl_usd = pnl * displayLotSize * 100;
          const pnl_str = `${pnl_usd >= 0 ? "+" : ""}$${pnl_usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${displayLotSize.toFixed(2)} lot)`;

          updates.push({
            monitor_id: mid,
            direction,
            outcome,
            price,
            pnl_pips: pnl,
            pnl_usd,
          });

          // Telegram Alert
          const labelMap: Record<string, string> = {
            SL_HIT: "STOP LOSS",
            BE_HIT: "BREAKEVEN STOP",
            TP1_HIT: "TP1 HIT — SL pindah ke breakeven",
            TP2_HIT: "TP2 HIT — SL pindah ke TP1",
            TP3_HIT: "TP3 HIT — FULL TARGET",
            EARLY_BE_MOVE: "MOVE TO BE — Harga mendekati TP1 (70%), SL dipindahkan ke entry untuk mengunci risiko",
          };

          const emoji = outcome === "EARLY_BE_MOVE" ? "🛡️" : (pnl > 0 ? "✅" : outcome === "BE_HIT" ? "⚖️" : "🛑");
          const dirEmoji = direction === "BUY" ? "🟢" : "🔴";

          const parts = [
            `${emoji} <b>TRADE UPDATE</b>`,
            "━━━━━━━━━━━━━━━━━━",
            `${dirEmoji} ${direction} XAU/USD`,
            `📊 Hasil   : <b>${labelMap[outcome] || outcome.replace("_", " ")}</b>`,
            `💰 Harga   : $${price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
            `📈 PnL     : <b>${pnl_str}</b>`,
          ];

          if (outcome === "TP1_HIT" || outcome === "TP2_HIT" || outcome === "EARLY_BE_MOVE") {
            parts.push(`🔒 Sisa posisi dilindungi — SL baru $${new_sl.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
          }

          parts.push("━━━━━━━━━━━━━━━━━━");
          parts.push(`🕐 ${nowWibStr()}`);

          await sendTelegramMessage(parts.join("\n"));
        }
      } else {
        // No outcome occurred but MFE/MAE might have evolved, update them silently
        if (new_mfe !== (m.mfe ?? 0) || new_mae !== (m.mae ?? 0)) {
          db.updateMonitor(mid, {
            mfe: Number(new_mfe.toFixed(2)),
            mae: Number(new_mae.toFixed(2)),
          });
        }
      }
    }
  } catch (err) {
    console.error("[Monitor] Check loop error:", err);
  }
  return updates;
}
