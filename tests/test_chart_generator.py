"""
Unit test untuk chart_generator.fetch_ohlcv().

Fokus: volume TIDAK boleh ikut menentukan baris mana yang dibuang. XAU/USD di
Twelve Data kerap tidak punya volume nyata — kolomnya bisa absen, atau ada tapi
berisi null. Sebelum perbaikan, `df.dropna()` polos mengubah null itu jadi NaN
lalu membuang SELURUH baris meski OHLC-nya valid, sehingga chart yang dikirim
ke Vision AI keluar kosong total.

Tidak ada network: urllib.request.urlopen di-patch dengan respons Twelve Data
sintetis, jadi fetch_ohlcv() yang asli benar-benar dijalankan.

Jalankan dari root project:
    python -m unittest discover tests -v
"""
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import chart_generator  # noqa: E402  (sudah set matplotlib Agg sendiri)


class _FakeResponse:
    def __init__(self, payload):
        self._payload = json.dumps(payload).encode()

    def read(self):
        return self._payload


def _twelve_payload(volume_mode: str, bars: int = 5):
    """volume_mode: 'absent' | 'null' | 'real'."""
    values = []
    for i in range(bars):
        row = {
            "datetime": f"2026-08-18 10:{i:02d}:00",
            "open":  f"{4000 + i}",
            "high":  f"{4005 + i}",
            "low":   f"{3995 + i}",
            "close": f"{4002 + i}",
        }
        if volume_mode == "null":
            row["volume"] = None
        elif volume_mode == "real":
            row["volume"] = f"{100 + i}"
        values.append(row)
    return {"values": values}


def _fetch(volume_mode, bars=5):
    with patch.object(chart_generator.urllib.request, "urlopen",
                      return_value=_FakeResponse(_twelve_payload(volume_mode, bars))):
        return chart_generator.fetch_ohlcv("5m", api_key="dummy", outputsize=bars)


class FetchOhlcvVolumeTestCase(unittest.TestCase):

    def test_null_volume_does_not_drop_rows(self):
        """Regresi utama: volume null tidak boleh mengosongkan chart."""
        df = _fetch("null", bars=5)
        self.assertEqual(len(df), 5, "baris OHLC valid ikut terbuang gara-gara volume null")
        self.assertFalse(df["close"].isna().any())

    def test_absent_volume_column_still_works(self):
        df = _fetch("absent", bars=5)
        self.assertEqual(len(df), 5)
        # Kolom volume tidak disintesis — blok gambar volume di
        # generate_chart_b64() memang dijaga `if "volume" in df.columns`.
        self.assertNotIn("volume", df.columns)

    def test_real_volume_preserved(self):
        df = _fetch("real", bars=5)
        self.assertEqual(len(df), 5)
        self.assertIn("volume", df.columns)
        self.assertEqual(df["volume"].iloc[0], 100)

    def test_row_with_broken_ohlc_is_still_dropped(self):
        """Baris yang OHLC-nya rusak TETAP harus dibuang — jangan sampai
        perbaikan ini malah meloloskan data harga yang tidak valid."""
        payload = _twelve_payload("real", bars=4)
        payload["values"][2]["close"] = "bukan-angka"
        with patch.object(chart_generator.urllib.request, "urlopen",
                          return_value=_FakeResponse(payload)):
            df = chart_generator.fetch_ohlcv("5m", api_key="dummy", outputsize=4)
        self.assertEqual(len(df), 3)

    def test_missing_ohlc_columns_raises_clear_error(self):
        payload = {"values": [{"datetime": "2026-08-18 10:00:00", "volume": "100"}]}
        with patch.object(chart_generator.urllib.request, "urlopen",
                          return_value=_FakeResponse(payload)):
            with self.assertRaises(ValueError):
                chart_generator.fetch_ohlcv("5m", api_key="dummy", outputsize=1)


if __name__ == "__main__":
    unittest.main()
