"""
Unit test untuk fungsi murni di xauusd_ai_analyst.py yang jadi bagian dari
Confluence Score Engine: compute_adx_rising, check_volatility_floor.

xauusd_ai_analyst.py tidak punya efek samping level-modul (beda dengan
app.py yang men-start scheduler saat di-import) jadi bisa langsung
di-import tanpa guard tambahan.

Jalankan dari root project:
    python -m unittest discover tests -v
"""
import sys
import unittest
from pathlib import Path

import numpy as np

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from xauusd_ai_analyst import (  # noqa: E402
    compute_adx_rising, check_volatility_floor, is_momentum_exhausted,
    efficiency_ratio,
)


class AdxRisingTestCase(unittest.TestCase):
    def test_rising_adx_detected(self):
        # ADX naik dari 15 (index -4) ke 25 (index -1) -- momentum menguat.
        arr = np.zeros(50)
        arr[-4] = 15.0
        arr[-1] = 25.0
        self.assertTrue(compute_adx_rising(arr, start_adx=10, lookback=3))

    def test_falling_adx_detected(self):
        # ADX turun dari 35 ke 25 -- momentum melemah walau masih di atas
        # ambang absolut manapun.
        arr = np.zeros(50)
        arr[-4] = 35.0
        arr[-1] = 25.0
        self.assertFalse(compute_adx_rising(arr, start_adx=10, lookback=3))

    def test_permissive_when_history_not_warmed_up(self):
        # start_adx dekat dengan ujung array -- lookback index jatuh
        # sebelum start_adx (zona belum ter-smoothing) -- harus default True.
        arr = np.zeros(15)
        arr[-1] = 25.0
        self.assertTrue(compute_adx_rising(arr, start_adx=12, lookback=3))

    def test_flat_adx_not_rising(self):
        arr = np.zeros(50)
        arr[-4] = 25.0
        arr[-1] = 25.0
        self.assertFalse(compute_adx_rising(arr, start_adx=10, lookback=3))


class VolatilityFloorTestCase(unittest.TestCase):
    def test_low_volatility_detected(self):
        # TR rata-rata 20 periode = 10, ATR sekarang cuma 3 (30%, di bawah
        # floor default 60%) -- market choppy.
        tr_arr = np.full(50, 10.0)
        is_low, avg_tr = check_volatility_floor(atr_val=3.0, tr_arr=tr_arr,
                                                  lookback=20, floor_mult=0.6)
        self.assertTrue(is_low)
        self.assertAlmostEqual(avg_tr, 10.0)

    def test_normal_volatility_not_flagged(self):
        tr_arr = np.full(50, 10.0)
        is_low, _ = check_volatility_floor(atr_val=8.0, tr_arr=tr_arr,
                                            lookback=20, floor_mult=0.6)
        self.assertFalse(is_low)

    def test_exactly_at_floor_not_flagged(self):
        # ATR persis di floor (bukan di bawahnya) -- perbandingan pakai <
        # ketat, jadi tepat di batas tidak dianggap low-volatility.
        tr_arr = np.full(50, 10.0)
        is_low, _ = check_volatility_floor(atr_val=6.0, tr_arr=tr_arr,
                                            lookback=20, floor_mult=0.6)
        self.assertFalse(is_low)

    def test_permissive_when_not_enough_history(self):
        tr_arr = np.full(10, 1.0)  # cuma 10 candle, butuh lookback+5=25
        is_low, avg_tr = check_volatility_floor(atr_val=0.01, tr_arr=tr_arr,
                                                  lookback=20, floor_mult=0.6)
        self.assertFalse(is_low)
        self.assertEqual(avg_tr, 0.0)


class MomentumExhaustedTestCase(unittest.TestCase):
    def test_buy_exhausted_when_overbought_and_adx_falling(self):
        self.assertTrue(is_momentum_exhausted("BUY", rsi_val=80, adx_rising=False))

    def test_buy_not_exhausted_when_overbought_but_adx_rising(self):
        # RSI ekstrem TAPI momentum masih akselerasi -- tren kuat yang wajar,
        # jangan diveto.
        self.assertFalse(is_momentum_exhausted("BUY", rsi_val=80, adx_rising=True))

    def test_buy_not_exhausted_when_rsi_normal(self):
        self.assertFalse(is_momentum_exhausted("BUY", rsi_val=60, adx_rising=False))

    def test_sell_exhausted_when_oversold_and_adx_falling(self):
        self.assertTrue(is_momentum_exhausted("SELL", rsi_val=20, adx_rising=False))

    def test_sell_not_exhausted_when_oversold_but_adx_rising(self):
        self.assertFalse(is_momentum_exhausted("SELL", rsi_val=20, adx_rising=True))

    def test_sell_not_exhausted_when_rsi_normal(self):
        self.assertFalse(is_momentum_exhausted("SELL", rsi_val=40, adx_rising=False))

    def test_custom_thresholds(self):
        self.assertTrue(is_momentum_exhausted("BUY", rsi_val=68, adx_rising=False,
                                               overbought=65, oversold=35))


class EfficiencyRatioTestCase(unittest.TestCase):
    """Kaufman ER — 0 = chop, 1 = tren bersih."""

    def test_perfect_trend_gives_er_one(self):
        # Naik lurus konsisten: perpindahan bersih == total jarak ditempuh.
        s = pd.Series([100 + i for i in range(40)], dtype=float)
        self.assertAlmostEqual(efficiency_ratio(s, 20).iloc[-1], 1.0, places=6)

    def test_pure_chop_gives_er_near_zero(self):
        # Bolak-balik 2 nilai: banyak bergerak, tidak ke mana-mana.
        s = pd.Series([100.0, 101.0] * 20, dtype=float)
        self.assertLess(efficiency_ratio(s, 20).iloc[-1], 0.05)

    def test_transition_regime_lands_between(self):
        # Tren naik yang diselingi retrace -- ER menengah, bukan 0 atau 1.
        vals, price = [], 100.0
        for i in range(60):
            price += 1.0 if i % 3 else -1.6
            vals.append(price)
        er = efficiency_ratio(pd.Series(vals, dtype=float), 20).iloc[-1]
        self.assertGreater(er, 0.0)
        self.assertLess(er, 1.0)

    def test_flat_series_does_not_divide_by_zero(self):
        # volatility = 0 -> tanpa guard replace(0, nan) ini jadi ZeroDivision/inf.
        s = pd.Series([100.0] * 40, dtype=float)
        er = efficiency_ratio(s, 20).iloc[-1]
        self.assertEqual(er, 0.0)

    def test_er_always_within_zero_and_one(self):
        import random
        random.seed(42)
        s = pd.Series([100 + random.uniform(-5, 5) for _ in range(200)], dtype=float)
        series = efficiency_ratio(s, 20)
        self.assertTrue((series >= 0).all() and (series <= 1).all())


if __name__ == "__main__":
    unittest.main()
