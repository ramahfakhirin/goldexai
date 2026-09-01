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
import types
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
                       pnl=0.0, mult=1, signal_id=None,
                       m1_signal=None, m1_score=None, m1_confidence=None,
                       entry_spread=None, entry_price=4000, stop_loss=3990,
                       vision_verdict=None, near_smc=None,
                       entry_spread_estimasi=0):
        conn = sqlite3.connect(self._db_path)
        ts = (datetime.now(WIB) - timedelta(hours=hours_ago)).isoformat()
        if signal_id is None:
            signal_id = -(abs(hash((direction, outcome, hours_ago))) % 100000 + 1)
        conn.execute("""
            INSERT INTO trade_monitors
            (signal_id, timestamp, created_at, timeframe, direction, entry_price,
             stop_loss, tp1, tp2, tp3, status, outcome, outcome_price, outcome_time,
             closed_at, pnl_pips, martingale_mult, vision_rescued,
             m1_signal, m1_score, m1_confidence, entry_spread,
             vision_verdict, near_smc, entry_spread_estimasi)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (signal_id, ts, ts, "M5", direction, entry_price, stop_loss, 4010, 4020, 4030,
              "CLOSED", outcome, 4000, ts, ts, pnl, mult, vision_rescued,
              m1_signal, m1_score, m1_confidence, entry_spread,
              vision_verdict, near_smc, entry_spread_estimasi))
        conn.commit()
        conn.close()

    # ── get_entry_spread — nilai cadangan saat bridge diam ──

    def test_entry_spread_pakai_bridge_kalau_tersedia(self):
        asli = goldex_app.get_bridge_spread
        goldex_app.get_bridge_spread = lambda: 0.42
        try:
            nilai, estimasi = goldex_app.get_entry_spread()
        finally:
            goldex_app.get_bridge_spread = asli
        self.assertEqual(nilai, 0.42)
        self.assertFalse(estimasi)

    def test_entry_spread_jatuh_ke_default_kalau_bridge_diam(self):
        asli = goldex_app.get_bridge_spread
        goldex_app.get_bridge_spread = lambda: None
        os.environ["DEFAULT_SPREAD"] = "0.35"
        try:
            nilai, estimasi = goldex_app.get_entry_spread()
        finally:
            goldex_app.get_bridge_spread = asli
        self.assertEqual(nilai, 0.35)
        self.assertTrue(estimasi)

    def test_spread_stats_memisahkan_terukur_dari_asumsi(self):
        """Nilai default tidak boleh menarik rata-rata yang terukur."""
        self._insert_trade("BUY", "TP3_HIT", 5, pnl=30, entry_spread=0.20,
                           entry_spread_estimasi=0)
        self._insert_trade("BUY", "SL_HIT", 4, pnl=-10, entry_spread=0.30,
                           entry_spread_estimasi=0)
        self._insert_trade("SELL", "SL_HIT", 3, pnl=-10, entry_spread=0.35,
                           entry_spread_estimasi=1)
        st = goldex_app.get_spread_stats(days=30)
        self.assertEqual(st["terekam"], 3)
        self.assertEqual(st["jumlah_terukur"], 2)
        self.assertEqual(st["jumlah_diasumsikan"], 1)
        # rata-rata terukur hanya dari dua baris pertama
        self.assertEqual(st["spread_rata2_terukur"], 0.25)

    # ── get_vision_shadow_stats — instrumentasi, bukan gerbang ──

    def test_shadow_stats_kosong_saat_belum_ada_data(self):
        self._insert_trade("BUY", "SL_HIT", 2, pnl=-10)
        st = goldex_app.get_vision_shadow_stats(days=30)
        self.assertEqual(st["belum_terekam"], 1)
        self.assertEqual(st["vision_valid"]["total"], 0)
        self.assertEqual(st["vision_non_valid"]["total"], 0)

    def test_shadow_stats_memisahkan_valid_dan_non_valid(self):
        self._insert_trade("BUY", "TP3_HIT", 5, pnl=30, vision_verdict="VALID", near_smc=1)
        self._insert_trade("BUY", "TP3_HIT", 4, pnl=20, vision_verdict="VALID", near_smc=1)
        self._insert_trade("SELL", "SL_HIT", 3, pnl=-10, vision_verdict="SKIP", near_smc=1)
        self._insert_trade("SELL", "SL_HIT", 2, pnl=-10,
                           vision_verdict="WAIT_FOR_PULLBACK", near_smc=0)
        st = goldex_app.get_vision_shadow_stats(days=30)

        self.assertEqual(st["vision_valid"]["total"], 2)
        self.assertEqual(st["vision_non_valid"]["total"], 2)
        # SKIP + WAIT_FOR_PULLBACK dua-duanya kena SL
        self.assertEqual(st["vision_non_valid"]["sl_rate"], 100.0)
        self.assertEqual(st["vision_valid"]["sl_rate"], 0.0)
        self.assertEqual(st["sebaran_verdict"]["VALID"], 2)
        self.assertEqual(st["sebaran_verdict"]["SKIP"], 1)
        self.assertEqual(st["near_smc_terekam"], 3)
        self.assertEqual(st["belum_terekam"], 0)

    def test_shadow_stats_hipotetis_veto_memisahkan_sisa_dan_buangan(self):
        self._insert_trade("BUY", "TP3_HIT", 5, pnl=30, vision_verdict="VALID")
        self._insert_trade("SELL", "SL_HIT", 3, pnl=-10, vision_verdict="SKIP")
        st = goldex_app.get_vision_shadow_stats(days=30)
        hip = st["hipotetis_jika_veto_aktif"]
        self.assertEqual(hip["tersisa"]["total"], 1)
        self.assertEqual(hip["terbuang"]["total"], 1)
        self.assertEqual(hip["semua_apa_adanya"]["total"], 2)

    def test_shadow_stats_tidak_menghitung_trade_tanpa_verdict(self):
        """Trade lama (kolom belum ada) tidak boleh mencemari perbandingan."""
        self._insert_trade("BUY", "SL_HIT", 5, pnl=-10)
        self._insert_trade("BUY", "TP3_HIT", 4, pnl=30, vision_verdict="VALID")
        st = goldex_app.get_vision_shadow_stats(days=30)
        self.assertEqual(st["belum_terekam"], 1)
        self.assertEqual(st["vision_valid"]["total"], 1)
        self.assertIsNone(st["vision_non_valid"]["win_rate"])

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

    # ── get_m1_agreement_stats ──

    def test_m1_stats_splits_agree_vs_disagree(self):
        # M1 setuju (BUY): 1 menang, 1 SL
        self._insert_trade("BUY", "TP3_HIT", 6, pnl=100, signal_id=-101,
                           m1_signal="BUY", m1_score=4, m1_confidence="NORMAL")
        self._insert_trade("BUY", "SL_HIT", 5, pnl=-50, signal_id=-102,
                           m1_signal="BUY", m1_score=3, m1_confidence="NORMAL")
        # M1 menolak: 3 SL, 1 menang
        for i, (o, p) in enumerate([("SL_HIT", -50), ("SL_HIT", -50), ("SL_HIT", -50)]):
            self._insert_trade("BUY", o, 4 - i * 0.5, pnl=p, signal_id=-(200 + i),
                               m1_signal="WAIT", m1_score=0, m1_confidence="OVEREXTENDED")
        self._insert_trade("BUY", "TP3_HIT", 1, pnl=100, signal_id=-210,
                           m1_signal="WAIT", m1_score=2, m1_confidence="WAIT")

        s = goldex_app.get_m1_agreement_stats(days=30)
        self.assertEqual(s["m1_setuju"]["total"], 2)
        self.assertEqual(s["m1_setuju"]["sl_hit"], 1)
        self.assertEqual(s["m1_tidak_setuju"]["total"], 4)
        self.assertEqual(s["m1_tidak_setuju"]["sl_hit"], 3)
        # sl_rate inilah angka yang menentukan layak-tidaknya M1 jadi veto
        self.assertEqual(s["m1_setuju"]["sl_rate"], 50.0)
        self.assertEqual(s["m1_tidak_setuju"]["sl_rate"], 75.0)

    def test_m1_stats_counts_rejection_reasons(self):
        self._insert_trade("BUY", "SL_HIT", 5, pnl=-50, signal_id=-301,
                           m1_signal="WAIT", m1_confidence="OVEREXTENDED")
        self._insert_trade("BUY", "SL_HIT", 4, pnl=-50, signal_id=-302,
                           m1_signal="WAIT", m1_confidence="OVEREXTENDED")
        self._insert_trade("BUY", "SL_HIT", 3, pnl=-50, signal_id=-303,
                           m1_signal="WAIT", m1_confidence="LOW_VOLATILITY")
        s = goldex_app.get_m1_agreement_stats(days=30)
        self.assertEqual(s["alasan_m1_menolak"]["OVEREXTENDED"], 2)
        self.assertEqual(s["alasan_m1_menolak"]["LOW_VOLATILITY"], 1)

    def test_m1_stats_separates_untracked_old_trades(self):
        """Trade lama (m1_signal NULL) tidak boleh mencemari perbandingan."""
        self._insert_trade("BUY", "SL_HIT", 5, pnl=-50, signal_id=-401)   # tanpa m1_*
        self._insert_trade("BUY", "TP3_HIT", 4, pnl=100, signal_id=-402,
                           m1_signal="BUY", m1_confidence="NORMAL")
        s = goldex_app.get_m1_agreement_stats(days=30)
        self.assertEqual(s["belum_terekam"], 1)
        self.assertEqual(s["m1_setuju"]["total"], 1)
        self.assertEqual(s["m1_tidak_setuju"]["total"], 0)

    def test_m1_stats_empty_is_safe(self):
        s = goldex_app.get_m1_agreement_stats(days=30)
        self.assertEqual(s["m1_setuju"]["total"], 0)
        self.assertIsNone(s["m1_setuju"]["win_rate"])
        self.assertEqual(s["belum_terekam"], 0)

    # ── get_spread_stats ──

    def test_spread_pct_of_sl_dihitung_benar(self):
        # SL 10 poin, spread 2 poin -> 20% risiko termakan biaya
        for i in range(4):
            self._insert_trade("BUY", "TP3_HIT", 5 - i, pnl=50, signal_id=-(500 + i),
                               entry_spread=2.0, entry_price=4000, stop_loss=3990)
        s = goldex_app.get_spread_stats(days=30)
        self.assertEqual(s["terekam"], 4)
        self.assertEqual(s["spread_rata2"], 2.0)
        self.assertEqual(s["sl_distance_rata2"], 10.0)
        self.assertEqual(s["spread_pct_of_sl"], 20.0)

    def test_estimasi_biaya_ikut_martingale(self):
        # PNL_MULT = 0.10 lot x 100 = 10 per poin.
        # spread 2 poin @1x = $20 ; @4x = $80  -> total $100
        self._insert_trade("BUY", "SL_HIT", 5, pnl=-50, signal_id=-601,
                           entry_spread=2.0, mult=1)
        self._insert_trade("BUY", "SL_HIT", 4, pnl=-50, signal_id=-602,
                           entry_spread=2.0, mult=4)
        s = goldex_app.get_spread_stats(days=30)
        self.assertEqual(s["estimasi_biaya_usd"], 100.0)

    def test_spread_lebar_vs_sempit_dipisah(self):
        # 2 spread sempit (semua menang), 2 spread lebar (semua SL)
        self._insert_trade("BUY", "TP3_HIT", 8, pnl=50, signal_id=-701, entry_spread=0.5)
        self._insert_trade("BUY", "TP3_HIT", 7, pnl=50, signal_id=-702, entry_spread=0.6)
        self._insert_trade("BUY", "SL_HIT", 6, pnl=-50, signal_id=-703, entry_spread=4.0)
        self._insert_trade("BUY", "SL_HIT", 5, pnl=-50, signal_id=-704, entry_spread=5.0)
        s = goldex_app.get_spread_stats(days=30)
        self.assertEqual(s["per_kelompok"]["spread_sempit"]["sl_rate"], 0.0)
        self.assertEqual(s["per_kelompok"]["spread_lebar"]["sl_rate"], 100.0)

    def test_trade_tanpa_spread_dipisah_bukan_dianggap_nol(self):
        """entry_spread NULL harus masuk belum_terekam, BUKAN dihitung 0 —
        kalau dianggap 0 ia akan menurunkan rata-rata secara palsu."""
        self._insert_trade("BUY", "SL_HIT", 5, pnl=-50, signal_id=-801)   # tanpa spread
        self._insert_trade("BUY", "TP3_HIT", 4, pnl=50, signal_id=-802, entry_spread=3.0)
        s = goldex_app.get_spread_stats(days=30)
        self.assertEqual(s["terekam"], 1)
        self.assertEqual(s["belum_terekam"], 1)
        self.assertEqual(s["spread_rata2"], 3.0)

    def test_spread_stats_kosong_aman(self):
        s = goldex_app.get_spread_stats(days=30)
        self.assertEqual(s["terekam"], 0)
        self.assertIsNone(s["spread_pct_of_sl"])
        self.assertIsNone(s["estimasi_biaya_usd"])

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


def _fake_smc(ob_zones=None, fvg_zones=None, support_levels=None, resistance_levels=None):
    return types.SimpleNamespace(
        ob_zones=ob_zones or [], fvg_zones=fvg_zones or [],
        support_levels=support_levels or [], resistance_levels=resistance_levels or [],
    )


class SLWideningTestCase(unittest.TestCase):
    """widen_sl_for_smc_structure — perluas SL saat jatuh di tengah zona OB/FVG."""

    def test_no_zones_leaves_sl_unchanged(self):
        sl = goldex_app.widen_sl_for_smc_structure("BUY", 4000, 3990, _fake_smc())
        self.assertEqual(sl, 3990)

    def test_sl_outside_any_zone_unchanged(self):
        smc = _fake_smc(ob_zones=[{"low": 3950, "high": 3960, "type": "BULLISH OB"}])
        sl = goldex_app.widen_sl_for_smc_structure("BUY", 4000, 3990, smc)
        self.assertEqual(sl, 3990)

    def test_buy_sl_inside_zone_widens_below_it(self):
        # SL asli 3990 (jarak 10 dari entry) jatuh di tengah zona [3987, 3993]
        # -- harus digeser ke bawah 3987 (sisi zona yang lebih jauh dari
        # entry 4000), masih dalam batas cap 1.5x (15 poin).
        smc = _fake_smc(ob_zones=[{"low": 3987, "high": 3993, "type": "BULLISH OB"}])
        sl = goldex_app.widen_sl_for_smc_structure("BUY", 4000, 3990, smc)
        self.assertLess(sl, 3987)
        self.assertAlmostEqual(sl, 3986.5, delta=0.01)

    def test_sell_sl_inside_zone_widens_above_it(self):
        smc = _fake_smc(ob_zones=[{"low": 4007, "high": 4013, "type": "BEARISH OB"}])
        sl = goldex_app.widen_sl_for_smc_structure("SELL", 4000, 4010, smc)
        self.assertGreater(sl, 4013)
        self.assertAlmostEqual(sl, 4013.5, delta=0.01)

    def test_widening_never_tightens_sl(self):
        # Zona jauh di seberang entry dari SL -- tidak boleh mempersempit apapun.
        smc = _fake_smc(ob_zones=[{"low": 4050, "high": 4060, "type": "BULLISH OB"}])
        sl = goldex_app.widen_sl_for_smc_structure("BUY", 4000, 3990, smc)
        self.assertEqual(sl, 3990)

    def test_widening_capped_at_1_5x_original_distance(self):
        # Original dist = 10 (4000-3990) -- zona sangat lebar/dekat entry
        # yang kalau dituruti akan melebar >1.5x (>15 poin) harus DITOLAK.
        smc = _fake_smc(ob_zones=[{"low": 3970, "high": 3995, "type": "BULLISH OB"}])
        sl = goldex_app.widen_sl_for_smc_structure("BUY", 4000, 3990, smc)
        self.assertLessEqual(4000 - sl, 15.0)

    def test_stacked_zones_widen_iteratively(self):
        # Dua zona bertumpuk berurutan -- SL harus bersih dari KEDUANYA,
        # bukan cuma zona pertama yang ditemukan. entry-sl jarak dibuat besar
        # (50 poin, cap 75) supaya dua tahap perluasan tidak kena cap.
        smc = _fake_smc(ob_zones=[
            {"low": 3945, "high": 3955, "type": "BULLISH OB"},
            {"low": 3935, "high": 3945, "type": "BULLISH OB"},
        ])
        sl = goldex_app.widen_sl_for_smc_structure("BUY", 4000, 3950, smc)
        self.assertLess(sl, 3935)


class NearSmcLevelTestCase(unittest.TestCase):
    """is_near_strong_smc_level — dipakai buat Vision Veto (default off)."""

    def test_far_from_any_level_returns_false(self):
        smc = _fake_smc(support_levels=[3900], resistance_levels=[4100])
        self.assertFalse(goldex_app.is_near_strong_smc_level(4000, smc, atr_val=5.0))

    def test_near_support_level_returns_true(self):
        # threshold = 0.5 x ATR(5) = 2.5 -- harga 3998 cuma 2 poin dari support 4000
        smc = _fake_smc(support_levels=[4000])
        self.assertTrue(goldex_app.is_near_strong_smc_level(3998, smc, atr_val=5.0))

    def test_near_resistance_level_returns_true(self):
        smc = _fake_smc(resistance_levels=[4000])
        self.assertTrue(goldex_app.is_near_strong_smc_level(4001.5, smc, atr_val=5.0))

    def test_inside_ob_zone_returns_true(self):
        smc = _fake_smc(ob_zones=[{"low": 3995, "high": 4005, "type": "BULLISH OB"}])
        self.assertTrue(goldex_app.is_near_strong_smc_level(4000, smc, atr_val=5.0))

    def test_near_fvg_zone_edge_returns_true(self):
        smc = _fake_smc(fvg_zones=[{"low": 4010, "high": 4020, "type": "BULLISH FVG"}])
        # 4008 ada 2 poin di bawah tepi zona (4010) -- dalam threshold 2.5
        self.assertTrue(goldex_app.is_near_strong_smc_level(4008, smc, atr_val=5.0))

    def test_zero_atr_returns_false(self):
        smc = _fake_smc(support_levels=[4000])
        self.assertFalse(goldex_app.is_near_strong_smc_level(4000, smc, atr_val=0.0))

    def test_no_levels_at_all_returns_false(self):
        self.assertFalse(goldex_app.is_near_strong_smc_level(4000, _fake_smc(), atr_val=5.0))


if __name__ == "__main__":
    unittest.main()
