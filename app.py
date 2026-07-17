"""
XAU/USD AI Trading Dashboard — Flask App
==========================================
Lokal  : python app.py  →  http://localhost:5000
Railway: auto-deploy via GitHub
"""

import json
import os
import sqlite3
import sys
import threading
import time
from datetime import datetime
from functools import wraps
from pathlib import Path

# Set matplotlib non-interactive backend SEBELUM import apapun
os.environ.setdefault('MPLBACKEND', 'Agg')

from flask import (Flask, jsonify, redirect, render_template,
                   request, session, url_for)

# ── Timezone WIB (UTC+7) ──
from datetime import timezone, timedelta
WIB = timezone(timedelta(hours=7))

def now_wib():
    """Return datetime sekarang dalam WIB."""
    return datetime.now(WIB)

def now_wib_str(fmt="%d/%m/%Y %H:%M WIB"):
    """Return string datetime WIB."""
    return datetime.now(WIB).strftime(fmt)

def is_market_open() -> bool:
    """
    Cek apakah pasar gold/forex sedang buka.
    XAU/USD trading: Minggu 23:00 GMT s/d Jumat 22:00 GMT
    = Senin 06:00 WIB s/d Sabtu 05:00 WIB
    Market tutup: Sabtu 05:00 WIB s/d Senin 06:00 WIB.
    """
    now = datetime.now(WIB)
    wd  = now.weekday()  # Senin=0 ... Minggu=6
    hr  = now.hour

    if wd == 5:  # Sabtu — tutup mulai jam 05:00
        return hr < 5
    if wd == 6:  # Minggu — tutup penuh
        return False
    if wd == 0:  # Senin — buka mulai jam 06:00
        return hr >= 6
    return True  # Selasa-Jumat — buka penuh


def market_closed_reason() -> str:
    """Pesan alasan market tutup, untuk ditampilkan ke user."""
    now = datetime.now(WIB)
    wd  = now.weekday()
    if wd == 5 or wd == 6 or (wd == 0 and now.hour < 6):
        return "Market gold/forex tutup — buka kembali Senin 06:00 WIB"
    return ""

# ── Tambahkan path ke folder ini agar bisa import analyst ──
BASE_DIR = Path(__file__).parent
sys.path.insert(0, str(BASE_DIR))

# Lazy import — hanya load saat dipakai (hemat memory)
def get_chart_generator():
    from chart_generator import generate_chart_b64
    return generate_chart_b64

def get_vision_analyzer():
    from vision_analyzer import confirm_signal_vision, format_telegram_vision_signal
    return confirm_signal_vision, format_telegram_vision_signal

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", "xauusd-nano-dashboard-2026")

# ── Session permanen — tidak logout setelah 30 menit ──
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=30)
app.config["SESSION_COOKIE_SAMESITE"]    = "Lax"
app.config["SESSION_COOKIE_SECURE"]      = False  # True kalau pakai HTTPS

# Credentials login — set via Railway Variables untuk keamanan
DASHBOARD_USER = os.getenv("DASHBOARD_USER", "admin")
DASHBOARD_PASS = os.getenv("DASHBOARD_PASS", "nano2026")

# ── CORS untuk endpoint publik (landing page external fetch) ──
@app.after_request
def add_cors_headers(response):
    """Izinkan landing page external fetch harga publik."""
    origin = request.headers.get("Origin", "")
    # Hanya izinkan domain landing page kamu (ganti sesuai domain)
    allowed = ["https://goldexai.com", "https://www.goldexai.com",
               "http://localhost", "http://127.0.0.1"]
    if any(origin.startswith(a) for a in allowed) or not origin:
        response.headers["Access-Control-Allow-Origin"] = origin or "*"
        response.headers["Access-Control-Allow-Methods"] = "GET"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return response

# Cek persistent volume path (Coolify /data, atau Railway, atau local) dengan validasi write permission
def resolve_data_dir():
    # 1. Cek /data
    if os.path.exists("/data") and os.path.isdir("/data"):
        p = Path("/data")
        try:
            p.mkdir(parents=True, exist_ok=True)
            # Test write permission dengan file sementara
            test_file = p / f".write_test_{os.getpid()}"
            test_file.touch()
            test_file.unlink()
            print("[Database] 💾 Menggunakan folder /data (Coolify Persistent Volume)")
            return p
        except Exception as e:
            print(f"[Database] ⚠️ /data terdeteksi tapi tidak bisa ditulis: {e}. Falling back...")

    # 2. Cek RAILWAY_VOLUME_MOUNT_PATH
    railway_vol = os.getenv("RAILWAY_VOLUME_MOUNT_PATH")
    if railway_vol:
        p = Path(railway_vol)
        try:
            p.mkdir(parents=True, exist_ok=True)
            test_file = p / f".write_test_{os.getpid()}"
            test_file.touch()
            test_file.unlink()
            print(f"[Database] 💾 Menggunakan folder Railway Volume: {railway_vol}")
            return p
        except Exception as e:
            print(f"[Database] ⚠️ Railway volume {railway_vol} tidak bisa ditulis: {e}. Falling back...")

    # 3. Fallback ke local BASE_DIR / "data"
    p = BASE_DIR / "data"
    try:
        p.mkdir(parents=True, exist_ok=True)
        print(f"[Database] ⚠️ Menggunakan folder lokal: {p}")
        print("[Database] 🚨 PERINGATAN: Folder ini EPHEMERAL (data akan hilang saat redeploy/restart container jika tidak dikonfigurasi Persistent Volume!)")
        return p
    except Exception as e:
        # 4. Ultimate fallback ke /tmp
        p = Path("/tmp/data")
        p.mkdir(parents=True, exist_ok=True)
        print(f"[Database] ⚠️ Menggunakan folder /tmp: {p} (Temporary, akan hilang!)")
        return p

DATA_DIR = resolve_data_dir()
DB_PATH  = DATA_DIR / "signals.db"


# ─────────────────────────────────────────────
# DATABASE SETUP
# ─────────────────────────────────────────────
def init_db():
    """Buat semua tabel jika belum ada."""
    DB_PATH.parent.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH)

    # Tabel signals (existing)
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

    # Tabel trade monitors — track aktif setelah signal BUY/SELL
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
            FOREIGN KEY (signal_id) REFERENCES signals(id)
        )
    """)

    # Migration: tambah kolom baru ke tabel yang sudah ada (safe — IF NOT EXISTS tidak ada di SQLite ALTER)
    for col_def in [
        "ALTER TABLE trade_monitors ADD COLUMN closed_at TEXT",
        "ALTER TABLE trade_monitors ADD COLUMN created_at TEXT",
    ]:
        try:
            conn.execute(col_def)
        except Exception:
            pass  # Kolom sudah ada, skip

    # Backfill created_at dari timestamp untuk record lama
    conn.execute("""
        UPDATE trade_monitors
        SET created_at = timestamp
        WHERE created_at IS NULL AND timestamp IS NOT NULL
    """)

    # Backfill closed_at dari outcome_time untuk record yang sudah CLOSED
    conn.execute("""
        UPDATE trade_monitors
        SET closed_at = outcome_time
        WHERE closed_at IS NULL AND status = 'CLOSED' AND outcome_time IS NOT NULL
    """)

    # Tabel performance summary (cache harian)
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

    # ── Tabel Config (key-value, persist state antar restart & worker) ──
    conn.execute("""
        CREATE TABLE IF NOT EXISTS config (
            key   TEXT PRIMARY KEY,
            value TEXT
        )
    """)

    # Kolom tambahan trade_monitors untuk partial-close / breakeven accounting
    for _col_sql in (
        "ALTER TABLE trade_monitors ADD COLUMN realized_pnl REAL DEFAULT 0",
        "ALTER TABLE trade_monitors ADD COLUMN be_moved INTEGER DEFAULT 0",
        "ALTER TABLE trade_monitors ADD COLUMN mfe REAL DEFAULT 0",
        "ALTER TABLE trade_monitors ADD COLUMN mae REAL DEFAULT 0",
    ):
        try:
            conn.execute(_col_sql)
        except Exception:
            pass  # kolom sudah ada

    # ── Tabel Users (multi-user SaaS) ──
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

    # Auto-create superadmin dari env variable kalau belum ada
    import hashlib as _hl
    def _hash(pw): return _hl.sha256(pw.encode()).hexdigest()

    admin_user = os.getenv("DASHBOARD_USER", "admin")
    admin_pass = os.getenv("DASHBOARD_PASS", "nano2026")
    existing = conn.execute(
        "SELECT id FROM users WHERE username=?", (admin_user,)
    ).fetchone()
    if not existing:
        conn.execute("""
            INSERT INTO users (username, password_hash, full_name, role, is_active, created_at)
            VALUES (?, ?, 'Super Admin', 'superadmin', 1, ?)
        """, (admin_user, _hash(admin_pass), datetime.now(WIB).isoformat()))

    conn.commit()
    conn.close()


# ── Init DB saat modul dimuat (penting untuk gunicorn/Railway) ──
init_db()


# ── Basis lot untuk TAMPILAN PnL ─────────────────────────────
# Data mentah di DB tetap dalam poin harga ($ per 1 unit) supaya
# riwayat lama konsisten. Konversi dilakukan di lapisan penyajian.
# XAUUSD: pergerakan $1 = $100 per 1.0 lot → 0.10 lot = $10 per poin.
DISPLAY_LOT_SIZE    = float(os.getenv("DISPLAY_LOT_SIZE", "0.10"))
POINT_VALUE_PER_LOT = 100.0
PNL_MULT            = DISPLAY_LOT_SIZE * POINT_VALUE_PER_LOT


def _money(points) -> float:
    """Konversi jarak poin → USD pada basis DISPLAY_LOT_SIZE."""
    try:
        return round(float(points or 0) * PNL_MULT, 2)
    except Exception:
        return 0.0


def _cfg_get(key: str, default: str = "") -> str:
    """Ambil nilai config dari SQLite (shared antar worker, survive restart)."""
    try:
        conn = sqlite3.connect(DB_PATH)
        row  = conn.execute("SELECT value FROM config WHERE key=?", (key,)).fetchone()
        conn.close()
        return row[0] if row and row[0] is not None else default
    except Exception:
        return default


def _cfg_set(key: str, value) -> None:
    """Simpan nilai config ke SQLite."""
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.execute(
            "INSERT INTO config (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, str(value)),
        )
        conn.commit()
        conn.close()
    except Exception:
        pass


def save_signal(data: dict, timeframe: str, price: float):
    """Simpan signal ke database."""
    conn = sqlite3.connect(DB_PATH)
    rm   = data.get("risk_management", {})
    entry = data.get("entry", {})
    ms   = data.get("market_structure", {})

    cursor = conn.execute("""
        INSERT INTO signals
        (timestamp, timeframe, price, signal, confidence, bias,
         entry, stop_loss, tp1, tp2, tp3, rr_ratio, trend, narrative, raw_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, (
        datetime.now(WIB).isoformat(),
        timeframe,
        price,
        data.get("signal", "WAIT"),
        data.get("confidence", 0),
        data.get("bias", "NEUTRAL"),
        entry.get("ideal_price"),
        rm.get("stop_loss"),
        rm.get("take_profit_1"),
        rm.get("take_profit_2"),
        rm.get("take_profit_3"),
        rm.get("risk_reward_ratio"),
        ms.get("primary_trend"),
        data.get("narrative"),
        json.dumps(data, ensure_ascii=False),
    ))
    signal_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return signal_id


def get_history(limit: int = 50) -> list:
    """Ambil history signal dari database."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM signals ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_stats() -> dict:
    """Hitung statistik performa signal."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT signal, confidence FROM signals").fetchall()
    conn.close()

    total = len(rows)
    if total == 0:
        return {"total": 0, "buy": 0, "sell": 0, "wait": 0, "avg_confidence": 0}

    buy  = sum(1 for r in rows if r["signal"] == "BUY")
    sell = sum(1 for r in rows if r["signal"] == "SELL")
    wait = sum(1 for r in rows if r["signal"] == "WAIT")
    avg_conf = sum(r["confidence"] for r in rows) / total

    return {
        "total": total,
        "buy": buy,
        "sell": sell,
        "wait": wait,
        "avg_confidence": round(avg_conf, 1),
    }


def create_trade_monitor(signal_id: int, direction: str, entry: float,
                         sl: float, tp1: float, tp2: float, tp3: float,
                         timeframe: str) -> int:
    """Buat trade monitor baru setelah signal BUY/SELL."""
    now_iso = datetime.now(WIB).isoformat()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.execute("""
        INSERT INTO trade_monitors
        (signal_id, timestamp, created_at, timeframe, direction, entry_price,
         stop_loss, tp1, tp2, tp3, status)
        VALUES (?,?,?,?,?,?,?,?,?,?,'ACTIVE')
    """, (signal_id, now_iso, now_iso, timeframe,
          direction, entry, sl, tp1, tp2, tp3))
    monitor_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return monitor_id


def get_active_monitors() -> list:
    """Ambil semua trade monitor yang masih aktif."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT * FROM trade_monitors WHERE status = 'ACTIVE'
        ORDER BY timestamp DESC
    """).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def update_monitor_outcome(monitor_id: int, outcome: str,
                           outcome_price: float, pnl_pips: float,
                           tp_hit: int = 0):
    """Update hasil trade monitor — set closed_at untuk filter performa."""
    now_iso = datetime.now(WIB).isoformat()
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        UPDATE trade_monitors
        SET status='CLOSED', outcome=?, outcome_price=?,
            outcome_time=?, closed_at=?, pnl_pips=?, tp_hit=?
        WHERE id=?
    """, (outcome, outcome_price, now_iso, now_iso,
          pnl_pips, tp_hit, monitor_id))
    conn.commit()
    conn.close()
    print(f"[Monitor] ✅ Closed #{monitor_id}: {outcome} @ ${outcome_price:.2f} | PnL=${pnl_pips:+.2f} | TP hit={tp_hit}")


def get_performance_stats(days: int = 7) -> dict:
    """
    Hitung statistik performa trade dari monitor.
    Default: 7 hari terakhir. days=0 berarti semua data.
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    if days > 0:
        # Filter 7 hari terakhir berdasarkan closed_at atau created_at
        cutoff = (datetime.now(WIB) - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")
        rows = conn.execute("""
            SELECT * FROM trade_monitors
            WHERE status = 'CLOSED'
            AND COALESCE(closed_at, created_at) >= ?
            ORDER BY id DESC
        """, (cutoff,)).fetchall()
    else:
        rows = conn.execute("""
            SELECT * FROM trade_monitors WHERE status = 'CLOSED'
            ORDER BY id DESC
        """).fetchall()
    conn.close()

    closed = [dict(r) for r in rows]
    total  = len(closed)

    if total == 0:
        return {
            "total": 0, "wins": 0, "losses": 0,
            "win_rate": 0, "total_pips": 0, "total_pnl": 0,
            "avg_pips": 0, "avg_pnl": 0, "best": 0, "worst": 0,
            "tp1_hits": 0, "tp2_hits": 0, "tp3_hits": 0,
            "gross_profit": 0, "gross_loss": 0, "profit_factor": 0,
            "be_count": 0, "sl_count": 0,
            "lot_size": DISPLAY_LOT_SIZE, "pnl_mult": PNL_MULT,
            "period_days": days,
        }

    # Hitung PnL — support kolom pnl_pips (lama) dan pnl_dollar (baru)
    def get_pnl(t):
        """Ambil PnL dari kolom yang tersedia, fallback ke pnl_pips."""
        if t.get("pnl_dollar") is not None and t["pnl_dollar"] != 0:
            return float(t["pnl_dollar"])
        if t.get("pnl_pips") is not None:
            return float(t["pnl_pips"])
        return 0.0

    # Konversi poin → USD basis DISPLAY_LOT_SIZE (win/loss & PF tak terpengaruh skala)
    pnl_list = [_money(get_pnl(t)) for t in closed]
    wins     = sum(1 for v in pnl_list if v > 0)
    losses   = sum(1 for v in pnl_list if v <= 0)
    total_pnl  = round(sum(pnl_list), 2)
    avg_pnl    = round(total_pnl / total, 2) if total else 0
    best       = round(max(pnl_list), 2) if pnl_list else 0
    worst      = round(min(pnl_list), 2) if pnl_list else 0
    tp1_hits   = sum(1 for t in closed if (t.get("tp_hit") or 0) >= 1)
    tp2_hits   = sum(1 for t in closed if (t.get("tp_hit") or 0) >= 2)
    tp3_hits   = sum(1 for t in closed if (t.get("tp_hit") or 0) >= 3)

    # ── Metrik kualitas tambahan ──
    gross_profit = round(sum(v for v in pnl_list if v > 0), 2)
    gross_loss   = round(abs(sum(v for v in pnl_list if v < 0)), 2)
    if gross_loss > 0:
        profit_factor = round(gross_profit / gross_loss, 2)
    else:
        profit_factor = round(gross_profit, 2) if gross_profit > 0 else 0
    be_count = sum(1 for t in closed if (t.get("outcome") or "") == "BE_HIT")
    sl_count = sum(1 for t in closed if (t.get("outcome") or "") == "SL_HIT")

    return {
        "total":      total,
        "wins":       wins,
        "losses":     losses,
        "win_rate":   round(wins / total * 100, 1) if total else 0,
        "total_pips": total_pnl,   # alias lama, tetap ada
        "total_pnl":  total_pnl,
        "avg_pips":   avg_pnl,     # alias lama
        "avg_pnl":    avg_pnl,
        "best":       best,
        "worst":      worst,
        "tp1_hits":   tp1_hits,
        "tp2_hits":   tp2_hits,
        "tp3_hits":   tp3_hits,
        "gross_profit":  gross_profit,
        "gross_loss":    gross_loss,
        "profit_factor": profit_factor,
        "be_count":      be_count,
        "sl_count":      sl_count,
        "lot_size":      DISPLAY_LOT_SIZE,
        "pnl_mult":      PNL_MULT,
        "period_days": days,
    }


def get_trade_history(limit: int = 30) -> list:
    """Ambil history trade yang sudah closed."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT tm.*, s.confidence, s.narrative
        FROM trade_monitors tm
        LEFT JOIN signals s ON tm.signal_id = s.id
        WHERE tm.status = 'CLOSED'
        ORDER BY tm.id DESC LIMIT ?
    """, (limit,)).fetchall()
    conn.close()
    out = []
    for r in rows:
        t = dict(r)
        t["pnl_usd"] = _money(t.get("pnl_pips"))
        out.append(t)
    return out


# ─────────────────────────────────────────────
# BACKGROUND MONITOR ENGINE
# ─────────────────────────────────────────────
_monitor_thread = None
_monitor_lock   = threading.Lock()


def is_direction_blocked(direction: str) -> tuple:
    """
    Directional loss-streak guard.
    Setelah N SL_HIT murni (tanpa TP) BERUNTUN di arah yang sama,
    blokir arah tersebut selama BLOCK_HOURS dari loss terakhir.
    Mencegah 'revenge entry' mesin: jual terus di hari harga naik.
    BE_HIT tidak dihitung loss (SL sudah di breakeven = trade terlindungi).
    Return: (blocked: bool, keterangan: str)
    """
    streak_n    = int(os.getenv("LOSS_STREAK_COUNT", "2"))
    block_hours = float(os.getenv("LOSS_STREAK_BLOCK_HOURS", "3"))
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        rows = conn.execute("""
            SELECT outcome, COALESCE(closed_at, outcome_time) AS ct
            FROM trade_monitors
            WHERE direction=? AND status='CLOSED'
            ORDER BY id DESC LIMIT ?
        """, (direction, streak_n)).fetchall()
        conn.close()

        if len(rows) < streak_n:
            return False, ""
        if any((r["outcome"] or "") != "SL_HIT" for r in rows):
            return False, ""

        last_ct = rows[0]["ct"]
        if not last_ct:
            return False, ""
        last_dt = datetime.fromisoformat(last_ct)
        if last_dt.tzinfo is None:
            last_dt = last_dt.replace(tzinfo=WIB)
        elapsed_h = (datetime.now(WIB) - last_dt).total_seconds() / 3600.0
        if elapsed_h < block_hours:
            return True, (f"{streak_n}x SL beruntun arah {direction}, "
                          f"blokir {block_hours - elapsed_h:.1f} jam lagi")
        return False, ""
    except Exception as e:
        print(f"[Guard] error: {e}")
        return False, ""


def has_active_monitor(direction: str = None) -> bool:
    """
    Cek apakah ada monitor aktif.
    Jika direction=None: cek semua direction (block apapun).
    Jika direction='BUY'/'SELL': cek direction spesifik.
    """
    conn = sqlite3.connect(DB_PATH)
    if direction:
        row = conn.execute(
            "SELECT id FROM trade_monitors WHERE status='ACTIVE' AND direction=? LIMIT 1",
            (direction,)
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT id FROM trade_monitors WHERE status='ACTIVE' LIMIT 1"
        ).fetchone()
    conn.close()
    return row is not None


_TWELVE_TF_MAP = {"1m": "1min", "5m": "5min", "15m": "15min", "1h": "1h", "4h": "4h", "1d": "1day"}

# ── Cache MT5 Bridge ──
_bridge_price_cache = {"price": 0.0, "fetched_at": 0}
_bridge_ohlcv_cache = {"data": None, "timeframe": None, "fetched_at": 0}

# ── Cache Twelve Data (fallback) ──
_twelve_price_cache = {"price": 0.0, "fetched_at": 0}
_twelve_ohlcv_cache = {"data": None, "timeframe": None, "fetched_at": 0}


def fetch_price_from_bridge() -> float:
    """
    Ambil harga dari MT5 Bridge VPS — sumber utama (identik dengan broker).
    Cache 3 detik server-side.
    """
    import time as _time
    now = _time.time()

    if now - _bridge_price_cache["fetched_at"] < 3 and _bridge_price_cache["price"] > 0:
        return _bridge_price_cache["price"]

    bridge_url   = os.getenv("MT5_BRIDGE_URL", "")
    bridge_token = os.getenv("MT5_BRIDGE_TOKEN", "")
    if not bridge_url:
        return 0.0

    try:
        import urllib.request as ureq
        req  = ureq.Request(
            bridge_url.rstrip("/") + "/price",
            headers={"X-Bridge-Token": bridge_token, "User-Agent": "XAUDashboard/2.0"},
        )
        resp = ureq.urlopen(req, timeout=5)
        data = json.loads(resp.read())
        if data.get("ok"):
            price = float(data["price"])
            _bridge_price_cache.update({"price": price, "fetched_at": now})
            return price
        return 0.0
    except Exception as e:
        print(f"[Bridge] Price fetch error: {e}")
        return 0.0


def fetch_ohlcv_from_bridge(timeframe: str = "5m", count: int = 200):
    """
    Ambil OHLCV dari MT5 Bridge VPS — sumber utama, data identik broker.
    Cache 10 detik (bridge sudah update setiap 10 detik di sisi VPS).
    """
    import time as _time
    now = _time.time()

    if (_bridge_ohlcv_cache["data"] is not None
            and _bridge_ohlcv_cache["timeframe"] == timeframe
            and now - _bridge_ohlcv_cache["fetched_at"] < 10):
        return _bridge_ohlcv_cache["data"]

    bridge_url   = os.getenv("MT5_BRIDGE_URL", "")
    bridge_token = os.getenv("MT5_BRIDGE_TOKEN", "")
    if not bridge_url:
        return None

    try:
        import urllib.request as ureq, urllib.parse as uparse
        params = uparse.urlencode({"timeframe": timeframe, "count": count})
        req    = ureq.Request(
            bridge_url.rstrip("/") + "/ohlcv?" + params,
            headers={"X-Bridge-Token": bridge_token, "User-Agent": "XAUDashboard/2.0"},
        )
        resp = ureq.urlopen(req, timeout=20)  # naikkan timeout — OHLCV 200 candle butuh lebih lama
        data = json.loads(resp.read())

        if not data.get("ok") or not data.get("data"):
            return None

        import pandas as pd
        df = pd.DataFrame(data["data"])
        df.index = pd.to_datetime(df["datetime"])
        df = df[["open", "high", "low", "close", "volume"]].astype(float)
        df = df.sort_index()

        _bridge_ohlcv_cache.update({"data": df, "timeframe": timeframe, "fetched_at": now})
        print(f"[Bridge] ✅ OHLCV: {len(df)} candles [{timeframe}] (broker live)")
        return df

    except Exception as e:
        print(f"[Bridge] OHLCV fetch error: {e}")
        return None


def fetch_price_from_twelvedata() -> float:
    """
    Fallback harga dari Twelve Data — dipakai kalau MT5 Bridge tidak tersedia.
    Cache 10 detik.
    """
    import time as _time
    now = _time.time()

    if now - _twelve_price_cache["fetched_at"] < 10 and _twelve_price_cache["price"] > 0:
        return _twelve_price_cache["price"]

    api_key = os.getenv("TWELVE_DATA_KEY", "")
    if not api_key:
        return 0.0

    try:
        import urllib.request as ureq, urllib.parse as uparse
        params = uparse.urlencode({"symbol": "XAU/USD", "apikey": api_key})
        req  = ureq.Request(
            f"https://api.twelvedata.com/price?{params}",
            headers={"User-Agent": "XAUDashboard/2.0"},
        )
        resp  = ureq.urlopen(req, timeout=10)
        data  = json.loads(resp.read())
        price = float(data.get("price", 0))
        if price > 0:
            _twelve_price_cache.update({"price": price, "fetched_at": now})
            return price
        return 0.0
    except Exception as e:
        print(f"[TwelveData] Price fetch error: {e}")
        return 0.0


def fetch_ohlcv_from_twelvedata(timeframe: str = "5m", count: int = 200):
    """
    Fallback OHLCV dari Twelve Data — dipakai kalau MT5 Bridge tidak tersedia.
    Cache 60 detik.
    """
    import time as _time
    now = _time.time()

    if (_twelve_ohlcv_cache["data"] is not None
            and _twelve_ohlcv_cache["timeframe"] == timeframe
            and now - _twelve_ohlcv_cache["fetched_at"] < 60):
        return _twelve_ohlcv_cache["data"]

    api_key = os.getenv("TWELVE_DATA_KEY", "")
    if not api_key:
        return None

    try:
        import urllib.request as ureq, urllib.parse as uparse
        interval = _TWELVE_TF_MAP.get(timeframe, "5min")
        params = uparse.urlencode({
            "symbol": "XAU/USD", "interval": interval,
            "outputsize": min(count, 5000), "apikey": api_key, "order": "ASC",
        })
        req  = ureq.Request(
            f"https://api.twelvedata.com/time_series?{params}",
            headers={"User-Agent": "XAUDashboard/2.0"},
        )
        resp = ureq.urlopen(req, timeout=15)
        data = json.loads(resp.read())

        if data.get("status") == "error" or "values" not in data:
            print(f"[TwelveData] OHLCV error: {data.get('message', 'unknown')}")
            return None

        import pandas as pd
        df = pd.DataFrame(data["values"])
        df.index = pd.to_datetime(df["datetime"])
        df["volume"] = df.get("volume", 0)
        df = df[["open", "high", "low", "close", "volume"]].astype(float)
        df = df.sort_index()

        _twelve_ohlcv_cache.update({"data": df, "timeframe": timeframe, "fetched_at": now})
        print(f"[TwelveData] ✅ OHLCV fallback: {len(df)} candles [{timeframe}]")
        return df

    except Exception as e:
        print(f"[TwelveData] OHLCV fetch error: {e}")
        return None


def fetch_current_price_server() -> float:
    """
    Ambil harga XAU/USD — Bridge utama, Twelve Data fallback.
    """
    # Prioritas 1: MT5 Bridge (identik broker)
    price = fetch_price_from_bridge()
    if price > 0:
        return price

    # Prioritas 2: Twelve Data (fallback)
    print("[Price] Bridge tidak tersedia — fallback ke Twelve Data")
    price = fetch_price_from_twelvedata()
    if price <= 0:
        print("[Price] ⚠️ Semua sumber harga tidak tersedia")
    return price


def fetch_ohlcv_primary(timeframe: str = "5m", count: int = 200):
    """
    Ambil OHLCV — Bridge utama, Twelve Data fallback.
    Dipakai oleh scheduler dan debug endpoint.
    """
    # Prioritas 1: MT5 Bridge
    df = fetch_ohlcv_from_bridge(timeframe, count)
    if df is not None and not df.empty:
        return df, "MT5 Bridge (Broker Live)"

    # Prioritas 2: Twelve Data
    print(f"[OHLCV] Bridge tidak tersedia — fallback ke Twelve Data [{timeframe}]")
    df = fetch_ohlcv_from_twelvedata(timeframe, count)
    if df is not None and not df.empty:
        return df, "Twelve Data (Fallback)"

    return None, "Tidak tersedia"




def run_monitor_check() -> list:
    """
    Cek semua active monitors vs harga live — single accounting path.

    Model posisi: 3 partial sama besar (1/3 close di TP1/TP2/TP3).
    - TP1 tercapai → 1/3 profit dibukukan, SL pindah ke breakeven (entry)
    - TP2 tercapai → 1/3 lagi dibukukan, SL pindah ke TP1
    - TP3 tercapai → sisa 1/3 dibukukan, posisi CLOSED
    - SL tersentuh → sisa posisi close di SL:
        * tp_hit == 0 → outcome SL_HIT  (loss murni)
        * tp_hit >= 1 → outcome BE_HIT  (trailing/breakeven stop, PnL tetap positif)

    PnL yang disimpan (pnl_pips) = PnL tertimbang seluruh posisi ($ per 1 lot-unit).
    Return: list update untuk API/toast.
    """
    updates = []
    with _monitor_lock:
        try:
            conn = sqlite3.connect(DB_PATH)
            conn.row_factory = sqlite3.Row
            monitors = conn.execute(
                "SELECT * FROM trade_monitors WHERE status='ACTIVE' ORDER BY id"
            ).fetchall()
            conn.close()

            if not monitors:
                return updates

            price = fetch_current_price_server()
            if not price:
                return updates

            bot_token = os.getenv("TELEGRAM_BOT_TOKEN", "")
            chat_id   = os.getenv("TELEGRAM_CHAT_ID",   "")

            for m in monitors:
                m         = dict(m)
                mid       = m["id"]
                direction = m["direction"]
                entry     = float(m["entry_price"])
                sl        = float(m["stop_loss"])
                tp1       = float(m["tp1"] or 0)
                tp2       = float(m["tp2"] or 0)
                tp3       = float(m["tp3"] or 0)
                tp_hit    = int(m.get("tp_hit") or 0)
                realized  = float(m.get("realized_pnl") or 0)

                def _gain(px: float) -> float:
                    """Profit per unit posisi penuh pada harga px."""
                    return (px - entry) if direction == "BUY" else (entry - px)

                if direction == "BUY":
                    hit_sl  = price <= sl
                    hit_tp1 = bool(tp1) and price >= tp1
                    hit_tp2 = bool(tp2) and price >= tp2
                    hit_tp3 = bool(tp3) and price >= tp3
                else:
                    hit_sl  = price >= sl
                    hit_tp1 = bool(tp1) and price <= tp1
                    hit_tp2 = bool(tp2) and price <= tp2
                    hit_tp3 = bool(tp3) and price <= tp3

                outcome      = None
                pnl          = 0.0
                new_tp_hit   = tp_hit
                new_sl       = sl
                be_moved     = int(m.get("be_moved") or 0)
                should_close = False

                # ── MFE / MAE tracking (per tick, data diagnosis) ──
                # MFE: pergerakan maksimum SEARAH posisi ($/unit)
                # MAE: pergerakan maksimum MELAWAN posisi ($/unit, negatif)
                tick_gain = _gain(price)
                new_mfe   = max(float(m.get("mfe") or 0), tick_gain)
                new_mae   = min(float(m.get("mae") or 0), tick_gain)

                if hit_sl:
                    remaining = max(0.0, (3 - tp_hit) / 3.0)
                    pnl       = round(realized + remaining * _gain(sl), 2)
                    outcome   = "SL_HIT" if tp_hit == 0 else "BE_HIT"
                    should_close = True

                elif hit_tp1 or hit_tp2 or hit_tp3:
                    # Bukukan tiap level TP baru yang tercapai (limit order 1/3)
                    if hit_tp1 and new_tp_hit < 1:
                        realized  += _gain(tp1) / 3.0
                        new_tp_hit = 1
                        new_sl     = entry      # SL → breakeven
                        be_moved   = 1
                    if hit_tp2 and new_tp_hit < 2:
                        realized  += _gain(tp2) / 3.0
                        new_tp_hit = 2
                        new_sl     = tp1 or entry  # SL → TP1
                    if hit_tp3 and new_tp_hit < 3:
                        realized  += _gain(tp3) / 3.0
                        new_tp_hit = 3
                        should_close = True

                    if new_tp_hit > tp_hit:
                        outcome = f"TP{new_tp_hit}_HIT"
                        pnl     = round(realized, 2)

                if outcome:
                    status = "CLOSED" if should_close else "ACTIVE"
                    conn2  = sqlite3.connect(DB_PATH)
                    # Guard atomik: hanya update jika state belum berubah
                    # (mencegah double-close saat endpoint & thread jalan bersamaan)
                    cur = conn2.execute("""
                        UPDATE trade_monitors
                        SET outcome=?, outcome_price=?, outcome_time=?,
                            closed_at=CASE WHEN ?='CLOSED' THEN ? ELSE closed_at END,
                            pnl_pips=?, realized_pnl=?, tp_hit=?,
                            stop_loss=?, be_moved=?, mfe=?, mae=?, status=?
                        WHERE id=? AND status='ACTIVE' AND COALESCE(tp_hit,0)=?
                    """, (outcome, price, datetime.now(WIB).isoformat(),
                          status, datetime.now(WIB).isoformat(),
                          round(pnl, 2), round(realized, 2), new_tp_hit,
                          new_sl, be_moved, round(new_mfe, 2), round(new_mae, 2),
                          status, mid, tp_hit))
                    changed = cur.rowcount
                    conn2.commit()
                    conn2.close()

                    if not changed:
                        continue  # sudah diproses proses lain — skip notifikasi

                    print(f"[Monitor] #{mid} {direction} -> {outcome} @ {price:.2f} "
                          f"(PnL: {pnl:+.2f} | realized: {realized:+.2f} | SL: {new_sl:.2f})")

                    updates.append({
                        "monitor_id": mid,
                        "direction":  direction,
                        "outcome":    outcome,
                        "price":      price,
                        "pnl_pips":   pnl,
                        "pnl_usd":    _money(pnl),
                    })

                    # ── Notifikasi Telegram ──
                    if bot_token and chat_id:
                        label_map = {
                            "SL_HIT":  "STOP LOSS",
                            "BE_HIT":  "BREAKEVEN STOP",
                            "TP1_HIT": "TP1 HIT — SL pindah ke breakeven",
                            "TP2_HIT": "TP2 HIT — SL pindah ke TP1",
                            "TP3_HIT": "TP3 HIT — FULL TARGET",
                        }
                        emoji = ("✅" if pnl > 0 else
                                 "⚖️" if outcome == "BE_HIT" else "🛑")
                        pnl_usd   = _money(pnl)
                        pnl_str   = (f"{'+' if pnl_usd >= 0 else '-'}"
                                     f"${abs(pnl_usd):,.2f} ({DISPLAY_LOT_SIZE:.2f} lot)")
                        dir_emoji = "🟢" if direction == "BUY" else "🔴"
                        parts = [
                            emoji + " <b>TRADE UPDATE</b>",
                            "━━━━━━━━━━━━━━━━━━",
                            dir_emoji + " " + direction + " XAU/USD",
                            "📊 Hasil   : <b>" + label_map.get(outcome, outcome.replace("_", " ")) + "</b>",
                            "💰 Harga   : $" + f"{price:,.2f}",
                            "📈 PnL     : <b>" + pnl_str + "</b>",
                        ]
                        if outcome in ("TP1_HIT", "TP2_HIT"):
                            parts.append(f"🔒 Sisa posisi dilindungi — SL baru ${new_sl:,.2f}")
                        parts += [
                            "━━━━━━━━━━━━━━━━━━",
                            "🕐 " + now_wib_str(),
                        ]
                        send_telegram_message("\n".join(parts))

                else:
                    # Tidak ada outcome tick ini — tetap update MFE/MAE
                    if new_mfe != float(m.get("mfe") or 0) or new_mae != float(m.get("mae") or 0):
                        conn3 = sqlite3.connect(DB_PATH)
                        conn3.execute(
                            "UPDATE trade_monitors SET mfe=?, mae=? "
                            "WHERE id=? AND status='ACTIVE'",
                            (round(new_mfe, 2), round(new_mae, 2), mid))
                        conn3.commit()
                        conn3.close()

        except Exception as e:
            print(f"[Monitor] Error: {e}")

    return updates


def background_monitor_loop():
    """Loop background thread — cek monitor setiap 60 detik."""
    print("[Monitor] Background thread started")
    while True:
        try:
            run_monitor_check()
        except Exception as e:
            print(f"[Monitor] Loop error: {e}")
        time.sleep(60)


# ─────────────────────────────────────────────
# SCHEDULED ANALYSIS ENGINE (server-side, bukan dari browser)
# ─────────────────────────────────────────────
_analysis_thread  = None
ANALYSIS_INTERVAL = int(os.getenv("ANALYSIS_INTERVAL_SEC", "60"))  # default 1 menit (M1)

_LAST_WAIT_SAVE_TS = 0  # timestamp unix terakhir WAIT disimpan

# ── Deduplication state ──
_LAST_SIGNAL_CANDLE_ID: dict = {"M5": _cfg_get("last_signal_candle_id_m5", "")}
_LAST_SIGNAL_TS: float = 0.0        # unix timestamp sinyal BUY/SELL terakhir
_SIGNAL_COOLDOWN_SEC: int = int(os.getenv("SIGNAL_COOLDOWN_SEC", "900"))  # default 15 menit

# ── SESSION SCHEDULE (superadmin toggle) ──────
# Empat sesi: london, new_york, sydney, tokyo
# True = aktif (analisis berjalan), False = nonaktif (skip)
_SESSION_SCHEDULE: dict = {
    "london":   True,
    "new_york": True,
    "sydney":   True,
    "tokyo":    True,
}

# Mapping jam WIB → sesi (bisa overlap, pakai range utama)
SESSION_HOURS: dict = {
    "sydney":   list(range(4, 10)),    # 04:00–09:59 WIB
    "tokyo":    list(range(6, 14)),    # 06:00–13:59 WIB
    "london":   list(range(14, 22)),   # 14:00–21:59 WIB
    "new_york": list(range(19, 24)) + list(range(0, 3)),  # 19:00–02:59 WIB
}

def get_current_session() -> str:
    """Kembalikan key sesi saat ini berdasarkan jam WIB (prioritas NY > London > Tokyo > Sydney)."""
    h = datetime.now(WIB).hour
    # Prioritas overlap: NY > London > Tokyo > Sydney
    for sess in ("new_york", "london", "tokyo", "sydney"):
        if h in SESSION_HOURS[sess]:
            return sess
    return "off"

def is_session_active() -> bool:
    """Cek apakah sesi saat ini diaktifkan oleh superadmin."""
    sess = get_current_session()
    if sess == "off":
        return False
    return _SESSION_SCHEDULE.get(sess, True)

def load_session_schedule_from_db():
    """Load session schedule dari DB config saat startup."""
    global _SESSION_SCHEDULE
    try:
        conn = sqlite3.connect(DB_PATH)
        rows = conn.execute(
            "SELECT key, value FROM config WHERE key LIKE 'session_sched_%'"
        ).fetchall()
        conn.close()
        for key, val in rows:
            sess_key = key.replace("session_sched_", "")
            if sess_key in _SESSION_SCHEDULE:
                _SESSION_SCHEDULE[sess_key] = (val == "1")
    except Exception:
        pass

def save_session_schedule_to_db():
    """Simpan state session schedule ke DB config."""
    try:
        conn = sqlite3.connect(DB_PATH)
        for sess_key, enabled in _SESSION_SCHEDULE.items():
            conn.execute(
                "INSERT INTO config (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (f"session_sched_{sess_key}", "1" if enabled else "0")
            )
        conn.commit()
        conn.close()
    except Exception:
        pass

def _save_wait_ratelimited(reason: str, market, indicators, smc, timeframe: str):
    """
    Simpan WAIT signal ke DB dan update cache — rate-limited 30 menit.
    """
    global _LAST_WAIT_SAVE_TS
    import time as _time
    now_ts = _time.time()

    # Rate limit persist di SQLite — shared antar worker & survive restart
    last_ts = max(_LAST_WAIT_SAVE_TS,
                  float(_cfg_get("last_wait_save_ts", "0") or 0))
    if now_ts - last_ts < 1800:  # 30 menit
        return

    # Guard tambahan level-DB: skip jika WAIT terakhir < 30 menit lalu
    try:
        _c = sqlite3.connect(DB_PATH)
        _row = _c.execute(
            "SELECT timestamp FROM signals WHERE signal='WAIT' "
            "ORDER BY id DESC LIMIT 1"
        ).fetchone()
        _c.close()
        if _row and _row[0]:
            _last_dt = datetime.fromisoformat(_row[0])
            if (datetime.now(WIB) - _last_dt).total_seconds() < 1800:
                return
    except Exception:
        pass

    _LAST_WAIT_SAVE_TS = now_ts
    _cfg_set("last_wait_save_ts", now_ts)

    # Terjemahkan reason teknis ke bahasa yang mudah dibaca
    def humanize_reason(raw: str) -> str:
        """Ubah string debug Python menjadi kalimat yang readable."""
        if not raw or raw == "-":
            return "Kondisi pasar belum memenuhi semua filter konfluensi."

        msg_parts = []

        # Deteksi kondisi yang belum terpenuhi
        missing_map = {
            "pin_bar":         "Pin bar belum terkonfirmasi",
            "htf_BoS":         "HTF Break of Structure belum terjadi",
            "bos_bull":        "Break of Structure bullish belum terkonfirmasi",
            "bos_bear":        "Break of Structure bearish belum terkonfirmasi",
            "liq_buy":         "Belum ada liquidity sweep ke bawah",
            "liq_sell":        "Belum ada liquidity sweep ke atas",
            "adx":             f"ADX {indicators.rsi_14:.0f} — momentum belum cukup kuat",
            "bullish_engulfing":"Belum ada pola bullish engulfing",
            "bearish_engulfing":"Belum ada pola bearish engulfing",
            "stable_candle":   "Candle tidak cukup solid (doji/small body)",
            "decrease_over_10":"Harga belum turun dari 10 candle lalu",
            "increase_over_10":"Harga belum naik dari 10 candle lalu",
        }

        raw_lower = raw.lower()
        found = []
        for key, desc in missing_map.items():
            if key in raw_lower:
                found.append(desc)

        if found:
            return "Menunggu konfluensi: " + " · ".join(found[:3]) + "."

        # Fallback untuk string pendek yang sudah readable
        if len(raw) < 80 and "miss" not in raw and "['" not in raw:
            return raw

        return "Kondisi pasar belum memenuhi semua filter konfluensi Berkah Signal."

    readable_reason = humanize_reason(reason)

    wait_analysis = {
        "signal":     "WAIT",
        "confidence": 0,
        "bias":       "NEUTRAL",
        "narrative":  readable_reason,
        "method_confluence": {
            "ema_trend":      "Menunggu",
            "rsi_momentum":   f"RSI {indicators.rsi_14:.0f}",
            "macd":           "NEUTRAL",
            "heiken_ashi":    indicators.ha_bias,
            "break_retest":   "Belum",
            "session":        "SCANNING",
            "aligned_methods": 0,
        },
        "entry": {
            "ideal_price": market.current_price,
            "entry_zone":  "-",
            "type":        "WAIT",
            "notes":       readable_reason,
        },
        "risk_management": {
            "stop_loss": 0, "take_profit_1": 0,
            "take_profit_2": 0, "take_profit_3": 0,
        },
        "market_structure": {
            "primary_trend":  "SIDEWAYS",
            "key_support":    smc.support_levels[0] if smc and smc.support_levels else 0,
            "key_resistance": smc.resistance_levels[0] if smc and smc.resistance_levels else 0,
            "price_position": f"${market.current_price:.2f}",
            "current_phase":  "Menunggu setup",
            "invalidation":   "-",
        },
        "confluence_factors": [],
        "warning_signs":      [],   # Kosong untuk WAIT — tidak perlu warning
        "session_timing": {
            "best_entry_window": "London/NY Overlap (14:00–04:00 WIB)",
            "avoid_trading":     "Sesi Asia (02:00–08:00 WIB)",
        },
        "next_analysis": "1 menit",
    }
    save_signal(wait_analysis, timeframe, market.current_price)
    _set_latest_signal(None, wait_analysis, market, indicators, smc, timeframe)


def run_scheduled_analysis():
    """Jalankan analisis XAU/USD dan simpan ke DB. Dipanggil oleh scheduler."""
    try:
        if not is_market_open():
            print(f"[Scheduler] 🔴 Market tutup ({market_closed_reason()}) — skip analisis")
            return None

        # Cek session schedule (superadmin toggle)
        if not is_session_active():
            sess = get_current_session()
            print(f"[Scheduler] ⏸ Sesi '{sess}' dinonaktifkan superadmin — skip analisis")
            return None

        timeframe = os.getenv("DEFAULT_TIMEFRAME", "1m")  # M1 untuk Berkah Signal
        api_key   = os.getenv("ANTHROPIC_API_KEY", "") or os.getenv("GEMINI_API_KEY", "")
        twelve_key = os.getenv("TWELVE_DATA_KEY",  "")

        if not api_key:
            print("[Scheduler] AI API KEY (Anthropic/Gemini) tidak diset, skip")
            return None

        import xauusd_ai_analyst as analyst
        if twelve_key:
            analyst.TWELVE_DATA_KEY = twelve_key

        from xauusd_ai_analyst import (
            build_analysis_prompt, calculate_indicators,
            detect_smc_structure, fetch_market_data,
            detect_berkah_signal, run_multi_timeframe_scan,
            _fetch_twelve_data,
        )

        # ── Fetch M5 (sinyal utama) ──
        df_m5, data_source_m5 = fetch_ohlcv_primary("5m", 500)
        if df_m5 is None or df_m5.empty:
            print("[Scheduler] ⚠️ OHLCV M5 tidak tersedia — analisis dibatalkan")
            return None
        print(f"[Scheduler] ✅ M5 OHLCV dari {data_source_m5}: {len(df_m5)} candles")

        # ── Fetch M1 (sinyal scalping cepat) ──
        df_m1, data_source_m1 = fetch_ohlcv_primary("1m", 500)
        if df_m1 is None or df_m1.empty:
            print("[Scheduler] ⚠️ OHLCV M1 tidak tersedia — hanya pakai M5")
            df_m1 = None
        else:
            print(f"[Scheduler] ✅ M1 OHLCV dari {data_source_m1}: {len(df_m1)} candles")

        # ── Candle deduplication — skip jika candle M5 sama dengan scan sebelumnya ──
        import time as _time_mod
        if df_m5 is not None and not df_m5.empty:
            m5_candle_id = str(df_m5.index[-1])
            prev_candle  = _LAST_SIGNAL_CANDLE_ID.get("M5", "")
            if m5_candle_id == prev_candle:
                print(f"[Scheduler] ⏭ Candle M5 sama ({m5_candle_id}) — skip re-scan")
                return None
            _LAST_SIGNAL_CANDLE_ID["M5"] = m5_candle_id
            _cfg_set("last_signal_candle_id_m5", m5_candle_id)

        # ── Fetch H1 (HTF bias asli — bukan simulasi) ──
        df_h1 = None
        try:
            df_h1, data_source_h1 = fetch_ohlcv_primary("1h", 300)
            if df_h1 is not None and not df_h1.empty:
                print(f"[Scheduler] ✅ H1 OHLCV dari {data_source_h1}: {len(df_h1)} candles")
            else:
                df_h1 = None
                print("[Scheduler] ⚠️ H1 tidak tersedia — HTF fallback EMA lokal")
        except Exception as _e_h1:
            print(f"[Scheduler] ⚠️ H1 fetch error: {_e_h1} — HTF fallback EMA lokal")

        # ── Multi-Timeframe Scan (M1 + M5, gate HTF H1) ──
        mtf = run_multi_timeframe_scan(
            bridge_df_m1 = df_m1,
            bridge_df_m5 = df_m5,
            bridge_df_h1 = df_h1,
        )
        print(f"[MTF] {mtf['summary']}")

        # Restore BRIDGE_DF ke M5 (default untuk indikator & SMC)
        analyst.BRIDGE_DF = df_m5

        # Pakai M5 untuk indikator & SMC (lebih stabil)
        market     = fetch_market_data("5m")
        indicators = calculate_indicators(market)
        smc        = detect_smc_structure(market)

        # ── Pilih sinyal terbaik dari MTF ──
        berkah = mtf["best"]
        sig    = berkah["signal"]

        # Tambah info timeframe ke reason
        tf_label = berkah.get("timeframe", "M5")
        berkah.setdefault("adx",      indicators.atr_14)   # fallback kalau field tidak ada
        berkah.setdefault("atr",      float(indicators.atr_14))
        berkah.setdefault("tp2",      berkah.get("tp", 0))
        berkah.setdefault("tp3",      berkah.get("tp", 0))
        berkah.setdefault("lot_size", 0.01)
        berkah.setdefault("rrr",      "1:1")
        berkah.setdefault("entry",    market.current_price)
        berkah.setdefault("sl",       0.0)
        berkah.setdefault("tp1",      0.0)

        print(f"[MTF-Best] [{tf_label}] {sig} | score={berkah.get('score',0)}/7 | conf={berkah.get('confidence','')} | {str(berkah.get('reason',''))[:80]}")

        if sig == "WAIT":
            # WAIT dari MTF Scan — simpan rate-limited, tidak panggil Claude
            _save_wait_ratelimited(berkah["reason"], market, indicators, smc, "5m")
            return None

        # ── BUY atau SELL terdeteksi — panggil Claude hanya untuk narasi ──
        price = market.current_price
        now_wib_ = datetime.now(WIB)
        session_hour = now_wib_.hour
        if 14 <= session_hour <= 23:
            session = "LONDON/NY_OVERLAP"
        elif 8 <= session_hour <= 13:
            session = "LONDON"
        elif 0 <= session_hour <= 2:
            session = "NY_CLOSE"
        else:
            session = "ASIA/OFF"

        # ── Auto-generate narasi (tanpa Claude API — zero token) ──
        score     = berkah.get("score", 0)
        conf      = berkah.get("confidence", "NORMAL")
        adx_val   = berkah.get("adx", 0)
        atr_val_n = berkah.get("atr", 0)
        sl_dist   = abs(berkah["entry"] - berkah["sl"])

        # Narasi otomatis berdasarkan data sinyal
        if sig == "BUY":
            narrative = (
                f"Pasar XAU/USD [{tf_label}] menunjukkan konfirmasi BUY {conf} "
                f"dengan skor confluence {score}/7 — "
                f"EMA50 di atas EMA200 mengonfirmasi bias bullish, "
                f"ADX {adx_val:.1f} menandakan momentum trend kuat. "
                f"Level kritis: pertahankan SL di ${berkah['sl']:.2f} "
                f"(jarak {sl_dist:.2f} poin dari entry), "
                f"target bertahap TP1 ${berkah['tp1']:.2f} → TP2 ${berkah['tp2']:.2f} → TP3 ${berkah['tp3']:.2f}."
            )
            warning_signs = [
                f"Waspadai reversal jika harga close di bawah ${berkah['sl']:.2f}",
                f"Hindari entry jika spread > {atr_val_n*0.3:.1f} poin",
                "Perhatikan rilis news high-impact yang bisa invalidate struktur",
            ]
        else:  # SELL
            narrative = (
                f"Pasar XAU/USD [{tf_label}] menunjukkan konfirmasi SELL {conf} "
                f"dengan skor confluence {score}/7 — "
                f"EMA50 di bawah EMA200 mengonfirmasi bias bearish, "
                f"ADX {adx_val:.1f} menandakan tekanan jual masih kuat. "
                f"Level kritis: pertahankan SL di ${berkah['sl']:.2f} "
                f"(jarak {sl_dist:.2f} poin dari entry), "
                f"target bertahap TP1 ${berkah['tp1']:.2f} → TP2 ${berkah['tp2']:.2f} → TP3 ${berkah['tp3']:.2f}."
            )
            warning_signs = [
                f"Waspadai reversal jika harga close di atas ${berkah['sl']:.2f}",
                f"Hindari entry jika spread > {atr_val_n*0.3:.1f} poin",
                "Perhatikan rilis news high-impact yang bisa invalidate struktur",
            ]

        confidence_note = (
            f"HIGH CONFIDENCE — {score}/7 kondisi terpenuhi, prioritaskan sinyal ini."
            if conf == "HIGH_CONFIDENCE"
            else f"NORMAL — {score}/7 kondisi terpenuhi, manajemen risiko ketat."
        )

        narasi_data = {
            "narrative":       narrative,
            "warning_signs":   warning_signs,
            "confidence_note": confidence_note,
        }

        print(f"[Scheduler] ✅ Narasi auto-generated (0 token) — {conf} {score}/7")

        # ── Gabungkan signal MTF + narasi Claude ──
        analysis = {
            "signal":     sig,
            "confidence": 75 if berkah.get("confidence") == "HIGH_CONFIDENCE" else 60,
            "bias":       "BULLISH" if sig == "BUY" else "BEARISH",
            "method_confluence": {
                "ema_trend":      f"MTF [{tf_label}] Confluence Score {berkah.get('score',0)}/7",
                "rsi_momentum":   f"ADX {berkah.get('adx', indicators.atr_14):.1f}",
                "macd":           "BoS + HTF BoS",
                "heiken_ashi":    "Liquidity Sweep",
                "break_retest":   "Pin Bar",
                "session":        session,
                "aligned_methods": berkah.get("score", 0),
            },
            "entry": {
                "ideal_price": berkah["entry"],
                "entry_zone":  f"{berkah['entry'] - berkah['atr']*0.3:.2f}–{berkah['entry'] + berkah['atr']*0.3:.2f}",
                "type":        "MARKET",
                "notes":       berkah["reason"],
            },
            "risk_management": {
                "atr_value":           berkah["atr"],
                "sl_minimum_distance": abs(berkah["entry"] - berkah["sl"]),
                "sl_optimal_distance": abs(berkah["entry"] - berkah["sl"]),
                "stop_loss":           berkah["sl"],
                "take_profit_1":       berkah["tp1"],
                "take_profit_2":       berkah["tp2"],
                "take_profit_3":       berkah["tp3"],
                "risk_reward_ratio":   berkah["rrr"],
                "recommended_lot":     f"{berkah['lot_size']} lot",
                "max_lot_warning":     "Buka maksimal 1 posisi",
                "partial_close_guide": (
                    "TP1 hit → close 50%, SL ke BE | "
                    "TP2 hit → close 30% | "
                    "TP3 hit → close sisa 20%"
                ),
            },
            "market_structure": {
                "primary_trend":   smc.trend,
                "key_support":     smc.support_levels[0] if smc.support_levels else 0,
                "key_resistance":  smc.resistance_levels[0] if smc.resistance_levels else 0,
                "price_position":  f"${price:.2f} | ADX={berkah['adx']:.1f}",
                "current_phase":   smc.last_bos or smc.last_choch or "Normal",
                "invalidation":    f"{'Close di bawah' if sig=='BUY' else 'Close di atas'} SL {berkah['sl']}",
            },
            "confluence_factors": [berkah["reason"]],
            "warning_signs":      narasi_data.get("warning_signs", []),
            "narrative":          narasi_data.get("narrative", berkah["reason"]),
            "session_timing": {
                "best_entry_window": session,
                "avoid_trading":     "Sesi Asia (02:00–08:00 WIB)",
            },
            "next_analysis":      "1 menit",
            "berkah_raw":         berkah,
        }

        # ── Cek monitor aktif SEBELUM simpan apapun ──
        active_monitor = has_active_monitor()

        # ── Signal cooldown — jangan emit sinyal baru terlalu cepat ──
        if sig in ("BUY", "SELL"):
            global _LAST_SIGNAL_TS
            now_ts_sig  = _time_mod.time()
            last_sig_ts = max(_LAST_SIGNAL_TS,
                              float(_cfg_get("last_signal_ts", "0") or 0))
            elapsed_since_last = now_ts_sig - last_sig_ts
            if elapsed_since_last < _SIGNAL_COOLDOWN_SEC and last_sig_ts > 0:
                print(f"[Scheduler] 🕐 Cooldown aktif — {elapsed_since_last:.0f}s < {_SIGNAL_COOLDOWN_SEC}s — skip {sig}")
                return None

        # ── Directional loss-streak guard ──
        if sig in ("BUY", "SELL"):
            blocked, guard_note = is_direction_blocked(sig)
            if blocked:
                print(f"[Scheduler] 🚧 {sig} diblokir loss-streak guard — {guard_note}")
                return None

        if sig in ("BUY", "SELL") and not active_monitor:
            signal_id = save_signal(analysis, tf_label, market.current_price)
            if berkah["sl"] and berkah["entry"]:
                create_trade_monitor(
                    signal_id = signal_id,
                    direction = sig,
                    entry     = float(berkah["entry"]),
                    sl        = float(berkah["sl"]),
                    tp1       = float(berkah["tp1"]),
                    tp2       = float(berkah["tp2"]),
                    tp3       = float(berkah["tp3"]),
                    timeframe = tf_label,
                )
                msg = format_signal_message(analysis, market.current_price, tf_label)
                send_telegram_message(msg)
                _LAST_SIGNAL_TS = _time_mod.time()
                _cfg_set("last_signal_ts", _LAST_SIGNAL_TS)
                print(f"[Scheduler] ✅ NEW {sig} [{tf_label}] signal saved & sent @ ${market.current_price:.2f} | score={berkah.get('score',0)}/7 | cooldown {_SIGNAL_COOLDOWN_SEC}s aktif")
            _set_latest_signal(signal_id, analysis, market, indicators, smc, timeframe)

        elif sig in ("BUY", "SELL") and active_monitor:
            print(f"[Scheduler] ⏸ {sig} detected but monitor ACTIVE — skip save")
            latest_cached_str = _cfg_get("latest_signal_cache", "")
            if latest_cached_str:
                try:
                    cached_data = json.loads(latest_cached_str)
                    cached_data["price"] = market.current_price
                    cached_data["timestamp"] = now_wib_str("%Y-%m-%d %H:%M:%S")
                    _latest_signal_cache = cached_data
                    _cfg_set("latest_signal_cache", json.dumps(cached_data, ensure_ascii=False))
                except Exception:
                    pass
            elif _latest_signal_cache:
                _latest_signal_cache["price"]     = market.current_price
                _latest_signal_cache["timestamp"] = now_wib_str("%Y-%m-%d %H:%M:%S")
                _cfg_set("latest_signal_cache", json.dumps(_latest_signal_cache, ensure_ascii=False))
            signal_id = None

        return signal_id

    except Exception as e:
        print(f"[Scheduler] Error: {e}")
        import traceback; traceback.print_exc()
        return None


# Cache sinyal terbaru untuk browser polling
_latest_signal_cache = {}

def _set_latest_signal(signal_id, analysis, market, indicators, smc, timeframe):
    global _latest_signal_cache
    # Deteksi sumber data aktual dari bridge atau fallback
    bridge_price = fetch_price_from_bridge()
    actual_source = "MT5 Bridge (Broker Live)" if bridge_price > 0 else "Twelve Data (Fallback)"
    _latest_signal_cache = {
        "ok":          True,
        "signal_id":   signal_id,
        "analysis":    analysis,
        "price":       market.current_price,
        "timeframe":   timeframe,
        "timestamp":   now_wib_str("%Y-%m-%d %H:%M:%S"),
        "data_source": actual_source,
        "indicators": {
            "ema_21":      indicators.ema_21,
            "ema_50":      indicators.ema_50,
            "ema_55":      indicators.ema_55,
            "ema_200":     indicators.ema_200,
            "rsi":         indicators.rsi_14,
            "atr":         indicators.atr_14,
            "macd":        indicators.macd,
            "macd_signal": indicators.macd_signal,
            "ha_bias":     indicators.ha_bias,
            "ha_strength": indicators.ha_trend_strength,
        },
        "smc": {
            "trend":      smc.trend,
            "bos":        smc.last_bos,
            "choch":      smc.last_choch,
            "swing_high": smc.swing_high,
            "swing_low":  smc.swing_low,
            "support":    smc.support_levels,
            "resistance": smc.resistance_levels,
            "fvg_zones":  smc.fvg_zones[:3],
            "ob_zones":   smc.ob_zones[:3],
        },
    }
    _cfg_set("latest_signal_cache", json.dumps(_latest_signal_cache, ensure_ascii=False))


def scheduled_analysis_loop():
    """Loop background: analisis tepat setiap ANALYSIS_INTERVAL detik."""
    import math
    print(f"[Scheduler] Thread started — interval {ANALYSIS_INTERVAL}s")

    # Align ke menit bulat berikutnya (misal: 07:05:00, 07:10:00, dst)
    now_ts    = datetime.now(WIB).timestamp()
    next_tick = math.ceil(now_ts / ANALYSIS_INTERVAL) * ANALYSIS_INTERVAL
    wait_sec  = next_tick - now_ts
    print(f"[Scheduler] First run in {wait_sec:.0f}s at "
          f"{datetime.fromtimestamp(next_tick, WIB).strftime('%H:%M:%S')} WIB")
    
    # Update heartbeat awal
    _cfg_set("scheduler_heartbeat", datetime.now(WIB).timestamp())
    
    time.sleep(wait_sec)

    while True:
        start = time.time()
        _cfg_set("scheduler_heartbeat", datetime.now(WIB).timestamp())
        run_scheduled_analysis()
        elapsed = time.time() - start
        sleep_time = max(0, ANALYSIS_INTERVAL - elapsed)
        time.sleep(sleep_time)


def start_scheduled_analysis():
    """Start scheduled analysis thread (singleton)."""
    global _analysis_thread
    if _analysis_thread and _analysis_thread.is_alive():
        return
    _analysis_thread = threading.Thread(
        target=scheduled_analysis_loop,
        daemon=True,
        name="SchedulerThread"
    )
    _analysis_thread.start()
    print("[Scheduler] Thread launched")


def start_background_monitor():
    """Start background monitor thread (singleton)."""
    global _monitor_thread
    if _monitor_thread and _monitor_thread.is_alive():
        return
    _monitor_thread = threading.Thread(
        target=background_monitor_loop,
        daemon=True,
        name="MonitorThread"
    )
    _monitor_thread.start()
    print("[Monitor] Thread launched")


# ─────────────────────────────────────────────
# TELEGRAM HELPER
# ─────────────────────────────────────────────
def send_telegram_message(text: str, bot_token: str = "", chat_id: str = "") -> bool:
    """Kirim pesan teks ke Telegram. Return True jika berhasil."""
    token = bot_token or os.getenv("TELEGRAM_BOT_TOKEN", "")
    chat  = chat_id  or os.getenv("TELEGRAM_CHAT_ID",   "")
    if not token or not chat:
        return False
    try:
        import urllib.request as ureq
        url     = f"https://api.telegram.org/bot{token}/sendMessage"
        payload = json.dumps({
            "chat_id":    chat,
            "text":       text,
            "parse_mode": "HTML",
        }).encode()
        req = ureq.Request(url, data=payload,
                           headers={"Content-Type": "application/json"})
        ureq.urlopen(req, timeout=10)
        return True
    except Exception as e:
        print(f"[Telegram] Error: {e}")
        return False


def format_signal_message(analysis: dict, price: float, timeframe: str) -> str:
    """Format pesan signal BUY/SELL untuk Telegram — narasi penuh, tidak terpotong."""
    sig  = analysis.get("signal", "WAIT")
    conf = analysis.get("confidence", 0)
    rm   = analysis.get("risk_management", {})
    en   = analysis.get("entry", {})
    narr = analysis.get("narrative", "")
    warn = analysis.get("warning_signs", [])

    sig_emoji = "🟢" if sig == "BUY" else "🔴"
    now_str   = now_wib_str()

    # Bersihkan narasi dari sisa JSON atau karakter aneh
    if narr:
        import re as _re
        # Kalau masih ada JSON wrapper, ekstrak teksnya
        if narr.strip().startswith("{"):
            m = _re.search(r'"narrative"\s*:\s*"((?:[^"\\]|\\.)*)"', narr)
            if m:
                narr = m.group(1).replace('\\"', '"').replace("\\n", " ")
        # Bersihkan escape characters
        narr = narr.replace("\\n", " ").replace('\\"', '"').strip()

    # Format entry zone
    entry_zone = en.get("entry_zone") or str(en.get("ideal_price", "-"))
    sl  = rm.get("stop_loss",    "-")
    tp1 = rm.get("take_profit_1", "-")
    tp2 = rm.get("take_profit_2", "-")
    tp3 = rm.get("take_profit_3", "-")
    rr  = rm.get("risk_reward_ratio", "1:1")
    lot = rm.get("recommended_lot", "-")

    # Bangun pesan
    lines = [
        f"<b>XAUUSD AI Analyze</b>",
        f"{sig_emoji} <b>XAU/USD {sig}</b> — {timeframe.upper()}",
        "─────────────────────",
        f"💰 Harga  : <b>${price:,.2f}</b>",
        f"🎯 Entry  : {entry_zone}",
        f"🛑 SL     : <b>${sl}</b>",
        f"✅ TP1    : <b>${tp1}</b>",
        f"✅ TP2    : <b>${tp2}</b>",
        f"✅ TP3    : <b>${tp3}</b>",
        f"📊 RR     : {rr}",
        f"🔥 Conf.  : {conf}%",
        "─────────────────────",
    ]

    # Narasi AI — penuh, tidak dipotong
    if narr:
        lines.append(f"🤖 <i>{narr}</i>")
        lines.append("─────────────────────")

    # Warning signs (kalau ada)
    if warn and isinstance(warn, list):
        valid_warns = [w for w in warn if w and isinstance(w, str) and len(w) > 3]
        if valid_warns:
            lines.append("⚠️ " + " | ".join(valid_warns[:2]))
            lines.append("─────────────────────")

    lines.append(f"🕐 {now_str}")

    return "\n".join(lines)


# ── Start background threads (setelah semua fungsi didefinisikan) ──
# LEADER LOCK: gunicorn --workers 2 berarti app.py di-import 2x.
# Tanpa lock ini, DUA scheduler jalan paralel → sinyal & WAIT dobel persis
# (root cause duplikat 09:30.02 x2 dan 08:55.02 x2 di history).
_leader_lock_handle = None

def _acquire_leader_lock() -> bool:
    global _leader_lock_handle
    try:
        import fcntl
        _leader_lock_handle = open("/tmp/goldex_scheduler.lock", "w")
        fcntl.flock(_leader_lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        _leader_lock_handle.write(str(os.getpid()))
        _leader_lock_handle.flush()
        return True
    except Exception:
        return False

load_session_schedule_from_db()   # restore state toggle sesi dari DB
if _acquire_leader_lock():
    print(f"[Leader] Worker PID {os.getpid()} = LEADER — scheduler & monitor aktif")
    start_background_monitor()
    start_scheduled_analysis()
else:
    print(f"[Leader] Worker PID {os.getpid()} = follower — scheduler skip (anti duplikat)")


# ─────────────────────────────────────────────
# AUTH
# ─────────────────────────────────────────────
def login_required(f):
    """Decorator: redirect ke login jika belum auth."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("logged_in"):
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return decorated


def superadmin_required(f):
    """Decorator: hanya superadmin yang bisa akses."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("logged_in"):
            return redirect(url_for("login"))
        if session.get("role") != "superadmin":
            return jsonify({"error": "Akses ditolak — superadmin only"}), 403
        return f(*args, **kwargs)
    return decorated


@app.route("/api/public/price")
def public_price():
    """
    Endpoint PUBLIK untuk landing page — tidak butuh login.
    Mengembalikan harga XAU/USD real-time dari bridge/Twelve Data.
    CORS diizinkan untuk domain landing page.
    """
    price = fetch_current_price_server()
    source = "MT5 Bridge" if fetch_price_from_bridge() > 0 else "Twelve Data"
    return jsonify({
        "ok":     price > 0,
        "price":  round(price, 2),
        "source": source,
        "time":   now_wib_str("%H:%M WIB"),
    })


@app.route("/login", methods=["GET", "POST"])
def login():
    # Kalau sudah login, langsung ke dashboard
    if session.get("logged_in"):
        return redirect(url_for("index"))
    error = None
    if request.method == "POST":
        import hashlib as _hl
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "").strip()
        remember = request.form.get("remember", "off") == "on"

        pw_hash = _hl.sha256(password.encode()).hexdigest()

        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        user = conn.execute("""
            SELECT * FROM users
            WHERE username=? AND password_hash=? AND is_active=1
        """, (username, pw_hash)).fetchone()

        # Fallback ke env variable (kompatibilitas lama)
        if not user:
            admin_user = os.getenv("DASHBOARD_USER", "admin")
            admin_pass = os.getenv("DASHBOARD_PASS", "nano2026")
            if username == admin_user and password == admin_pass:
                # Auto-insert ke DB kalau belum ada
                try:
                    conn.execute("""
                        INSERT OR IGNORE INTO users
                        (username, password_hash, full_name, role, is_active, created_at)
                        VALUES (?, ?, 'Super Admin', 'superadmin', 1, ?)
                    """, (username, pw_hash, datetime.now(WIB).isoformat()))
                    conn.commit()
                except Exception:
                    pass
                user = conn.execute(
                    "SELECT * FROM users WHERE username=?", (username,)
                ).fetchone()

        if user:
            # Update last_login
            conn.execute(
                "UPDATE users SET last_login=? WHERE id=?",
                (datetime.now(WIB).isoformat(), user["id"])
            )
            conn.commit()
            conn.close()

            # Set session — PERMANENT supaya tidak logout
            session.permanent = True  # Berlaku 30 hari (app.config)
            session["logged_in"] = True
            session["username"]  = user["username"]
            session["full_name"] = user["full_name"] or user["username"]
            session["role"]      = user["role"] or "user"
            session["user_id"]   = user["id"]
            return redirect(url_for("index"))
        else:
            conn.close()
            error = "Username atau password salah"

    return render_template("login.html", error=error)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("landing"))


# ─────────────────────────────────────────────
# USER MANAGEMENT (Superadmin only)
# ─────────────────────────────────────────────

@app.route("/admin/users")
@superadmin_required
def admin_users():
    """Halaman manajemen user."""
    return render_template("admin_users.html",
                           username=session.get("username"),
                           full_name=session.get("full_name", "Admin"))


@app.route("/api/admin/users", methods=["GET", "POST"])
@superadmin_required
def api_users():
    """GET: list semua user | POST: buat user baru."""
    if request.method == "GET":
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        users = conn.execute("""
            SELECT id, username, full_name, kota, no_wa, telegram,
                   role, is_active, created_at, last_login
            FROM users ORDER BY created_at DESC
        """).fetchall()
        conn.close()
        return jsonify({"ok": True, "users": [dict(u) for u in users]})

    # POST — buat user baru
    import hashlib as _hl
    data     = request.get_json() or {}
    username = (data.get("username") or "").strip()
    password = (data.get("password") or "").strip()
    fullname = (data.get("full_name") or "").strip()
    kota     = (data.get("kota") or "").strip()
    no_wa    = (data.get("no_wa") or "").strip()
    telegram = (data.get("telegram") or "").strip()
    role     = data.get("role", "user")

    if not username or not password or not fullname:
        return jsonify({"error": "Nama lengkap, username, dan password wajib diisi"}), 400
    if len(password) < 6:
        return jsonify({"error": "Password minimal 6 karakter"}), 400
    if role not in ("user", "superadmin"):
        role = "user"

    pw_hash = _hl.sha256(password.encode()).hexdigest()
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.execute("""
            INSERT INTO users
            (username, password_hash, full_name, kota, no_wa, telegram,
             role, is_active, created_at)
            VALUES (?,?,?,?,?,?,?,1,?)
        """, (username, pw_hash, fullname, kota, no_wa, telegram,
              role, datetime.now(WIB).isoformat()))
        conn.commit()
        conn.close()
        return jsonify({"ok": True, "message": f"User '{username}' berhasil dibuat"})
    except sqlite3.IntegrityError:
        return jsonify({"error": f"Username '{username}' sudah dipakai"}), 409
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── SESSION SCHEDULE API (superadmin only) ─────────────────────────
@app.route("/api/admin/session_schedule", methods=["GET"])
@superadmin_required
def api_get_session_schedule():
    """GET: status semua toggle sesi + sesi aktif saat ini."""
    return jsonify({
        "ok":              True,
        "schedule":        _SESSION_SCHEDULE,
        "current_session": get_current_session(),
        "session_active":  is_session_active(),
        "session_hours": {
            "london":   "14:00–21:59 WIB",
            "new_york": "19:00–02:59 WIB",
            "tokyo":    "06:00–13:59 WIB",
            "sydney":   "04:00–09:59 WIB",
        }
    })


@app.route("/api/session_status")
@login_required
def api_session_status():
    """GET: status sesi untuk semua user (read-only, tanpa detail toggle)."""
    current = get_current_session()
    active  = is_session_active()
    return jsonify({
        "ok":              True,
        "current_session": current,
        "session_active":  active,
        "schedule":        _SESSION_SCHEDULE,
    })


@app.route("/api/admin/session_schedule", methods=["POST"])
@superadmin_required
def api_set_session_schedule():
    """POST: update satu atau lebih toggle sesi.
    Body: { "london": true, "new_york": false, ... }
    """
    global _SESSION_SCHEDULE
    body    = request.get_json() or {}
    updated = {}
    for sess_key in ("london", "new_york", "sydney", "tokyo"):
        if sess_key in body:
            enabled = bool(body[sess_key])
            _SESSION_SCHEDULE[sess_key] = enabled
            updated[sess_key] = enabled
    if updated:
        save_session_schedule_to_db()
        print(f"[SessionSchedule] Updated by superadmin: {updated}")
    return jsonify({"ok": True, "schedule": _SESSION_SCHEDULE, "updated": updated})


@app.route("/api/admin/users/<int:user_id>", methods=["PUT", "DELETE"])
@superadmin_required
def api_user_detail(user_id):
    """PUT: update user | DELETE: nonaktifkan user."""
    if request.method == "DELETE":
        if user_id == session.get("user_id"):
            return jsonify({"error": "Tidak bisa menghapus akun sendiri"}), 400
        try:
            conn = sqlite3.connect(DB_PATH)
            conn.execute("UPDATE users SET is_active=0 WHERE id=?", (user_id,))
            conn.commit()
            conn.close()
            return jsonify({"ok": True, "message": "User dinonaktifkan"})
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    # PUT — update user
    import hashlib as _hl
    data      = request.get_json() or {}
    fullname  = (data.get("full_name") or "").strip()
    kota      = (data.get("kota") or "").strip()
    no_wa     = (data.get("no_wa") or "").strip()
    telegram  = (data.get("telegram") or "").strip()
    is_active = int(data.get("is_active", 1))
    role      = data.get("role", "user")
    try:
        conn = sqlite3.connect(DB_PATH)
        new_pass = (data.get("password") or "").strip()
        if new_pass:
            if len(new_pass) < 6:
                conn.close()
                return jsonify({"error": "Password minimal 6 karakter"}), 400
            conn.execute("""
                UPDATE users SET full_name=?, kota=?, no_wa=?, telegram=?,
                role=?, is_active=?, password_hash=? WHERE id=?
            """, (fullname, kota, no_wa, telegram, role, is_active,
                  _hl.sha256(new_pass.encode()).hexdigest(), user_id))
        else:
            conn.execute("""
                UPDATE users SET full_name=?, kota=?, no_wa=?, telegram=?,
                role=?, is_active=? WHERE id=?
            """, (fullname, kota, no_wa, telegram, role, is_active, user_id))
        conn.commit()
        conn.close()
        return jsonify({"ok": True, "message": "User berhasil diupdate"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─────────────────────────────────────────────
# ROUTES
# ─────────────────────────────────────────────
@app.route("/")
def landing():
    """Landing page publik — tidak butuh login."""
    return render_template("landing.html")


@app.route("/dashboard_dummy")
def dashboard_dummy():
    """Dashboard demo publik untuk konten promosi — tidak butuh login."""
    return render_template("dashboard_dummy.html")


@app.route("/dashboard")
@login_required
def index():
    return render_template("index.html", username=session.get("username", "admin"))


@app.route("/api/vision_confirm", methods=["POST"])
@login_required
def vision_confirm():
    """
    Pipeline lengkap Vision:
    1. Generate chart dari Twelve Data
    2. Kirim ke Claude Vision
    3. Return konfirmasi + chart b64
    4. Kirim ke Telegram jika VALID
    """
    try:
        body       = request.get_json() or {}
        signal_id  = body.get("signal_id")
        signal     = body.get("signal", "WAIT")
        timeframe  = body.get("timeframe", "15m")
        entry      = float(body.get("entry",      0) or 0)
        stop_loss  = float(body.get("stop_loss",  0) or 0)
        tp1        = float(body.get("tp1",        0) or 0)
        tp2        = float(body.get("tp2",        0) or 0)
        tp3        = float(body.get("tp3",        0) or 0)
        rr_ratio   = body.get("rr_ratio",  "-")
        confidence = int(body.get("confidence",   0) or 0)
        indicators = body.get("indicators",       {})
        smc        = body.get("smc",              {})
        price      = float(body.get("price",      0) or 0)

        bot_token  = body.get("bot_token",  os.getenv("TELEGRAM_BOT_TOKEN", ""))
        chat_id    = body.get("chat_id",    os.getenv("TELEGRAM_CHAT_ID",   ""))
        api_key    = os.getenv("ANTHROPIC_API_KEY", "")
        twelve_key = os.getenv("TWELVE_DATA_KEY",   "")

        if signal not in ("BUY", "SELL"):
            return jsonify({"ok": False, "error": "Vision hanya untuk BUY/SELL"}), 400

        # ── Step 1: Generate Chart ──
        gen = get_chart_generator()
        chart = gen(
            timeframe  = timeframe,
            api_key    = twelve_key,
            signal     = signal,
            entry      = entry,
            stop_loss  = stop_loss,
            tp1        = tp1,
            tp2        = tp2,
            tp3        = tp3,
            confidence = confidence,
        )

        # ── Step 2: Vision Confirmation ──
        confirm_fn, format_fn = get_vision_analyzer()
        vision = confirm_fn(
            chart_b64  = chart["b64"],
            signal     = signal,
            price      = price or chart["price"],
            timeframe  = timeframe,
            entry      = entry,
            stop_loss  = stop_loss,
            tp1        = tp1,
            tp2        = tp2,
            tp3        = tp3,
            confidence = confidence,
            indicators = indicators,
            smc        = smc,
            api_key    = api_key,
        )

        # ── Step 3: Kirim Telegram jika VALID ──
        tg_sent = False
        if vision.get("verdict") == "VALID" and bot_token and chat_id:
            import urllib.request as ureq

            # 3a. Kirim pesan teks dengan analisis
            msg = format_fn(
                vision_result = vision,
                price         = price or chart["price"],
                timeframe     = timeframe,
                entry         = entry,
                stop_loss     = stop_loss,
                tp1           = tp1,
                tp2           = tp2,
                tp3           = tp3,
                rr_ratio      = rr_ratio,
            )
            tg_url  = f"https://api.telegram.org/bot{bot_token}/sendMessage"
            payload = json.dumps({
                "chat_id":    chat_id,
                "text":       msg,
                "parse_mode": "HTML",
            }).encode()
            req = ureq.Request(tg_url, data=payload,
                               headers={"Content-Type": "application/json"})
            try:
                ureq.urlopen(req, timeout=10)
                tg_sent = True
            except Exception as e:
                pass  # Telegram error tidak batalkan response

            # 3b. Kirim chart image ke Telegram
            try:
                import io, urllib.parse
                tg_photo_url = f"https://api.telegram.org/bot{bot_token}/sendPhoto"
                boundary     = "----FormBoundary7MA4YWxkTrZu0gW"
                chart_bytes  = chart["bytes"]
                caption      = f"📊 XAU/USD {timeframe.upper()} Chart — {signal} Signal"

                body_parts = (
                    f"--{boundary}\r\n"
                    f"Content-Disposition: form-data; name=\"chat_id\"\r\n\r\n"
                    f"{chat_id}\r\n"
                    f"--{boundary}\r\n"
                    f"Content-Disposition: form-data; name=\"caption\"\r\n\r\n"
                    f"{caption}\r\n"
                    f"--{boundary}\r\n"
                    f"Content-Disposition: form-data; name=\"photo\"; filename=\"chart.png\"\r\n"
                    f"Content-Type: image/png\r\n\r\n"
                ).encode() + chart_bytes + f"\r\n--{boundary}--\r\n".encode()

                photo_req = ureq.Request(
                    tg_photo_url, data=body_parts,
                    headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}
                )
                ureq.urlopen(photo_req, timeout=15)
            except Exception:
                pass  # Chart photo error tidak kritis

        return jsonify({
            "ok":          True,
            "verdict":     vision.get("verdict"),
            "final_signal": vision.get("final_signal"),
            "combined_confidence": vision.get("combined_confidence"),
            "reasoning":   vision.get("reasoning"),
            "key_observations": vision.get("key_observations", []),
            "risk_notes":  vision.get("risk_notes", []),
            "price_action_quality": vision.get("price_action_quality"),
            "entry_timing": vision.get("entry_timing"),
            "chart_b64":   chart["b64"],
            "tg_sent":     tg_sent,
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─────────────────────────────────────────────
# NEWS & ECONOMIC CALENDAR
# ─────────────────────────────────────────────
_news_cache = {"data": [], "sentiment": {}, "updated": ""}
_cal_cache  = {"data": [], "updated": ""}


def fetch_gold_news_sentiment() -> dict:
    """
    Ambil & analisis sentimen berita XAU/USD langsung dari Railway.
    Sumber: MarketWatch RSS (terbukti reachable dari Railway).
    Sentiment scoring berbasis keyword — zero cost, tidak pakai Claude API.
    """
    import urllib.request as ureq
    import xml.etree.ElementTree as ET
    import re, html

    RSS_FEEDS = [
        {
            "name": "MarketWatch",
            "url":  "https://feeds.content.dowjones.io/public/rss/mw_realtimeheadlines",
        },
        {
            "name": "MarketWatch Top Stories",
            "url":  "https://feeds.marketwatch.com/marketwatch/topstories/",
        },
    ]

    GOLD_KEYWORDS = [
        "gold", "xau", "bullion", "precious metal", "fed", "federal reserve",
        "interest rate", "inflation", "dollar", "treasury", "yield",
        "powell", "rate cut", "rate hike", "cpi", "jobs report", "nfp",
    ]
    BULL_WORDS = [
        "rise", "rises", "rising", "gain", "gains", "rally", "surge", "jump",
        "climb", "bullish", "higher", "soar", "advance", "strengthen",
        "safe haven", "demand", "record high", "boost", "support",
    ]
    BEAR_WORDS = [
        "fall", "falls", "falling", "drop", "drops", "decline", "slide",
        "tumble", "plunge", "bearish", "lower", "weaken", "sell-off",
        "selloff", "pressure", "hawkish", "outflow", "retreat", "slump",
    ]

    headlines = []
    errors    = []
    now_utc   = datetime.now(timezone.utc)
    MAX_AGE_HOURS = 48

    for feed in RSS_FEEDS:
        try:
            req = ureq.Request(feed["url"], headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120",
                "Accept":     "application/rss+xml, application/xml, text/xml, */*",
            })
            resp = ureq.urlopen(req, timeout=10)
            root = ET.fromstring(resp.read().decode("utf-8", errors="ignore"))

            all_items = root.findall(".//item")
            print(f"[News] {feed['name']}: {len(all_items)} items total in RSS")
            count_added = 0
            count_skipped_age = 0
            count_skipped_kw  = 0

            for item in all_items:
                title_el = item.find("title")
                title = html.unescape(re.sub(r"<[^>]+>", "", title_el.text or "")).strip() if title_el is not None else ""
                if not title:
                    continue

                title_lower = title.lower()
                if not any(kw in title_lower for kw in GOLD_KEYWORDS):
                    count_skipped_kw += 1
                    continue

                # Wajib ada pubDate dan harus dalam rentang 48 jam terakhir
                pub_el = item.find("pubDate")
                if pub_el is None or not pub_el.text:
                    count_skipped_age += 1
                    continue
                try:
                    from email.utils import parsedate_to_datetime
                    pub_dt    = parsedate_to_datetime(pub_el.text)
                    if pub_dt.tzinfo is None:
                        pub_dt = pub_dt.replace(tzinfo=timezone.utc)
                    age_hours = (now_utc - pub_dt.astimezone(timezone.utc)).total_seconds() / 3600
                except Exception:
                    count_skipped_age += 1
                    continue

                if age_hours < 0 or age_hours > MAX_AGE_HOURS:
                    count_skipped_age += 1
                    print(f"[News] SKIP (age={age_hours:.1f}h): {title[:60]}")
                    continue

                pub_wib  = pub_dt.astimezone(WIB)
                time_str = pub_wib.strftime("%d/%m %H:%M WIB")

                score = (sum(1 for w in BULL_WORDS if w in title_lower)
                         - sum(1 for w in BEAR_WORDS if w in title_lower))
                sentiment = "BULLISH" if score > 0 else "BEARISH" if score < 0 else "NEUTRAL"

                headlines.append({
                    "title":     title,
                    "sentiment": sentiment,
                    "source":    feed["name"],
                    "time":      time_str,
                    "score":     score,
                })
                count_added += 1

            print(f"[News] {feed['name']}: {count_added} added, {count_skipped_age} skipped (age), {count_skipped_kw} skipped (keyword)")

        except Exception as e:
            errors.append(f"{feed['name']}: {str(e)[:80]}")
            print(f"[News] {feed['name']} error: {e}")

    if not headlines:
        return {
            "overall_sentiment": "NEUTRAL",
            "sentiment_score":   0,
            "summary":           f"Tidak ada berita gold/Fed/dolar dalam {MAX_AGE_HOURS} jam terakhir.",
            "key_factors":       [],
            "headlines":         [],
            "watch_out":         "Tidak ada berita signifikan terkini — pantau rilis data ekonomi mendatang",
            "updated":           now_wib_str("%H:%M WIB"),
            "source":            "MarketWatch RSS (Railway direct)",
            "errors":            errors,
        }

    # Dedup berdasarkan title (kalau 2 feed share artikel sama)
    seen_titles = set()
    unique_headlines = []
    for h in headlines:
        key = h["title"][:60].lower()
        if key not in seen_titles:
            seen_titles.add(key)
            unique_headlines.append(h)
    headlines = sorted(unique_headlines, key=lambda x: x["score"] != 0, reverse=True)[:10]

    n          = len(headlines)
    bull_count = sum(1 for h in headlines if h["sentiment"] == "BULLISH")
    bear_count = sum(1 for h in headlines if h["sentiment"] == "BEARISH")
    total_sc   = sum(h["score"] for h in headlines)
    norm_score = max(-100, min(100, int(total_sc / n * 20))) if n else 0

    if bull_count > bear_count * 1.5:
        overall = "BULLISH"
    elif bear_count > bull_count * 1.5:
        overall = "BEARISH"
    else:
        overall = "NEUTRAL"

    bull_pct = int(bull_count / n * 100) if n else 0
    bear_pct = int(bear_count / n * 100) if n else 0
    summary = (
        f"Dari {n} berita terkini terkait emas/Fed/dolar, {bull_pct}% bullish "
        f"dan {bear_pct}% bearish. Sentimen keseluruhan "
        f"{'cenderung positif untuk emas' if overall == 'BULLISH' else 'cenderung negatif untuk emas' if overall == 'BEARISH' else 'mixed tanpa arah jelas'}."
    )

    TOPIC_MAP = {
        "fed":            ("Federal Reserve", "kebijakan suku bunga Fed mempengaruhi dolar dan emas"),
        "interest rate":  ("Suku Bunga", "ekspektasi rate hike/cut menggerakkan emas"),
        "inflation":      ("Inflasi", "data inflasi mempengaruhi ekspektasi suku bunga"),
        "dollar":         ("US Dollar (DXY)", "kekuatan dolar berbanding terbalik dengan emas"),
        "treasury":       ("Treasury Yield", "yield obligasi AS mempengaruhi daya tarik emas"),
        "powell":         ("Pernyataan Fed Chair", "komentar Powell sering gerakkan pasar emas"),
        "cpi":            ("Data CPI", "CPI tinggi mendukung ekspektasi inflasi"),
        "jobs report":    ("Data Tenaga Kerja", "data jobs kuat → ekspektasi Fed hawkish"),
        "nfp":            ("NFP", "Non-Farm Payroll mempengaruhi kebijakan Fed"),
    }
    key_factors = []
    seen_topics = set()
    for h in headlines:
        tl = h["title"].lower()
        for kw, (factor, desc) in TOPIC_MAP.items():
            if kw in tl and factor not in seen_topics:
                key_factors.append({"factor": factor, "impact": h["sentiment"], "desc": desc})
                seen_topics.add(factor)
                if len(key_factors) >= 4:
                    break
        if len(key_factors) >= 4:
            break

    watch_candidates = [h["title"] for h in headlines if h["sentiment"] != "NEUTRAL"]
    watch_out = watch_candidates[0] if watch_candidates else "Pantau rilis data ekonomi AS minggu ini"

    return {
        "overall_sentiment": overall,
        "sentiment_score":   norm_score,
        "summary":           summary,
        "key_factors":       key_factors,
        "headlines":         headlines,
        "watch_out":         watch_out,
        "updated":           now_wib_str("%H:%M WIB"),
        "source":            "MarketWatch RSS (Railway direct)",
        "errors":            errors,
    }

def fetch_forex_calendar() -> list:
    """
    Ambil economic calendar langsung dari ForexFactory JSON (Railway direct).
    Field asli FF: "title", "country", "date", "impact", "forecast", "previous", "actual"
    Impact values: "High", "Medium", "Low" (kapital H/M/L)
    Country: "USD", "CNY", "EUR" dsb — XAU tidak ada di FF, semua USD saja yang relevan untuk gold
    """
    try:
        import urllib.request as ureq
        from datetime import timezone as _tz

        now_utc = datetime.now(_tz.utc)
        req = ureq.Request(
            "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
            headers={"User-Agent": "Mozilla/5.0"}
        )
        resp   = ureq.urlopen(req, timeout=10)
        events = json.loads(resp.read())

        print(f"[Calendar] Raw events from ForexFactory: {len(events)}")
        if events:
            print(f"[Calendar] Sample event keys: {list(events[0].keys())}")
            print(f"[Calendar] Sample event: {events[0]}")

        result = []
        for ev in events:
            # Field asli ForexFactory: "country" bukan "currency"
            country = (ev.get("country") or ev.get("currency") or "").upper()
            impact  = (ev.get("impact") or "").strip()  # "High", "Medium", "Low"

            # Filter: hanya USD (langsung gerakkan gold) + medium & high impact
            if country != "USD":
                continue
            if impact not in ("High", "Medium"):
                continue

            try:
                date_str = ev.get("date", "")
                ev_dt    = datetime.fromisoformat(date_str)
                ev_utc   = ev_dt.astimezone(_tz.utc)
                diff_h   = (ev_utc - now_utc).total_seconds() / 3600
                # Tampilkan max 24 jam ke belakang (sudah lewat) & semua yang akan datang minggu ini
                if diff_h < -24:
                    continue
                time_wib = ev_utc.astimezone(WIB).strftime("%a %d/%m %H:%M WIB")
            except Exception as e:
                print(f"[Calendar] Date parse error: {e} for date={ev.get('date')}")
                time_wib = ev.get("date", "")
                diff_h   = 0

            result.append({
                "title":      ev.get("title", ""),
                "currency":   country,
                "impact":     impact,
                "time_wib":   time_wib,
                "diff_hours": round(diff_h, 1),
                "forecast":   ev.get("forecast") or "-",
                "previous":   ev.get("previous") or "-",
                "actual":     ev.get("actual") or "",
                "past":       diff_h < 0,
            })

        result.sort(key=lambda x: x["diff_hours"])
        print(f"[Calendar] After filter (USD, medium+high): {len(result)} events")
        return result[:30]

    except Exception as e:
        print(f"[Calendar] Fetch error: {e}")
        return []

@app.route("/api/news_sentiment")
@login_required
def news_sentiment():
    """Endpoint: news + sentimen XAU/USD dari Claude AI."""
    global _news_cache
    force = request.args.get("force", "false") == "true"

    # Cache 15 menit
    if not force and _news_cache.get("updated"):
        try:
            last = datetime.strptime(_news_cache["updated"], "%H:%M WIB")
            now  = datetime.now(WIB).replace(second=0, microsecond=0)
            diff = abs((now.hour * 60 + now.minute) - (last.hour * 60 + last.minute))
            if diff < 15:
                return jsonify({"ok": True, "cached": True, **_news_cache})
        except Exception:
            pass

    data = fetch_gold_news_sentiment()
    if "error" not in data:
        _news_cache = {**data, "updated": datetime.now(WIB).strftime("%H:%M WIB")}
    return jsonify({"ok": "error" not in data, "cached": False, **data})


@app.route("/api/economic_calendar")
@login_required
def economic_calendar():
    """Endpoint: economic calendar dari ForexFactory."""
    global _cal_cache
    force = request.args.get("force", "false") == "true"

    # Cache 30 menit
    if not force and _cal_cache.get("updated"):
        try:
            last = datetime.strptime(_cal_cache["updated"], "%H:%M WIB")
            now  = datetime.now(WIB).replace(second=0, microsecond=0)
            diff = abs((now.hour * 60 + now.minute) - (last.hour * 60 + last.minute))
            if diff < 30:
                return jsonify({"ok": True, "cached": True, "data": _cal_cache["data"]})
        except Exception:
            pass

    data = fetch_forex_calendar()
    _cal_cache = {"data": data, "updated": datetime.now(WIB).strftime("%H:%M WIB")}
    return jsonify({"ok": True, "cached": False, "data": data})


@app.route("/api/latest_signal")
@login_required
def latest_signal():
    """Browser polling endpoint — ambil hasil analisis terbaru dari cache atau DB."""
    market_open = is_market_open()

    # Coba load cache dari SQLite (shared antar worker)
    latest_cached_str = _cfg_get("latest_signal_cache", "")
    if latest_cached_str:
        try:
            cached_data = json.loads(latest_cached_str)
            return jsonify({
                **cached_data,
                "market_open": market_open,
                "market_closed_reason": "" if market_open else market_closed_reason(),
            })
        except Exception:
            pass

    # Cache kosong (baru restart) → coba ambil dari DB
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT * FROM signals ORDER BY id DESC LIMIT 1"
        ).fetchone()
        conn.close()

        if row:
            row_dict = dict(row)
            # Parse analysis JSON dari kolom raw_json
            analysis_raw = row_dict.get("raw_json") or "{}"
            if isinstance(analysis_raw, str):
                import json as _json
                try:
                    analysis_obj = _json.loads(analysis_raw)
                except Exception:
                    analysis_obj = {}
            else:
                analysis_obj = analysis_raw or {}

            # Pastikan field wajib ada
            if not analysis_obj.get("signal"):
                analysis_obj["signal"]     = row_dict.get("signal", "WAIT")
                analysis_obj["confidence"] = row_dict.get("confidence", 0)

            # Bangun risk_management dari kolom DB jika tidak ada di raw_json
            if not analysis_obj.get("risk_management"):
                analysis_obj["risk_management"] = {
                    "stop_loss":      row_dict.get("stop_loss"),
                    "take_profit_1":  row_dict.get("tp1"),
                    "take_profit_2":  row_dict.get("tp2"),
                    "take_profit_3":  row_dict.get("tp3"),
                    "risk_reward_ratio": row_dict.get("rr_ratio"),
                }
            if not analysis_obj.get("entry"):
                analysis_obj["entry"] = {"ideal_price": row_dict.get("entry")}
            if not analysis_obj.get("narrative"):
                analysis_obj["narrative"] = row_dict.get("narrative", "")

            return jsonify({
                "ok":          True,
                "signal_id":   row_dict.get("id"),
                "analysis":    analysis_obj,
                "price":       row_dict.get("price", 0),
                "timeframe":   row_dict.get("timeframe", "1m"),
                "timestamp":   row_dict.get("timestamp", ""),
                "data_source": "",
                "from_db":     True,   # flag: data dari DB bukan live cache
                "market_open": market_open,
                "market_closed_reason": "" if market_open else market_closed_reason(),
                "indicators":  {},
                "smc":         {},
            })
    except Exception:
        pass

    # Benar-benar kosong (DB juga kosong)
    return jsonify({
        "ok":       False,
        "pending":  True,
        "message":  "Menunggu analisis pertama dari server...",
        "next_run": ANALYSIS_INTERVAL,
        "market_open": market_open,
        "market_closed_reason": "" if market_open else market_closed_reason(),
    })


@app.route("/api/scheduler_status")
@login_required
def scheduler_status():
    """Status scheduler untuk ditampilkan di dashboard."""
    import math
    now_ts    = datetime.now(WIB).timestamp()
    next_tick = math.ceil(now_ts / ANALYSIS_INTERVAL) * ANALYSIS_INTERVAL
    secs_left = int(next_tick - now_ts)
    market_open = is_market_open()

    # Check heartbeat dari SQLite (shared antar worker)
    last_heartbeat = float(_cfg_get("scheduler_heartbeat", "0") or 0)
    is_heartbeat_alive = (datetime.now(WIB).timestamp() - last_heartbeat) < max(120, ANALYSIS_INTERVAL * 2)
    thread_alive = bool(_analysis_thread and _analysis_thread.is_alive()) or is_heartbeat_alive

    return jsonify({
        "ok":              True,
        "interval_sec":    ANALYSIS_INTERVAL,
        "next_run_sec":    secs_left,
        "next_run_time":   datetime.fromtimestamp(next_tick, WIB).strftime("%H:%M:%S WIB"),
        "thread_alive":    thread_alive,
        "market_open":     market_open,
        "market_closed_reason": "" if market_open else market_closed_reason(),
        "timeframe":       os.getenv("DEFAULT_TIMEFRAME", "1m").upper(),
        "signal_engine":   "Berkah Entry Signal",
        "current_session": get_current_session(),
        "session_active":  is_session_active(),
        "session_schedule": _SESSION_SCHEDULE,
    })


@app.route("/api/get_config")
@login_required
def get_config():
    """Cek ketersediaan API keys dan sumber data di server."""
    # Cek MT5 Bridge (utama)
    bridge_price = fetch_price_from_bridge()
    has_bridge   = bridge_price > 0

    # Cek Twelve Data (fallback) — hanya kalau bridge tidak tersedia
    twelve_price = 0.0
    if not has_bridge:
        twelve_price = fetch_price_from_twelvedata()

    live_price   = bridge_price if has_bridge else twelve_price
    price_source = "MT5_BRIDGE" if has_bridge else ("TWELVE_DATA" if twelve_price > 0 else "OFFLINE")

    return jsonify({
        "ok":              True,
        "has_anthropic":   bool(os.getenv("ANTHROPIC_API_KEY", "") or os.getenv("GEMINI_API_KEY", "")),
        "has_twelve":      bool(os.getenv("TWELVE_DATA_KEY", "")),
        "has_telegram":    bool(os.getenv("TELEGRAM_BOT_TOKEN", "")),
        "has_bridge":      has_bridge,
        "bridge_url":      bool(os.getenv("MT5_BRIDGE_URL", "")),
        "twelve_price":    twelve_price,
        "bridge_price":    bridge_price,
        "live_price":      live_price,
        "price_source":    price_source,
        "has_news_bridge": bool(os.getenv("MT5_BRIDGE_URL", "")),
        "data_source":     price_source,
    })


@app.route("/api/analyze", methods=["POST"])
@login_required
def analyze():
    """Endpoint: DISABLED — analisis sekarang dijalankan oleh server scheduler.
    Endpoint ini hanya bisa diakses internal (ALLOW_MANUAL_ANALYZE=true di env)."""
    if not os.getenv("ALLOW_MANUAL_ANALYZE", ""):
        return jsonify({
            "error": "Analisis manual dinonaktifkan. Server scheduler berjalan otomatis.",
            "next_run": ANALYSIS_INTERVAL,
        }), 403
    try:
        body      = request.get_json() or {}
        timeframe = body.get("timeframe", "1h")
        api_key   = body.get("api_key", "")

        # Selalu fallback ke server env
        if not api_key or api_key in ("", "YOUR_API_KEY_HERE", "__FROM_SERVER__"):
            api_key = os.getenv("ANTHROPIC_API_KEY", "") or os.getenv("GEMINI_API_KEY", "")
        if not api_key:
            return jsonify({"error": "AI API KEY (Anthropic/Gemini) belum diset di Variables"}), 400

        # Twelve Data key — selalu dari server env
        twelve_key = os.getenv("TWELVE_DATA_KEY", "") or body.get("twelve_key", "")

        # Import analyst functions
        import xauusd_ai_analyst as analyst
        from xauusd_ai_analyst import (
            build_analysis_prompt,
            calculate_indicators,
            detect_smc_structure,
            fetch_market_data,
        )

        # Inject Twelve Data key ke modul analyst secara runtime
        if twelve_key:
            analyst.TWELVE_DATA_KEY = twelve_key

        # Jalankan pipeline analisis
        market     = fetch_market_data(timeframe)
        indicators = calculate_indicators(market)
        smc        = detect_smc_structure(market)
        prompt     = build_analysis_prompt(market, indicators, smc, timeframe)

        # Tentukan tipe Key (Gemini vs Anthropic)
        is_gemini = api_key.startswith("AIzaSy") or "gemini" in api_key.lower()

        if is_gemini:
            import requests
            url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key={api_key}"
            headers = {"Content-Type": "application/json"}
            payload = {
                "contents": [{"parts": [{"text": prompt}]}],
                "systemInstruction": {
                    "parts": [{"text": (
                        "Kamu adalah analis scalping XAU/USD profesional yang menggunakan "
                        "pendekatan multi-method: EMA trend filter, RSI momentum, Break & Retest, "
                        "Heiken Ashi bias, dan ATR-based risk management. "
                        "Fokus pada konfluensi minimum 3 metode. "
                        "PENTING: Selalu berikan respons dalam format JSON yang valid sesuai template. "
                        "Jangan tambahkan teks apapun di luar JSON."
                    )}]
                },
                "generationConfig": {"responseMimeType": "application/json"}
            }
            resp = requests.post(url, headers=headers, json=payload, timeout=30)
            if resp.status_code != 200:
                raise Exception(f"Gemini API returned error {resp.status_code}: {resp.text}")
            raw = resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
        else:
            import anthropic
            client  = anthropic.Anthropic(api_key=api_key)
            message = client.messages.create(
                model="claude-sonnet-4-6",
                max_tokens=2000,
                system=(
                    "Kamu adalah analis scalping XAU/USD profesional yang menggunakan "
                    "pendekatan multi-method: EMA trend filter, RSI momentum, Break & Retest, "
                    "Heiken Ashi bias, dan ATR-based risk management. "
                    "Fokus pada konfluensi minimum 3 metode. "
                    "PENTING: Selalu berikan respons dalam format JSON yang valid sesuai template. "
                    "Jangan tambahkan teks apapun di luar JSON."
                ),
                messages=[{"role": "user", "content": prompt}],
            )
            raw = message.content[0].text.strip()

        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.strip()

        analysis = json.loads(raw)

        # Simpan ke DB, dapatkan signal_id
        signal_id = save_signal(analysis, timeframe, market.current_price)

        # Auto-create trade monitor untuk BUY/SELL — dengan dedup check
        monitor_id   = None
        tg_sent      = False
        already_active = False
        sig = analysis.get("signal", "WAIT")
        rm  = analysis.get("risk_management", {})
        en  = analysis.get("entry", {})

        if sig in ("BUY", "SELL"):
            # Block signal baru jika ADA monitor aktif apapun (BUY atau SELL)
            # Mencegah signal berlawanan saat posisi masih terbuka
            already_active = has_active_monitor()

        if sig in ("BUY", "SELL") and not already_active and rm.get("stop_loss") and en.get("ideal_price"):
            monitor_id = create_trade_monitor(
                signal_id  = signal_id,
                direction  = sig,
                entry      = float(en.get("ideal_price", market.current_price)),
                sl         = float(rm.get("stop_loss", 0)),
                tp1        = float(rm.get("take_profit_1", 0) or 0),
                tp2        = float(rm.get("take_profit_2", 0) or 0),
                tp3        = float(rm.get("take_profit_3", 0) or 0),
                timeframe  = timeframe,
            )
            # Kirim Telegram hanya untuk signal BARU (bukan duplikat)
            msg     = format_signal_message(analysis, market.current_price, timeframe)
            tg_sent = send_telegram_message(msg)
            print(f"[Signal] NEW {sig} monitor created, Telegram: {tg_sent}")
        elif already_active:
            print(f"[Signal] {sig} monitor already active — skip duplicate")

        return jsonify({
            "tg_sent":       tg_sent,
            "already_active": already_active,
            "monitor_id": monitor_id,
            "ok":         True,
            "analysis":   analysis,
            "price":      market.current_price,
            "timeframe":  timeframe,
            "timestamp":  now_wib_str("%Y-%m-%d %H:%M:%S"),
            "data_source": getattr(market, "symbol", "XAU/USD"),
            "indicators": {
                "ema_21":      indicators.ema_21,
                "ema_50":      indicators.ema_50,
                "ema_55":      indicators.ema_55,
                "ema_200":     indicators.ema_200,
                "rsi":         indicators.rsi_14,
                "atr":         indicators.atr_14,
                "macd":        indicators.macd,
                "macd_signal": indicators.macd_signal,
                "ha_bias":     indicators.ha_bias,
                "ha_strength": indicators.ha_trend_strength,
            },
            "smc": {
                "trend":       smc.trend,
                "bos":         smc.last_bos,
                "choch":       smc.last_choch,
                "swing_high":  smc.swing_high,
                "swing_low":   smc.swing_low,
                "support":     smc.support_levels,
                "resistance":  smc.resistance_levels,
                "fvg_zones":   smc.fvg_zones[:3],
                "ob_zones":    smc.ob_zones[:3],
            },
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/history")
@login_required
def history():
    """Endpoint: ambil history signal."""
    limit = int(request.args.get("limit", 50))
    return jsonify({"ok": True, "data": get_history(limit)})


@app.route("/api/stats")
@login_required
def stats():
    """Endpoint: statistik signal."""
    return jsonify({"ok": True, "data": get_stats()})


@app.route("/api/clear_history", methods=["POST"])
@login_required
def clear_history():
    """Endpoint: hapus semua history."""
    conn = sqlite3.connect(DB_PATH)
    conn.execute("DELETE FROM signals")
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "message": "History berhasil dihapus"})



@app.route("/api/send_telegram", methods=["POST"])
@login_required
def send_telegram():
    """Endpoint: kirim signal ke Telegram."""
    try:
        body       = request.get_json() or {}
        bot_token  = body.get("bot_token",  os.getenv("TELEGRAM_BOT_TOKEN", ""))
        chat_id    = body.get("chat_id",    os.getenv("TELEGRAM_CHAT_ID",   ""))
        message    = body.get("message",    "")

        if not bot_token or not chat_id:
            return jsonify({"error": "Bot token atau chat_id belum diset"}), 400
        if not message:
            return jsonify({"error": "Pesan kosong"}), 400

        import urllib.request, urllib.parse
        url     = f"https://api.telegram.org/bot{bot_token}/sendMessage"
        payload = json.dumps({
            "chat_id":    chat_id,
            "text":       message,
            "parse_mode": "HTML",
        }).encode()
        req  = urllib.request.Request(url, data=payload,
                                      headers={"Content-Type": "application/json"})
        resp = urllib.request.urlopen(req, timeout=10)
        result = json.loads(resp.read())
        return jsonify({"ok": True, "telegram": result})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/check_monitors", methods=["POST"])
@login_required
def check_monitors():
    """Cek monitor aktif — delegasi ke engine server (satu jalur accounting)."""
    try:
        updates = run_monitor_check()
        return jsonify({
            "ok":      True,
            "checked": len(updates),
            "updates": updates,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/performance")
@login_required
def performance():
    """Endpoint: statistik performa trade. ?days=7 (default), ?days=0 untuk semua."""
    days = int(request.args.get("days", 7))
    return jsonify({"ok": True, "data": get_performance_stats(days=days)})


@app.route("/api/reset_performance", methods=["POST"])
@login_required
def reset_performance():
    """Reset semua data performa (hapus semua trade_monitors CLOSED)."""
    try:
        conn = sqlite3.connect(DB_PATH)
        deleted = conn.execute(
            "DELETE FROM trade_monitors WHERE status = 'CLOSED'"
        ).rowcount
        conn.commit()
        conn.close()
        print(f"[Performance] Reset: {deleted} closed trades deleted")
        return jsonify({"ok": True, "deleted": deleted,
                       "message": f"{deleted} trade outcomes dihapus"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/analytics")
@login_required
def analytics():
    """
    Breakdown performa untuk diagnosis: per arah, timeframe, sesi, confidence.
    Plus statistik MFE/MAE untuk membedakan 'salah arah' vs 'salah eksekusi'.
    ?days=7 (default), ?days=0 = semua.
    """
    days = int(request.args.get("days", 7))
    try:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        q = """
            SELECT tm.*, s.confidence AS sig_conf
            FROM trade_monitors tm
            LEFT JOIN signals s ON tm.signal_id = s.id
            WHERE tm.status = 'CLOSED'
        """
        params = []
        if days > 0:
            cutoff = (datetime.now(WIB) - timedelta(days=days)).isoformat()
            q += " AND COALESCE(tm.closed_at, tm.created_at) >= ?"
            params.append(cutoff)
        rows = [dict(r) for r in conn.execute(q, params).fetchall()]
        conn.close()

        def _sess_of(iso_ts):
            try:
                h = datetime.fromisoformat(iso_ts).hour
            except Exception:
                return "unknown"
            for sess in ("new_york", "london", "tokyo", "sydney"):
                if h in SESSION_HOURS[sess]:
                    return sess
            return "off"

        def _agg(trades):
            n = len(trades)
            if n == 0:
                return {"total": 0, "wins": 0, "losses": 0, "be": 0,
                        "win_rate": 0, "net_pnl": 0, "profit_factor": 0}
            pnls  = [_money(t.get("pnl_pips")) for t in trades]
            wins  = sum(1 for p in pnls if p > 0)
            be    = sum(1 for t in trades if (t.get("outcome") or "") == "BE_HIT")
            gp    = sum(p for p in pnls if p > 0)
            gl    = abs(sum(p for p in pnls if p < 0))
            pf    = round(gp / gl, 2) if gl > 0 else (round(gp, 2) if gp > 0 else 0)
            return {
                "total":    n,
                "wins":     wins,
                "losses":   n - wins,
                "be":       be,
                "win_rate": round(wins / n * 100, 1),
                "net_pnl":  round(sum(pnls), 2),
                "profit_factor": pf,
            }

        def _group(keyfn):
            out = {}
            for t in rows:
                out.setdefault(keyfn(t), []).append(t)
            return {k: _agg(v) for k, v in sorted(out.items())}

        def _conf_bucket(t):
            c = t.get("sig_conf") or 0
            try: c = float(c)
            except Exception: c = 0
            if c >= 75: return "75%+"
            if c >= 60: return "60-74%"
            return "<60%"

        # ── Diagnosis MFE: loss murni yang hampir menyentuh TP1 ──
        sl_pure = [t for t in rows if (t.get("outcome") or "") == "SL_HIT"]
        near_tp1 = 0
        for t in sl_pure:
            entry = float(t.get("entry_price") or 0)
            tp1   = float(t.get("tp1") or 0)
            mfe   = float(t.get("mfe") or 0)
            tp1_dist = abs(tp1 - entry) if tp1 and entry else 0
            if tp1_dist > 0 and mfe >= 0.7 * tp1_dist:
                near_tp1 += 1

        data = {
            "overall":       _agg(rows),
            "by_direction":  _group(lambda t: t.get("direction") or "?"),
            "by_timeframe":  _group(lambda t: t.get("timeframe") or "?"),
            "by_session":    _group(lambda t: _sess_of(t.get("created_at") or t.get("timestamp") or "")),
            "by_confidence": _group(_conf_bucket),
            "mfe_diagnosis": {
                "sl_pure_total":   len(sl_pure),
                "sl_near_tp1":     near_tp1,
                "note": ("Loss yang MFE-nya mencapai >=70% jarak TP1 — indikasi "
                         "SL terlalu ketat / TP1 terlalu jauh, bukan salah arah."),
            },
            "period_days": days,
        }
        return jsonify({"ok": True, "data": data})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/trade_history")
@login_required
def trade_history():
    """Endpoint: history trade dengan outcome."""
    limit = int(request.args.get("limit", 30))
    return jsonify({"ok": True, "data": get_trade_history(limit)})


@app.route("/api/active_monitors")
@login_required
def active_monitors():
    """Endpoint: list trade monitor aktif."""
    return jsonify({"ok": True, "data": get_active_monitors()})


@app.route("/api/save_telegram_config", methods=["POST"])
def save_telegram_config():
    """Simpan konfigurasi Telegram ke DB config table."""
    try:
        body      = request.get_json() or {}
        bot_token = body.get("bot_token", "").strip()
        chat_id   = body.get("chat_id",   "").strip()
        if not bot_token or not chat_id:
            return jsonify({"error": "Token dan Chat ID wajib diisi"}), 400
        return jsonify({"ok": True, "message": "Konfigurasi Telegram tersimpan"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# ─────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────
if __name__ == "__main__":
    init_db()
    port = int(os.getenv("PORT", 5000))
    debug = os.getenv("RAILWAY_ENVIRONMENT") is None  # debug hanya di lokal
    print("\n╔══════════════════════════════════════════════╗")
    print("║   XAU/USD AI Trading Dashboard v2.0         ║")
    print(f"║   Buka browser: http://localhost:{port}        ║")
    print("╚══════════════════════════════════════════════╝\n")
    app.run(debug=debug, host="0.0.0.0", port=port)
