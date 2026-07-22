import sys
import os
import json
import sqlite3
import hashlib
from datetime import datetime, timezone, timedelta
from pathlib import Path

BASE_DIR = Path(os.getcwd())
WIB = timezone(timedelta(hours=7))

def resolve_data_dir() -> Path:
    # 1. Cek /data (Coolify Persistent Volume)
    if os.path.exists("/data"):
        try:
            p = Path("/data")
            p.mkdir(parents=True, exist_ok=True)
            test_file = p / f".write_test_{os.getpid()}"
            test_file.touch()
            test_file.unlink()
            return p
        except Exception:
            pass

    # 2. Cek RAILWAY_VOLUME_MOUNT_PATH
    railway_vol = os.getenv("RAILWAY_VOLUME_MOUNT_PATH")
    if railway_vol:
        p = Path(railway_vol)
        try:
            p.mkdir(parents=True, exist_ok=True)
            test_file = p / f".write_test_{os.getpid()}"
            test_file.touch()
            test_file.unlink()
            return p
        except Exception:
            pass

    # 3. Fallback ke local BASE_DIR / "data"
    p = BASE_DIR / "data"
    p.mkdir(parents=True, exist_ok=True)
    return p

DATA_DIR = resolve_data_dir()
DB_PATH = DATA_DIR / "signals.db"

def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=15.0)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA busy_timeout=10000;")
    except Exception:
        pass
    conn.execute("""
        CREATE TABLE IF NOT EXISTS signals (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp   TEXT    NOT NULL,
            timeframe   TEXT    NOT NULL,
            price       REAL    NOT NULL,
            signal      TEXT    NOT NULL,
            confidence  INTEGER NOT NULL,
            bias        TEXT    NOT NULL,
            entry       REAL,
            stop_loss   REAL,
            tp1         REAL,
            tp2         REAL,
            tp3         REAL,
            rr_ratio    TEXT,
            trend       TEXT,
            narrative   TEXT,
            raw_json    TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS trade_monitors (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            signal_id     INTEGER NOT NULL,
            timestamp     TEXT    NOT NULL,
            timeframe     TEXT    NOT NULL,
            direction     TEXT    NOT NULL,
            entry_price   REAL    NOT NULL,
            stop_loss     REAL    NOT NULL,
            tp1           REAL,
            tp2           REAL,
            tp3           REAL,
            status        TEXT    DEFAULT 'ACTIVE',
            outcome       TEXT,
            outcome_price REAL,
            outcome_time  TEXT,
            closed_at     TEXT,
            pnl_pips      REAL,
            tp_hit        INTEGER DEFAULT 0,
            created_at    TEXT,
            realized_pnl  REAL DEFAULT 0,
            be_moved      INTEGER DEFAULT 0,
            mfe           REAL DEFAULT 0,
            mae           REAL DEFAULT 0,
            FOREIGN KEY (signal_id) REFERENCES signals(id)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS performance (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            date        TEXT    NOT NULL,
            total_trades INTEGER DEFAULT 0,
            wins        INTEGER DEFAULT 0,
            losses      INTEGER DEFAULT 0,
            win_rate    REAL    DEFAULT 0,
            total_pips  REAL    DEFAULT 0,
            best_trade  REAL    DEFAULT 0,
            worst_trade REAL    DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS config (
            key   TEXT PRIMARY KEY,
            value TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT    NOT NULL UNIQUE,
            password_hash TEXT    NOT NULL,
            full_name     TEXT    NOT NULL DEFAULT '',
            kota          TEXT    DEFAULT '',
            no_wa         TEXT    DEFAULT '',
            telegram      TEXT    DEFAULT '',
            role          TEXT    DEFAULT 'user',
            is_active     INTEGER DEFAULT 1,
            created_at    TEXT    NOT NULL,
            last_login    TEXT
        )
    """)
    conn.commit()
    return conn

def config_get(key, default=""):
    try:
        conn = get_db()
        row = conn.execute("SELECT value FROM config WHERE key=?", (key,)).fetchone()
        conn.close()
        return row[0] if row and row[0] is not None else default
    except Exception:
        return default

def config_set(key, value):
    try:
        conn = get_db()
        conn.execute(
            "INSERT INTO config (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, str(value)),
        )
        conn.commit()
        conn.close()
        return True
    except Exception as e:
        return str(e)

def get_users():
    try:
        conn = get_db()
        rows = conn.execute("SELECT * FROM users").fetchall()
        conn.close()
        return [dict(r) for r in rows]
    except Exception:
        return []

def get_user_by_credentials(username, pass_hash):
    try:
        conn = get_db()
        row = conn.execute(
            "SELECT * FROM users WHERE username=? AND password_hash=? AND is_active=1",
            (username, pass_hash)
        ).fetchone()
        conn.close()
        return dict(row) if row else None
    except Exception:
        return None

def create_user(user_data):
    try:
        conn = get_db()
        cursor = conn.execute("""
            INSERT INTO users (username, password_hash, full_name, role, is_active, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (
            user_data["username"],
            user_data["password_hash"],
            user_data.get("full_name", ""),
            user_data.get("role", "user"),
            user_data.get("is_active", 1),
            datetime.now(WIB).isoformat()
        ))
        user_id = cursor.lastrowid
        conn.commit()
        
        # Ambil user baru
        row = conn.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        conn.close()
        return dict(row) if row else None
    except Exception as e:
        return {"error": str(e)}

def update_user(uid, updates):
    try:
        conn = get_db()
        fields = []
        params = []
        for k, v in updates.items():
            fields.append(f"{k}=?")
            params.append(v)
        params.append(uid)
        
        sql = f"UPDATE users SET {', '.join(fields)} WHERE id=?"
        conn.execute(sql, params)
        conn.commit()
        conn.close()
        return True
    except Exception:
        return False

def delete_user(uid):
    try:
        conn = get_db()
        conn.execute("UPDATE users SET is_active=0 WHERE id=?", (uid,))
        conn.commit()
        conn.close()
        return True
    except Exception:
        return False

def save_signal(signal_data, timeframe, price):
    try:
        conn = get_db()
        rm = signal_data.get("risk_management", {})
        entry = signal_data.get("entry", {})
        ms = signal_data.get("market_structure", {})

        conf_raw = signal_data.get("confidence", 0)
        if isinstance(conf_raw, (int, float)):
            conf_val = int(conf_raw)
        elif str(conf_raw).isdigit():
            conf_val = int(conf_raw)
        elif conf_raw == "HIGH_CONFIDENCE":
            conf_val = 80
        elif conf_raw == "MEDIUM_CONFIDENCE":
            conf_val = 65
        else:
            conf_val = 50

        cursor = conn.execute("""
            INSERT INTO signals
            (timestamp, timeframe, price, signal, confidence, bias,
             entry, stop_loss, tp1, tp2, tp3, rr_ratio, trend, narrative, raw_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            datetime.now(WIB).isoformat(),
            timeframe,
            float(price),
            signal_data.get("signal", "WAIT"),
            conf_val,
            signal_data.get("bias", "NEUTRAL"),
            float(entry.get("ideal_price") or 0) if entry.get("ideal_price") is not None else None,
            float(rm.get("stop_loss") or 0) if rm.get("stop_loss") is not None else None,
            float(rm.get("take_profit_1") or 0) if rm.get("take_profit_1") is not None else None,
            float(rm.get("take_profit_2") or 0) if rm.get("take_profit_2") is not None else None,
            float(rm.get("take_profit_3") or 0) if rm.get("take_profit_3") is not None else None,
            rm.get("risk_reward_ratio"),
            ms.get("primary_trend"),
            signal_data.get("narrative"),
            json.dumps(signal_data, ensure_ascii=False),
        ))
        signal_id = cursor.lastrowid
        conn.commit()
        conn.close()
        return signal_id
    except Exception as e:
        return {"error": str(e)}

def get_history(limit=50, signal_filter="ALL"):
    try:
        conn = get_db()
        conn.row_factory = sqlite3.Row
        
        if signal_filter in ("TRADE", "BUY_SELL"):
            rows = conn.execute(
                "SELECT * FROM signals WHERE signal IN ('BUY', 'SELL') ORDER BY id DESC LIMIT ?",
                (limit,)
            ).fetchall()
        elif signal_filter in ("BUY", "SELL", "WAIT"):
            rows = conn.execute(
                "SELECT * FROM signals WHERE signal=? ORDER BY id DESC LIMIT ?",
                (signal_filter, limit)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM signals ORDER BY id DESC LIMIT ?",
                (limit,)
            ).fetchall()
            
        conn.close()
        return [dict(r) for r in rows]
    except Exception as e:
        print(f"[DB Bridge get_history error]: {e}", file=sys.stderr)
        return []

def get_latest_signal_db():
    try:
        conn = get_db()
        conn.row_factory = sqlite3.Row
        
        # 1. First priority: if there's an ACTIVE trade monitor, return its signal
        active_mon = conn.execute(
            "SELECT signal_id FROM trade_monitors WHERE status='ACTIVE' ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if active_mon and active_mon["signal_id"]:
            row = conn.execute("SELECT * FROM signals WHERE id=?", (active_mon["signal_id"],)).fetchone()
            if row:
                conn.close()
                return dict(row)

        # 2. Second priority: latest BUY or SELL trade signal
        trade_row = conn.execute(
            "SELECT * FROM signals WHERE signal IN ('BUY', 'SELL') ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if trade_row:
            conn.close()
            return dict(trade_row)

        # 3. Fallback: absolute latest signal
        last_row = conn.execute("SELECT * FROM signals ORDER BY id DESC LIMIT 1").fetchone()
        conn.close()
        return dict(last_row) if last_row else None
    except Exception as e:
        print(f"[DB Bridge get_latest_signal_db error]: {e}", file=sys.stderr)
        return None

def clear_history():
    try:
        conn = get_db()
        conn.execute("DELETE FROM signals")
        conn.execute("DELETE FROM trade_monitors")
        conn.commit()
        conn.close()
        return True
    except Exception:
        return False

def get_stats():
    try:
        conn = get_db()
        rows = conn.execute("SELECT signal, confidence FROM signals").fetchall()
        conn.close()
        
        total = len(rows)
        if total == 0:
            return {"total": 0, "buy": 0, "sell": 0, "wait": 0, "avg_confidence": 0}
            
        buy = sum(1 for r in rows if r["signal"] == "BUY")
        sell = sum(1 for r in rows if r["signal"] == "SELL")
        wait = sum(1 for r in rows if r["signal"] == "WAIT")
        avg_conf = sum(r["confidence"] for r in rows) / total
        
        return {
            "total": total,
            "buy": buy,
            "sell": sell,
            "wait": wait,
            "avg_confidence": round(avg_conf, 1)
        }
    except Exception:
        return {"total": 0, "buy": 0, "sell": 0, "wait": 0, "avg_confidence": 0}

def create_trade_monitor(signal_id, direction, entry, sl, tp1, tp2, tp3, timeframe):
    try:
        conn = get_db()
        now_iso = datetime.now(WIB).isoformat()
        cursor = conn.execute("""
            INSERT INTO trade_monitors
            (signal_id, timestamp, created_at, timeframe, direction, entry_price,
             stop_loss, tp1, tp2, tp3, status, tp_hit, realized_pnl, be_moved, mfe, mae)
            VALUES (?,?,?,?,?,?,?,?,?,?,'ACTIVE',0,0,0,0,0)
        """, (
            int(signal_id),
            now_iso,
            now_iso,
            timeframe,
            direction,
            float(entry or 0),
            float(sl or 0),
            float(tp1 or 0),
            float(tp2 or 0),
            float(tp3 or 0)
        ))
        monitor_id = cursor.lastrowid
        conn.commit()
        conn.close()
        return monitor_id
    except Exception as e:
        return {"error": str(e)}

def get_active_monitors():
    try:
        conn = get_db()
        rows = conn.execute("SELECT * FROM trade_monitors WHERE status='ACTIVE'").fetchall()
        conn.close()
        return [dict(r) for r in rows]
    except Exception:
        return []

def get_monitors():
    try:
        conn = get_db()
        rows = conn.execute("SELECT * FROM trade_monitors").fetchall()
        conn.close()
        return [dict(r) for r in rows]
    except Exception:
        return []

def update_monitor(mid, updates):
    try:
        conn = get_db()
        fields = []
        params = []
        for k, v in updates.items():
            fields.append(f"{k}=?")
            params.append(v)
        params.append(mid)
        
        sql = f"UPDATE trade_monitors SET {', '.join(fields)} WHERE id=?"
        conn.execute(sql, params)
        conn.commit()
        conn.close()
        return True
    except Exception:
        return False

def update_monitor_outcome(monitor_id, outcome, outcome_price, pnl_pips, tp_hit=0):
    try:
        conn = get_db()
        now_iso = datetime.now(WIB).isoformat()
        conn.execute("""
            UPDATE trade_monitors
            SET status='CLOSED', outcome=?, outcome_price=?, outcome_time=?, closed_at=?, pnl_pips=?, tp_hit=?
            WHERE id=?
        """, (outcome, float(outcome_price), now_iso, now_iso, float(pnl_pips), int(tp_hit), int(monitor_id)))
        conn.commit()
        conn.close()
        return True
    except Exception:
        return False

def has_active_monitor(direction=None):
    try:
        conn = get_db()
        if direction:
            row = conn.execute(
                "SELECT id FROM trade_monitors WHERE status='ACTIVE' AND direction=?",
                (direction,)
            ).fetchone()
        else:
            row = conn.execute("SELECT id FROM trade_monitors WHERE status='ACTIVE'").fetchone()
        conn.close()
        return row is not None
    except Exception:
        return False

def is_direction_blocked(direction):
    try:
        streak_n = int(os.getenv("LOSS_STREAK_COUNT", "2"))
        block_hours = float(os.getenv("LOSS_STREAK_BLOCK_HOURS", "3"))

        conn = get_db()
        rows = conn.execute("""
            SELECT id, outcome, closed_at, outcome_time FROM trade_monitors
            WHERE direction=? AND status='CLOSED'
            ORDER BY id DESC LIMIT ?
        """, (direction, streak_n)).fetchall()
        conn.close()

        if len(rows) < streak_n:
            return {"blocked": False, "text": ""}
            
        if any(r["outcome"] != "SL_HIT" for r in rows):
            return {"blocked": False, "text": ""}

        last_closed = rows[0]
        last_ct = last_closed["closed_at"] or last_closed["outcome_time"]
        if not last_ct:
            return {"blocked": False, "text": ""}

        # Parse datetime (WIB or offset)
        try:
            last_dt = datetime.fromisoformat(last_ct)
        except Exception:
            last_dt = datetime.now(timezone.utc)

        elapsed_sec = (datetime.now(WIB) - last_dt).total_seconds()
        elapsed_h = elapsed_sec / 3600.0

        if elapsed_h < block_hours:
            remaining_h = block_hours - elapsed_h
            return {
                "blocked": True,
                "text": f"{streak_n}x SL beruntun arah {direction}, blokir {remaining_h:.1f} jam lagi"
            }
        return {"blocked": False, "text": ""}
    except Exception as e:
        return {"blocked": False, "text": str(e)}

def get_trade_history(limit=30):
    try:
        conn = get_db()
        monitors = conn.execute("""
            SELECT * FROM trade_monitors
            WHERE status='CLOSED'
            ORDER BY id DESC LIMIT ?
        """, (limit,)).fetchall()
        
        results = []
        for m in monitors:
            m_dict = dict(m)
            # Ambil signal narrative dan confidence
            sig_row = conn.execute("SELECT confidence, narrative FROM signals WHERE id=?", (m["signal_id"],)).fetchone()
            m_dict["confidence"] = sig_row["confidence"] if sig_row else 0
            m_dict["narrative"] = sig_row["narrative"] if sig_row else ""
            results.append(m_dict)
            
        conn.close()
        return results
    except Exception:
        return []

def get_performance_stats(days=7):
    try:
        conn = get_db()
        
        # Filter trade_monitors
        if days > 0:
            # Cari waktu cutoff dalam ISO format
            cutoff = (datetime.now(WIB) - timedelta(days=days)).isoformat()
            monitors = conn.execute("""
                SELECT * FROM trade_monitors
                WHERE status='CLOSED' AND (closed_at >= ? OR outcome_time >= ? OR timestamp >= ? OR created_at >= ?)
            """, (cutoff, cutoff, cutoff, cutoff)).fetchall()
        else:
            monitors = conn.execute("SELECT * FROM trade_monitors WHERE status='CLOSED'").fetchall()
            
        conn.close()

        display_lot_size = float(os.getenv("DISPLAY_LOT_SIZE", "0.10"))
        point_value_per_lot = 100.0
        pnl_mult = display_lot_size * point_value_per_lot

        def money(pts):
            return round(pts * pnl_mult, 2)

        total = len(monitors)
        if total == 0:
            return {
                "total": 0, "wins": 0, "losses": 0, "win_rate": 0,
                "total_pips": 0, "total_pnl": 0, "avg_pips": 0, "avg_pnl": 0,
                "best": 0, "worst": 0, "tp1_hits": 0, "tp2_hits": 0, "tp3_hits": 0,
                "gross_profit": 0, "gross_loss": 0, "profit_factor": 0,
                "be_count": 0, "sl_count": 0, "lot_size": display_lot_size,
                "pnl_mult": pnl_mult, "period_days": days
            }

        pnl_list = [money(m["pnl_pips"] or 0) for m in monitors]
        wins = sum(1 for v in pnl_list if v > 0)
        losses = sum(1 for v in pnl_list if v <= 0)
        total_pnl = round(sum(pnl_list), 2)
        avg_pnl = round(total_pnl / total, 2)
        best = max(pnl_list) if pnl_list else 0
        worst = min(pnl_list) if pnl_list else 0

        tp1_hits = sum(1 for m in monitors if (m["tp_hit"] or 0) >= 1)
        tp2_hits = sum(1 for m in monitors if (m["tp_hit"] or 0) >= 2)
        tp3_hits = sum(1 for m in monitors if (m["tp_hit"] or 0) >= 3)

        gross_profit = round(sum(v for v in pnl_list if v > 0), 2)
        gross_loss = round(abs(sum(v for v in pnl_list if v < 0)), 2)

        profit_factor = 0
        if gross_loss > 0:
            profit_factor = round(gross_profit / gross_loss, 2)
        else:
            profit_factor = gross_profit if gross_profit > 0 else 0

        be_count = sum(1 for m in monitors if m["outcome"] == "BE_HIT")
        sl_count = sum(1 for m in monitors if m["outcome"] == "SL_HIT")

        return {
            "total": total,
            "wins": wins,
            "losses": losses,
            "win_rate": round((wins / total) * 100, 1),
            "total_pips": total_pnl,
            "total_pnl": total_pnl,
            "avg_pips": avg_pnl,
            "avg_pnl": avg_pnl,
            "best": best,
            "worst": worst,
            "tp1_hits": tp1_hits,
            "tp2_hits": tp2_hits,
            "tp3_hits": tp3_hits,
            "gross_profit": gross_profit,
            "gross_loss": gross_loss,
            "profit_factor": profit_factor,
            "be_count": be_count,
            "sl_count": sl_count,
            "lot_size": display_lot_size,
            "pnl_mult": pnl_mult,
            "period_days": days
        }
    except Exception as e:
        return {"error": str(e)}

def get_martingale_multiplier():
    try:
        conn = get_db()
        # Fetch the most recent closed trade monitors to trace back outcomes
        rows = conn.execute("""
            SELECT outcome FROM trade_monitors 
            WHERE status = 'CLOSED' 
            ORDER BY id DESC LIMIT 20
        """).fetchall()
        conn.close()
        
        multiplier = 1
        for row in rows:
            outcome = row['outcome']
            if outcome == 'SL_HIT':
                multiplier *= 2
            elif outcome in ('TP1_HIT', 'TP2_HIT', 'TP3_HIT', 'BE_HIT'):
                break
        return multiplier
    except Exception:
        return 1

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No action specified"}))
        return

    action = sys.argv[1]
    
    # Read action parameters
    if action == "config_get":
        key = sys.argv[2]
        default = sys.argv[3] if len(sys.argv) > 3 else ""
        print(json.dumps(config_get(key, default)))
        
    elif action == "config_set":
        key = sys.argv[2]
        val = sys.argv[3]
        print(json.dumps(config_set(key, val)))
        
    elif action == "get_users":
        print(json.dumps(get_users()))
        
    elif action == "get_user_by_credentials":
        username = sys.argv[2]
        pass_hash = sys.argv[3]
        print(json.dumps(get_user_by_credentials(username, pass_hash)))
        
    elif action == "create_user":
        user_data = json.loads(sys.argv[2])
        print(json.dumps(create_user(user_data)))
        
    elif action == "update_user":
        uid = int(sys.argv[2])
        updates = json.loads(sys.argv[3])
        print(json.dumps(update_user(uid, updates)))
        
    elif action == "delete_user":
        uid = int(sys.argv[2])
        print(json.dumps(delete_user(uid)))
        
    elif action == "save_signal":
        sig_data = json.loads(sys.argv[2])
        tf = sys.argv[3]
        price = float(sys.argv[4])
        print(json.dumps(save_signal(sig_data, tf, price)))
        
    elif action == "get_history":
        limit = int(sys.argv[2]) if len(sys.argv) > 2 else 50
        signal_filter = sys.argv[3] if len(sys.argv) > 3 else "ALL"
        print(json.dumps(get_history(limit, signal_filter)))
        
    elif action == "get_latest_signal_db":
        print(json.dumps(get_latest_signal_db()))
        
    elif action == "clear_history":
        print(json.dumps(clear_history()))
        
    elif action == "get_stats":
        print(json.dumps(get_stats()))
        
    elif action == "create_trade_monitor":
        sig_id = int(sys.argv[2])
        direction = sys.argv[3]
        entry = float(sys.argv[4])
        sl = float(sys.argv[5])
        tp1 = float(sys.argv[6])
        tp2 = float(sys.argv[7])
        tp3 = float(sys.argv[8])
        tf = sys.argv[9]
        print(json.dumps(create_trade_monitor(sig_id, direction, entry, sl, tp1, tp2, tp3, tf)))
        
    elif action == "get_active_monitors":
        print(json.dumps(get_active_monitors()))
        
    elif action == "get_monitors":
        print(json.dumps(get_monitors()))
        
    elif action == "update_monitor":
        mid = int(sys.argv[2])
        updates = json.loads(sys.argv[3])
        print(json.dumps(update_monitor(mid, updates)))
        
    elif action == "update_monitor_outcome":
        mid = int(sys.argv[2])
        outcome = sys.argv[3]
        price = float(sys.argv[4])
        pnl = float(sys.argv[5])
        tp_hit = int(sys.argv[6]) if len(sys.argv) > 6 else 0
        print(json.dumps(update_monitor_outcome(mid, outcome, price, pnl, tp_hit)))
        
    elif action == "has_active_monitor":
        direction = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] != "None" else None
        print(json.dumps(has_active_monitor(direction)))
        
    elif action == "is_direction_blocked":
        direction = sys.argv[2]
        print(json.dumps(is_direction_blocked(direction)))
        
    elif action == "get_trade_history":
        limit = int(sys.argv[2]) if len(sys.argv) > 2 else 30
        print(json.dumps(get_trade_history(limit)))
        
    elif action == "get_performance_stats":
        days = int(sys.argv[2]) if len(sys.argv) > 2 else 7
        print(json.dumps(get_performance_stats(days)))
        
    elif action == "get_martingale_multiplier":
        print(json.dumps(get_martingale_multiplier()))
        
    else:
        print(json.dumps({"error": f"Unknown action: {action}"}))

if __name__ == "__main__":
    main()
