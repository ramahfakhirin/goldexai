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

## TASK 2 (P0) — `/api/public/price` kontrak frontend ✅ SELESAI (cakupan direvisi)

**File diubah:** `app.py`

### Diagnosa (premis brief TIDAK terbukti)

Brief menyatakan JS landing page mengakses `d.change.toFixed(2)`, `d.change_pct`,
`d.timestamp`, `d.candles`, `d.signal_engine` → `TypeError` → badge stuck di
`RECONNECTING...`. Diverifikasi 4 cara, semuanya membantah:

1. **Konsumen sebenarnya** (`templates/landing.html:1408-1423`) hanya memakai
   `data.ok`, `data.price`, `data.source`, `data.time` — persis yang sudah
   dikembalikan endpoint.
2. **Grep seluruh `templates/` + `static/`**: nol kemunculan `change_pct`,
   `.candles`, `signal_engine`, `d.change`. String **`RECONNECTING` tidak ada
   di repo sama sekali.**
3. **Uji endpoint**: HTTP 200, JSON valid, keys `[ok, price, source, time]`.
   Requirement item 7 (`ok:false`, bukan HTTP 500) sudah terpenuhi sejak awal.
4. **Muat landing page**: console bersih tanpa `TypeError`, `RECONNECTING`
   tidak ada di DOM, widget harga berfungsi.

`templates/landing - Copy.html` (backup, nol referensi di `app.py`, tidak pernah
di-render) juga identik.

**Keputusan:** item 2–5 (tambah `change`/`change_pct`/`candles`/`signal_engine`)
dibatalkan atas persetujuan — tidak ada yang membacanya, dan menambah fetch
OHLCV ke endpoint publik tanpa auth justru berlawanan dengan tujuan item 6.

### Masalah nyata yang tetap dikerjakan (item 6 + 7)

`public_price()` lama:

```python
price  = fetch_current_price_server()                           # panggil bridge
source = "MT5 Bridge" if fetch_price_from_bridge() > 0 else ... # panggil bridge LAGI
```

- Endpoint publik tanpa auth, di-poll **tiap 5 detik per pengunjung**.
- Cache internal bridge hanya **3 detik** (`app.py:1064`) → polling 5 detik
  **selalu meleset**, jadi jumlah pengunjung berbanding lurus dengan beban ke
  MT5 Bridge.
- Panggilan bridge ganda yang redundan per request.
- Saat semua sumber mati, `source` tetap tertulis `"Twelve Data"` walau
  `price = 0`.

### Perubahan

| Lokasi | Perubahan |
|---|---|
| `app.py` ~1055 | Tambah `_public_price_cache` + `_PUBLIC_PRICE_TTL = 10`, mengikuti pola `_bridge_price_cache` |
| `app.py` `public_price()` | Cache response 10 detik (hasil gagal ikut di-cache supaya sumber mati tidak memicu badai retry); satu panggilan bridge saja; label `"Offline"` saat semua sumber mati; `try/except` agar tidak pernah HTTP 500 |

Kontrak response **tidak berubah** — tetap `[ok, price, source, time]`.

### Cara verifikasi

```bash
GOLDEX_DISABLE_SCHEDULER_AUTOSTART=1 python -X utf8 -c "import app"   # sukses
```

3 request beruntun dalam <1 detik:

```
all_status_200:       true
keys_unchanged:       ["ok","price","source","time"]
identical_within_ttl: true            ← cache hit terbukti
sample: {ok:false, price:0, source:"Offline", time:"06:31 WIB"}
```

Landing page dimuat ulang: console bersih, tidak ada error server.

Catatan: `ok:false` di lokal wajar — dev tidak punya `MT5_BRIDGE_URL` /
`TWELVE_DATA_KEY`. Di produksi log menunjukkan bridge aktif normal.

---

## TASK 3 (P1) — Regime gate Efficiency Ratio (default OFF) ✅ SELESAI

**File diubah:** `xauusd_ai_analyst.py`, `app.py`, `.env.example`,
`tests/test_signal_engine.py`

**Gate TIDAK diaktifkan** — task ini hanya memasang instrumentasi + toggle.

### Perubahan

| Lokasi | Perubahan |
|---|---|
| `xauusd_ai_analyst.py` | Tambah `efficiency_ratio(s, n=20)` — Kaufman ER |
| `app.py` `init_db()` | `ALTER TABLE trade_monitors ADD COLUMN efficiency_ratio REAL` (pola migrasi yang sudah ada) |
| `app.py` `create_trade_monitor()` | Param baru `efficiency_ratio=None`, ikut di-INSERT |
| `app.py` `run_scheduled_analysis()` | Hitung ER dari `df_m5["close"]` setelah slice closed-candle, sebelum `run_multi_timeframe_scan()`. **Selalu** dihitung + di-cache ke `config.er_cache`, gate-nya terpisah dan default OFF |
| `app.py` `/api/admin/guard_status` | Expose blok `efficiency_ratio` (nilai, period, gate on/off, min/max, `in_transition_zone`) |
| `.env.example` | `ER_GATE_ENABLED=false`, `ER_GATE_PERIOD=20`, `ER_GATE_MIN=0.20`, `ER_GATE_MAX=0.35` |

Catatan implementasi: saat gate aktif dan trip, `_save_wait_ratelimited()`
butuh `market`/`indicators`/`smc` yang normalnya baru dibangun **setelah** MTF
scan. Objek itu dibangun di dalam cabang gate — murni CPU dari `df_m5` yang
sudah di memori (tanpa network), dan tetap jauh lebih murah daripada MTF scan
penuh yang mengulang proses itu untuk M5 + M1 + Mean-Reversion.

### Cara verifikasi

```bash
GOLDEX_DISABLE_SCHEDULER_AUTOSTART=1 python -X utf8 -c "import app"   # sukses
python -X utf8 -m unittest discover tests                              # 45 tests OK
```

Kolom DB terbentuk:
```
efficiency_ratio ada di trade_monitors: True
```

`/api/admin/guard_status` (superadmin):
```json
"efficiency_ratio": {"er": null, "period": 20, "gate_enabled": false,
                     "gate_min": 0.2, "gate_max": 0.35,
                     "in_transition_zone": false}
```
(`er: null` karena scheduler belum jalan di lokal — dev tanpa MT5 Bridge.)

**Checklist "dengan `ER_GATE_ENABLED=false` perilaku identik"** — tabel
keputusan gate (ekspresi persis seperti di `app.py`):

| ER | ENABLED=false | ENABLED=true |
|---|---|---|
| 0.10 | False | False |
| 0.25 | False | **True** |
| 0.35 | False | **True** |
| 0.50 | False | False |
| None | False | False |

Gate tidak pernah trip saat OFF, apa pun nilai ER → alur scheduler tidak
berubah. Satu-satunya tambahan kerja adalah menghitung ER + satu `_cfg_set`.

### Data awal untuk keputusan aktivasi nanti

ER pada 13.799 candle M5 nyata (GC=F): `min=0.001 max=0.969 median=0.197`.
**27,0% candle berada di zona transisi 0.20–0.35.** Artinya kalau gate
dinyalakan, sekitar seperempat kesempatan scan akan dilewati — dampaknya
besar, jadi jangan diaktifkan sebelum ada bukti dari kolom
`trade_monitors.efficiency_ratio` bahwa proporsi `SL_HIT` di rentang itu
memang lebih tinggi daripada trade yang menang.

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
