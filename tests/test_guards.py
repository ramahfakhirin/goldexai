"""
Unit test untuk logika guard/scoring yang berkaitan dengan risk-management
sinyal trading: is_direction_blocked (rolling-window loss guard),
get_trend_age_days, get_vision_rescue_stats, dan endpoint
/api/admin/guard_status.

Import app.py di-guard lewat env var GOLDEX_DISABLE_SCHEDULER_AUTOSTART=1
supaya TIDAK memicu leader-election/scheduler thread produksi saat test
jalan (app.py men-start scheduler di level modul, bukan di dalam
__main__, karena Gunicorn multi-worker perlu tiap worker ikut leader
election saat di-import — lihat komentar di app.py sebelum blok startup).
DB_PATH di-arahkan ke file sementara per test supaya tidak menyentuh
data/signals.db asli.

Jalankan dari root project:
    python -m unittest discover tests -v
"""
import os
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

os.environ["GOLDEX_DISABLE_SCHEDULER_AUTOSTART"] = "1"

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import app as goldex_app  # noqa: E402

WIB = timezone(timedelta(hours=7))


class GuardTestCase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self._db_path = Path(self._tmpdir.name) / "test_signals.db"
        goldex_app.DB_PATH = self._db_path
        goldex_app.init_db()

    def tearDown(self):
        self._tmpdir.cleanup()

    def _insert_trade(self, direction, outcome, hours_ago, vision_rescued=0,
                       pnl=0.0, mult=1, signal_id=None):
        conn = sqlite3.connect(self._db_path)
        ts = (datetime.now(WIB) - timedelta(hours=hours_ago)).isoformat()
        if signal_id is None:
            signal_id = -(abs(hash((direction, outcome, hours_ago))) % 100000 + 1)
        conn.execute("""
            INSERT INTO trade_monitors
            (signal_id, timestamp, created_at, timeframe, direction, entry_price,
             stop_loss, tp1, tp2, tp3, status, outcome, outcome_price, outcome_time,
             closed_at, pnl_pips, martingale_mult, vision_rescued)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (signal_id, ts, ts, "M5", direction, 4000, 3990, 4010, 4020, 4030,
              "CLOSED", outcome, 4000, ts, ts, pnl, mult, vision_rescued))
        conn.commit()
        conn.close()

    # ── is_direction_blocked — rolling window loss guard ──

    def test_not_blocked_with_no_history(self):
        blocked, _ = goldex_app.is_direction_blocked("BUY")
        self.assertFalse(blocked)

    def test_blocked_on_interspersed_losses_within_window(self):
        """3 SL dari 6 trade terakhir, TIDAK beruntun — pola persis yang
        lolos dari guard versi lama (consecutive-only) dan memicu fix ini."""
        pattern = [
            ("SL_HIT", 5), ("TP1_HIT", 4), ("SL_HIT", 3),
            ("TP3_HIT", 2), ("BE_HIT", 1.5), ("SL_HIT", 0.75),
        ]
        for outcome, hrs in pattern:
            self._insert_trade("BUY", outcome, hrs)
        blocked, note = goldex_app.is_direction_blocked("BUY")
        self.assertTrue(blocked)
        self.assertIn("3x SL", note)

    def test_not_blocked_when_below_threshold(self):
        """Cuma 2 SL dari 6 — di bawah default threshold 3, tidak diblokir."""
        pattern = [
            ("SL_HIT", 5), ("TP1_HIT", 4), ("TP2_HIT", 3),
            ("TP3_HIT", 2), ("BE_HIT", 1.5), ("SL_HIT", 0.75),
        ]
        for outcome, hrs in pattern:
            self._insert_trade("BUY", outcome, hrs)
        blocked, _ = goldex_app.is_direction_blocked("BUY")
        self.assertFalse(blocked)

    def test_block_expires_after_block_hours(self):
        """3 SL ada, tapi SL terakhir sudah lebih lama dari
        LOSS_STREAK_BLOCK_HOURS (default 3 jam) — blokir sudah kadaluarsa."""
        pattern = [
            ("SL_HIT", 20), ("SL_HIT", 15), ("SL_HIT", 10),
            ("TP1_HIT", 5), ("BE_HIT", 3), ("TP3_HIT", 1),
        ]
        for outcome, hrs in pattern:
            self._insert_trade("BUY", outcome, hrs)
        blocked, _ = goldex_app.is_direction_blocked("BUY")
        self.assertFalse(blocked)

    def test_directions_are_independent(self):
        for outcome, hrs in [("SL_HIT", 5), ("SL_HIT", 3), ("SL_HIT", 1)]:
            self._insert_trade("BUY", outcome, hrs)
        blocked_buy, _  = goldex_app.is_direction_blocked("BUY")
        blocked_sell, _ = goldex_app.is_direction_blocked("SELL")
        self.assertTrue(blocked_buy)
        self.assertFalse(blocked_sell)

    # ── get_trend_age_days ──

    def test_trend_age_zero_with_no_history(self):
        self.assertEqual(goldex_app.get_trend_age_days("BUY"), 0.0)

    def test_trend_age_measured_from_opposite_direction(self):
        self._insert_trade("SELL", "TP1_HIT", 72)  # 3 hari lalu
        age = goldex_app.get_trend_age_days("BUY")
        self.assertAlmostEqual(age, 3.0, delta=0.05)

    def test_trend_age_falls_back_to_first_same_direction_trade(self):
        """Tidak ada histori SELL sama sekali — umur tren dihitung dari
        trade BUY PERTAMA, bukan 0."""
        self._insert_trade("BUY", "TP1_HIT", 240, signal_id=-1)  # 10 hari lalu (tertua)
        self._insert_trade("BUY", "SL_HIT", 1,  signal_id=-2)    # 1 jam lalu (terbaru)
        age = goldex_app.get_trend_age_days("BUY")
        self.assertAlmostEqual(age, 10.0, delta=0.05)

    # ── get_vision_rescue_stats ──

    def test_vision_rescue_stats_splits_correctly(self):
        self._insert_trade("BUY", "TP3_HIT", 5, vision_rescued=0, pnl=100)
        self._insert_trade("BUY", "SL_HIT",  4, vision_rescued=0, pnl=-50)
        self._insert_trade("BUY", "TP1_HIT", 3, vision_rescued=1, pnl=30)
        self._insert_trade("BUY", "SL_HIT",  2, vision_rescued=1, pnl=-50)
        self._insert_trade("BUY", "SL_HIT",  1, vision_rescued=1, pnl=-50)

        stats = goldex_app.get_vision_rescue_stats(days=30)
        self.assertEqual(stats["auto_pass"]["total"], 2)
        self.assertEqual(stats["auto_pass"]["wins"], 1)
        self.assertEqual(stats["auto_pass"]["losses"], 1)
        self.assertEqual(stats["vision_rescued"]["total"], 3)
        self.assertEqual(stats["vision_rescued"]["wins"], 1)
        self.assertEqual(stats["vision_rescued"]["losses"], 2)

    # ── /api/admin/guard_status ──

    def test_guard_status_endpoint_requires_superadmin(self):
        client = goldex_app.app.test_client()
        with client.session_transaction() as sess:
            sess["logged_in"] = True
            sess["role"] = "user"
        resp = client.get("/api/admin/guard_status")
        self.assertEqual(resp.status_code, 403)

    def test_guard_status_endpoint_returns_expected_shape(self):
        for outcome, hrs in [("SL_HIT", 5), ("SL_HIT", 3), ("SL_HIT", 1)]:
            self._insert_trade("BUY", outcome, hrs)
        client = goldex_app.app.test_client()
        with client.session_transaction() as sess:
            sess["logged_in"] = True
            sess["role"] = "superadmin"
        resp = client.get("/api/admin/guard_status")
        self.assertEqual(resp.status_code, 200)
        data = resp.get_json()
        self.assertTrue(data["ok"])
        self.assertTrue(data["buy"]["blocked"])
        self.assertIn("vision_rescue", data)


if __name__ == "__main__":
    unittest.main()
