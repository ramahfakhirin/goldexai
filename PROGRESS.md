# PROGRESS — GOLDEX AI

Catatan kerja per task. Satu task = satu commit.

---

## TASK 1 (P0) — Fallback ADX terisi nilai ATR ✅ SELESAI

**File diubah:** `app.py`, `static/js/app.js`

### Diagnosa (hipotesis awal TIDAK terbukti)

Hipotesis di brief: `detect_berkah_signal()` tidak mengembalikan `adx`, jadi ATR
masuk diam-diam sebagai ADX dan seluruh sistem selama ini salah.

**Hasil pembacaan + verifikasi runtime: tidak demikian.**

`detect_berkah_signal()` punya 5 jalur return. Yang tidak membawa `adx` ada 4,
dan **semuanya `signal: "WAIT"`**:

| Baris (xauusd_ai_analyst.py) | Kondisi | signal | ada `adx`? |
|---|---|---|---|
| 931 | Data tidak cukup | WAIT | ❌ |
| 964 | HTF ranging / tidak tersedia | WAIT | ❌ |
| 985 | OVEREXTENDED | WAIT | ❌ |
| 1054 | LOW_VOLATILITY | WAIT | ❌ |
| **1324** | jalur normal (BUY/SELL/WAIT berskor) | semua | ✅ ADX Wilder-RMA asli |

`detect_mean_reversion_signal()` (baris 1549) mengembalikan `"adx": 0.0`
eksplisit — by design, karena setup ranging tidak mengukur kekuatan trend.

Di `run_scheduled_analysis()`, `if sig == "WAIT": return None` mengeksekusi
**tepat setelah** blok `setdefault` — sebelum `adx` dibaca siapa pun. Jadi
satu-satunya jalur yang memicu fallback (WAIT) tidak pernah meneruskan nilai
ATR ke Telegram/dashboard.

Verifikasi runtime (3000 candle, engine asli, sampling tiap 7 bar):

```
signal counts: {'BUY': 78, 'SELL': 0, 'WAIT': 308}
BUY/SELL signals MISSING adx key: 0
WAIT results missing adx key: 308
adx on BUY/SELL -> min=9.72 max=50.18 mean=29.98 n=78
```

Rentang 9.72–50.18 = skala ADX (0–100), bukan skala ATR. **Angka ADX yang
selama ini tampil ke user asli, tidak pernah tertukar ATR.** Fallback lama =
jebakan laten, bukan bug aktif.

### Bug NYATA yang ditemukan (lokasi berbeda dari brief)

1. **`app.py:1634` — RSI dicetak berlabel ADX** (aktif, user-facing).
   `f"ADX {indicators.rsi_14:.0f} — momentum belum cukup kuat"` di
   `humanize_reason()` dalam `_save_wait_ratelimited()`. RSI & ADX sama-sama
   berskala 0–100 jadi angkanya tidak pernah terlihat janggal. ADX tidak
   tersedia di scope itu (dihitung di dalam `detect_berkah_signal()`, bukan
   `calculate_indicators()`), jadi angkanya dihapus.

2. **Mean-Reversion mencetak `ADX 0.0` seolah pengukuran nyata** (aktif,
   user-facing). Narasi jadi kontradiktif: *"ADX 0.0 menandakan momentum trend
   kuat"* — masuk ke pesan Telegram. Ini justru kasus yang persis dituju
   `adx_available`.

### Perubahan

| Lokasi | Perubahan |
|---|---|
| `app.py` ~1967 | Fallback `indicators.atr_14` → `0.0`, ditambah `berkah["adx_available"]` dihitung dari nilai asli **sebelum** setdefault |
| `app.py` ~1634 | Hapus angka RSI yang dilabeli ADX |
| `app.py` narasi BUY/SELL (ID+EN) | Klausa ADX jadi kondisional: angka kalau `adx_available`, selain itu `"ADX n/a — setup ini tidak mengukur kekuatan trend"` |
| `app.py` `method_confluence.rsi_momentum` | Hapus duplikat fallback ATR-as-ADX, jadi `"ADX n/a"` saat tidak tersedia |
| `app.py` `market_structure.price_position` | `ADX=n/a` saat tidak tersedia |
| `static/js/app.js` ~2686 | Guard eksplisit `adx_available === false`, tetap kompatibel dengan sinyal lama di DB yang belum punya flag ini |

Catatan: UI tetap memakai `'--'` (konvensi yang sudah dipakai di file itu),
bukan diganti `'n/a'` — sama-sama tidak menampilkan angka palsu, dan menghindari
churn kosmetik.

### Cara verifikasi

```bash
GOLDEX_DISABLE_SCHEDULER_AUTOSTART=1 python -X utf8 -c "import app"   # sukses
python -X utf8 -m unittest discover tests                              # 40 tests OK
```

Simulasi logika `adx_available` (4 kasus):

| Kasus | adx | available | tampil |
|---|---|---|---|
| BUY normal | 29.98 | True | 30.0 |
| Mean-Reversion | 0.00 | False | n/a |
| WAIT early-return (key hilang) | 0.00 | False | n/a |
| ADX negatif/aneh | -1.00 | False | n/a |

---

## Findings (di luar scope — belum diperbaiki)

### F1 — `setdefault` lain di `run_scheduled_analysis()` (~1967–1976)

| setdefault | Penilaian |
|---|---|
| `sl` → `0.0` | **Paling berisiko**, tapi sudah ternetralisir: guard `if not active_monitor and berkah.get("sl") and berkah.get("entry")` — `0.0` falsy, jadi `create_trade_monitor()` tidak pernah dipanggil dengan SL kosong. Aman secara kebetulan, bukan by design. Kalau guard itu suatu saat diubah, SL=0 bisa lolos. |
| `tp2`/`tp3` → `berkah.get("tp", 0)` | Hanya bisa kena jalur 931 (yang juga tidak punya `tp`) → jadi 0. Tetap WAIT, tidak propagate. |
| `entry` → `market.current_price` | Wajar. |
| `lot_size` → `0.01`, `rrr` → `"1:1"` | Kosmetik. |

### F2 — Penamaan `method_confluence.rsi_momentum` menyimpan string ADX

Key bernama `rsi_momentum` tapi isinya `"ADX xx.x"`. Dibaca frontend apa adanya
(`static/js/app.js:2613`). Tidak diubah supaya tidak memutus kontrak UI, tapi
membingungkan saat dibaca.

### F3 — `Indicators` dataclass tidak punya field ADX

ADX hanya hidup di dalam `detect_berkah_signal()`. Akibatnya konsumen di luar
fungsi itu (mis. `_save_wait_ratelimited()`) tidak punya akses ke ADX sama
sekali — sumber bug #1 di atas. Kalau ADX perlu ditampilkan di jalur WAIT,
perlu dinaikkan ke `Indicators` atau di-pass eksplisit.
