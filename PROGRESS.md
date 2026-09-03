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

## TASK 4 — Audit (TANPA perubahan kode) ✅ SELESAI

Tidak ada file kode yang diubah untuk task ini.

### 1. Martingale

**(a) Kapan `get_martingale_multiplier()` > 1?**
(`xauusd_ai_analyst.py:791`) Query 20 trade `status='CLOSED'` terbaru, lalu
iterasi dari yang **paling baru ke lama**: tiap `SL_HIT` mengalikan 2, dan
berhenti (`break`) begitu ketemu `TP1_HIT`/`TP2_HIT`/`TP3_HIT`/`BE_HIT`.
Jadi multiplier = `2^n`, dengan n = **jumlah SL_HIT beruntun paling baru**.

⚠️ **Catatan penting:** outcome di luar 6 nilai itu (mis. `NULL`, atau
`EARLY_BE_MOVE` bila suatu saat tersimpan berstatus CLOSED) tidak
menggandakan **maupun** menghentikan loop — outcome itu **dilewati diam-diam**,
sehingga rentetan SL bisa "melompati" trade penyela. Saat ini `EARLY_BE_MOVE`
membiarkan status tetap `ACTIVE` jadi belum kena, tapi ini bergantung pada
detail implementasi lain, bukan dijaga eksplisit.

**(b) Nilai maksimum:** dibatasi `MAX_MARTINGALE_MULT` (default **4**). Jadi
1 SL → 2x, 2 SL → 4x, 3+ SL → tetap 4x. Tanpa cap ini 5 SL beruntun = 32x lot.

**(c) Apakah `/performance` mencampur lot berbeda tanpa keterangan? → YA.**

Backend sudah menyediakan flag: `get_performance_stats()` mengembalikan
`has_martingale` (`app.py:716`) dan `lot_size`.

| Halaman | Menampilkan keterangan? |
|---|---|
| Dashboard (`index.html` + `app.js:1580`) | ✅ Ya — label berubah jadi `(basis 0.10 lot + Martingale)` |
| **`/performance` (`performance.html`)** | ❌ **Tidak** — nol kemunculan `has_martingale`, `lot_size`, maupun elemen `lot-note` |

Jadi halaman `/performance` — justru halaman yang paling dituju untuk menilai
performa — menampilkan Total PnL hasil penjumlahan trade dengan lot efektif
berbeda-beda **tanpa penanda apa pun**. Angka PnL-nya sendiri benar (backend
sudah mengalikan `martingale_mult` per trade lewat `_money()`), yang hilang
adalah keterangannya.

### 2. Sumber spread

**Tidak ada data spread sama sekali di sistem.**

- `fetch_ohlcv_from_bridge()` (`app.py:1147`) menyaring kolom menjadi persis
  `["open","high","low","close","volume"]` — kalau bridge mengirim spread pun,
  kolomnya dibuang di titik ini.
- `fetch_price_from_bridge()` (`app.py:1103`) hanya membaca `data["price"]` —
  satu harga tunggal, tanpa bid/ask.
- Satu-satunya kemunculan kata "spread" di seluruh backend adalah **4 string
  narasi** (`app.py:2148/2153/2183/2188`): *"Hindari entry jika spread > X
  poin"* — itu imbauan tekstual ke user, bukan gate.

**Konsekuensi:** tidak ada gate biaya sama sekali. SL/TP dihitung murni dari
ATR + level SMC, tanpa kesadaran biaya transaksi. Untuk scalping M1/M5 dengan
SL kerap hanya beberapa poin, spread riil (terutama saat pergantian sesi
London/NY) bisa memakan porsi besar dari edge — dan sistem tidak bisa
melihatnya, apalagi menolak entry karenanya.

### 3. Jalur Twelve Data — kolom volume

**Apakah DataFrame-nya punya kolom volume?** Ya, tapi **disintesis**, bukan
data asli:
- `app.py:1232` — `df["volume"] = df.get("volume", 0)` → 0 kalau tidak ada.
- `xauusd_ai_analyst.py:155-158` — kalau kolom tidak ada, `df["volume"] = 0.0`.

Twelve Data memang umumnya tidak menyediakan volume untuk forex/XAU.

**Indikator mana yang diam-diam berubah perilaku? → TIDAK ADA.**

Diverifikasi dengan menghitung kemunculan `volume` di dalam tiap fungsi:
`calculate_indicators` = 0, `detect_berkah_signal` = 0, `detect_smc_structure`
= 0. Seluruh indikator (EMA, RSI, MACD, ATR, Bollinger, Stochastic, Heiken
Ashi) dan seluruh logika sinyal murni berbasis OHLC. Jadi volume=0 **tidak
mengubah satu pun keputusan sinyal**.

⚠️ **Tapi ada dampak lain yang tidak terduga — pada Vision AI:**

`chart_generator.py:170` menyusun layout chart sebagai *main chart (70%) +
**volume (15%)** + info panel (15%)*, dan baris 308–314 menggambar bar volume.
`generate_chart_b64()` mengambil datanya lewat `fetch_ohlcv(timeframe,
api_key, ...)` yang sumbernya **Twelve Data** (bukan bridge) — dipanggil dengan
`api_key = twelve_key`.

Artinya chart yang dikirim ke Vision AI kemungkinan besar **selalu** punya
panel volume kosong/rata, memakan 15% area gambar tanpa informasi. Vision AI
menilai gambar itu untuk memutuskan VALID/SKIP.

⚠️ **Risiko lebih serius (perlu dikonfirmasi dengan API key asli):**
`chart_generator.py:104` memanggil `df.dropna()` **tanpa `subset`**. Kalau
Twelve Data mengirim kolom `volume` berisi `null` (bukan tidak mengirim sama
sekali), `pd.to_numeric(..., errors="coerce")` mengubahnya jadi `NaN`, lalu
`dropna()` akan membuang **seluruh baris** → chart kosong total.

Bandingkan dengan `xauusd_ai_analyst.py:160` yang sudah defensif:
`.dropna(subset=["open","high","low","close"])` — sengaja mengecualikan volume.
Kedua jalur menangani hal yang sama dengan cara berbeda, dan jalur chart adalah
yang rapuh. Belum bisa saya uji di lokal (tidak ada `TWELVE_DATA_KEY`).

---

## FOLLOW-UP — Disclosure lot di `/performance` ✅ SELESAI

Menindaklanjuti temuan Task 4 item 1(c).

**File diubah:** `templates/performance.html`

### Masalah

`/performance` menampilkan Total PnL hasil penjumlahan trade dengan lot efektif
berbeda (begitu Martingale pernah aktif) **tanpa penanda apa pun**. Angkanya
benar — backend sudah mengalikan `martingale_mult` per trade lewat `_money()` —
tapi pembaca wajar mengira semua trade memakai basis lot yang sama.

Dashboard sudah punya penanda ini (`static/js/app.js:1580`), `/performance`
tidak — padahal justru halaman itu yang paling dibaca sebagai ringkasan performa.

### Perubahan

| Lokasi | Perubahan |
|---|---|
| CSS scoped | `.pp-hero-lbl .lot-note { text-transform: none; }` — `.lot-note` dari `style.css` mewarisi `uppercase` dari `.pp-hero-lbl` |
| Tile Total PnL | Tambah `<span class="lot-note" id="pp-lot-note">` |
| `ppRenderPerf()` | Isi dari `p.lot_size` + `p.has_martingale`, pola label disamakan dengan dashboard |

Tidak ada perubahan backend — `/api/performance` sudah mengirim `lot_size` dan
`has_martingale` (termasuk saat nol trade).

### Cara verifikasi

Diuji dua skenario dengan data sintetis, lalu dibersihkan:

| Skenario | Data | Label tampil | Total PnL |
|---|---|---|---|
| A — semua lot basis | 3 trade, `martingale_mult=1` | `Total PnL (0.10 lot)` | `+$600.00` |
| B — ada Martingale | +1 trade `martingale_mult=2` | `Total PnL (basis 0.10 lot + Martingale)` | `+$2200.00` |

Selisihnya sendiri membuktikan kenapa penanda ini perlu: trade keempat
menyumbang 80 poin × $10 × **2** = $1600 — tanpa keterangan, pembaca akan
menghitung $2200 itu terhadap basis 0.10 lot dan salah menyimpulkan.

Cek tampilan: `text-transform` ternormalisasi (`none`), ukuran 8px, dan di
viewport mobile 375px label membungkus di dalam tile (`scrollWidth` 126 <
`clientWidth` 166) tanpa overflow horizontal pada body.

45 test lulus, tidak ada error server.

---

## FOLLOW-UP — `df.dropna()` di chart generator ✅ SELESAI

Menindaklanjuti temuan Task 4 item 3.

**File diubah:** `chart_generator.py`, `tests/test_chart_generator.py` (baru)

### Masalah — terkonfirmasi, bukan lagi dugaan

`chart_generator.py:104` memanggil `df.dropna()` **tanpa `subset`**, padahal
baris 100–102 sudah meng-`coerce` kolom `volume` jadi numerik. XAU/USD di
Twelve Data kerap tidak punya volume nyata — kalau kolomnya **ada tapi berisi
`null`**, hasil coerce jadi `NaN`, lalu `dropna()` polos membuang **seluruh
baris** meski OHLC-nya valid.

Dampaknya bukan kosmetik: `generate_chart_b64()` adalah sumber gambar yang
dinilai Vision AI (jalur rescue maupun veto). Chart kosong = Vision menilai
gambar tanpa data.

Dibuktikan dengan menjalankan `fetch_ohlcv()` asli terhadap respons Twelve Data
sintetis berisi `volume: null`, memakai kode **sebelum** perbaikan:

```
AssertionError: 0 != 5 : baris OHLC valid ikut terbuang gara-gara volume null
```

Nol dari lima baris bertahan — chart benar-benar kosong total.

### Perubahan

`dropna()` dibatasi ke kolom OHLC saja, menyamakan dengan pola defensif yang
sudah dipakai jalur analyst (`xauusd_ai_analyst.py:160`):

```python
ohlc_cols = [c for c in ("open", "high", "low", "close") if c in df.columns]
if not ohlc_cols:
    raise ValueError("Twelve Data tidak mengirim kolom OHLC")
return df.dropna(subset=ohlc_cols)
```

Sengaja **tidak** menyintesis kolom `volume` saat absen — blok gambar volume di
`generate_chart_b64()` sudah dijaga `if "volume" in df.columns`, jadi menambah
kolom nol justru mengubah tampilan (panel bergaris & berlabel, bukan kosong).
Perbaikan ini murni menghentikan pembuangan baris, tanpa efek visual lain.

### Cara verifikasi

`tests/test_chart_generator.py` (5 test, tanpa network — `urlopen` di-patch
dengan respons sintetis, `fetch_ohlcv()` asli tetap dijalankan):

| Test | Menjaga |
|---|---|
| `test_null_volume_does_not_drop_rows` | Regresi utama — 5 baris bertahan |
| `test_absent_volume_column_still_works` | Kolom absen tetap jalan, tidak disintesis |
| `test_real_volume_preserved` | Volume asli tidak rusak |
| `test_row_with_broken_ohlc_is_still_dropped` | Perbaikan **tidak** meloloskan harga tidak valid |
| `test_missing_ohlc_columns_raises_clear_error` | Error jelas, bukan diam-diam kosong |

Diverifikasi bahwa test ini benar-benar menangkap bug: dijalankan terhadap kode
lama → **gagal** (`0 != 5`); terhadap kode baru → lulus.

Total 50 test lulus. `import app` & `import chart_generator` sukses.

---

## FOLLOW-UP — Bridge MT5 mengirim M5 untuk permintaan M1 ✅ SELESAI

**File diubah:** `xauusd_ai_analyst.py`, `.env.example`
**Di luar repo:** `C:\mt5_bridge\mt5_bridge_fixed.py` di VPS (diperbaiki manual)

### Temuan

Selama ~2 bulan, `run_multi_timeframe_scan()` **tidak pernah** benar-benar
menganalisis M1. Bridge MT5 mengembalikan candle **M5** untuk permintaan
`timeframe=1m`.

Penyebab di `mt5_bridge.py` (VPS):

```python
timeframe_map = { "5m": ..., "15m": ..., "1h": ..., "4h": ..., "1d": ... }
tf = timeframe_map.get(tf_str, mt5.TIMEFRAME_M5)   # "1m" TIDAK ADA -> default M5
```

Tak terlihat selama itu karena dua hal: **fallback diam** (timeframe tak dikenal
dilayani sebagai M5, bukan ditolak) dan response tetap menulis
`"timeframe": "1m"` walau isinya M5. Label benar, data salah.

### Dampak ke mesin sinyal

"M5 vs M1" sebenarnya **satu dataset yang sama dinilai dua kali**. Bedanya cuma
parameter:

| Parameter | "M5" | "M1" |
|---|---|---|
| `adx_threshold` | 22 | **18** (lebih longgar) |
| `liquidity_lookback` | 5 | 3 |
| `htf_agg_factor` | 12 | 15 |

Diukur pada 4000 candle dengan data identik:

```
m1_only  : 44     <- sinyal yang HANYA lolos karena ambang lebih longgar
m5_only  :  4
keduanya : 285
Dimenangkan param M1: 112 dari 333 (34%)
```

Jadi 34% sinyal produksi ditentukan set parameter yang lebih longgar — pada
**ADX**, faktor paling prediktif dari analisa korelasi (win rate 58% saat
`adx_ok` true vs 41% saat false). Bukan konfluensi multi-timeframe, melainkan
pelonggaran ambang yang menyamar sebagai konfirmasi kedua.

Efek samping: dedup candle memakai ID candle "M1" yang sebenarnya M5, sehingga
**4 dari 5 tick scheduler langsung skip** — cadence efektif 5 menit, bukan 60
detik seperti `ANALYSIS_INTERVAL_SEC`.

### Yang dikerjakan di VPS

Ditemukan **dua bridge berjalan bersamaan** dan sama-sama bind ke port 8765
(Windows mengizinkan tanpa `SO_EXCLUSIVEADDRUSE`), sehingga siapa yang melayani
tidak dapat diprediksi:

- `mt5_bridge.py` (18 Jun) — peta timeframe tanpa `"1m"`
- `mt5_bridge_fixed.py` (22 Jun) — peta sudah benar, **tapi tidak pernah
  dijalankan**; loop update-nya hanya mengambil 200 candle padahal GOLDEX minta
  500 (EMA200 mustahil dihitung → `safe_val()` mengembalikan 0.0)

Diselesaikan dengan: menambahkan `"1m"` + menolak timeframe tak dikenal di
`mt5_bridge.py`, memperbaiki 200→500 di `mt5_bridge_fixed.py`, mematikan semua
proses, lalu menjalankan **hanya** `mt5_bridge_fixed.py`.

Verifikasi setelah perbaikan:

```
ohlcv_cache : {'1h': 500, '1m': 500, '5m': 500}
1m  jumlah=500  selisih=[1, 1, 1, 1, 1]      OK
5m  jumlah=500  selisih=[5, 5, 5, 5, 5]      OK
1h  jumlah=500  selisih=[60,60,60,60,60]     OK
```

### Perubahan di repo — kill-switch

Lapisan M1 kini memproses M1 asli untuk **pertama kalinya** dan belum tercakup
backtest mana pun (Yahoo hanya menyediakan M1 7 hari). Ditambahkan
`MTF_ENABLE_M1` (default `true`) di `run_multi_timeframe_scan()` supaya lapisan
itu bisa dimatikan lewat env var **tanpa perlu merusak bridge lagi**.

Diverifikasi pada data nyata:

```
MTF_ENABLE_M1=true  -> 📊 M1 → WAIT | score=0/7 | OVEREXTENDED   (scan jalan normal)
MTF_ENABLE_M1=false -> ⏸  M1 → dinonaktifkan (MTF_ENABLE_M1=false)
```

### Kondisi akhir VPS (20 Agu 2026)

Sebelumnya ada **dua bridge berjalan bersamaan**, dan sebuah Scheduled Task
bernama `Bridge` yang memanggil versi lama — sehingga reboot akan mengembalikan
bug ini tanpa ada yang menyadari.

`Set-ScheduledTask` menolak diubah (`0x8007052e` — task menyimpan kredensial
user). Alih-alih memaksa lewat password, **nama file yang ditukar**: kode v2
diberi nama kanonik `mt5_bridge.py`, sehingga task tidak perlu disentuh sama
sekali.

Kondisi sekarang di `C:\mt5_bridge\`:

| Item | Isi |
|---|---|
| `mt5_bridge.py` | **kode v2 aktif** — Waitress 8 threads, cache OHLCV, `TIMEFRAME_M1` benar, fetch 500 candle |
| `jalankan_bridge.bat` | untuk menjalankan manual, menunjuk `mt5_bridge.py` |
| `_archive/` | semua versi lama & backup (`mt5_bridge_v1_lama.py`, dll) |
| Scheduled Task `Bridge` | `python.exe mt5_bridge.py`, WorkingDirectory `C:\mt5_bridge` |

Jalur auto-start **sudah diuji**, bukan hanya dikonfigurasi: semua proses
dimatikan, task dijalankan, hasilnya tepat satu proses `mt5_bridge.py` dan
verifikasi dari Coolify tetap lulus (`ohlcv_cache` muncul,
`1m selisih=[1,1,1,1,1]`, 500 candle).

### Yang perlu dipantau

Cadence scan naik dari 5 menit ke **1 menit**, dan seleksi sinyal berubah
karena M1 kini benar-benar independen dari M5. Butuh beberapa hari data
sebelum bisa dinilai. Kolom `trade_monitors.efficiency_ratio` ikut merekam
rezim baru ini.

Analisa korelasi faktor sebelumnya (`f_adx_ok` 58% vs 41%, dst) berbasis
backtest M5-only. Dengan M1 asli, komposisi sinyal berubah — analisa itu perlu
diulang memakai data production, bukan diwarisi begitu saja.

---

## KOREKSI — Task 4 item 2 (sumber spread)

Audit Task 4 menyimpulkan *"tidak ada data spread sama sekali di sistem"* dan
menyarankan perubahan di sisi VPS lebih dulu. **Itu keliru.**

Yang benar: `/ohlcv` memang tidak membawa spread, tapi endpoint **`/price`
sudah mengirimkannya sejak awal** — di kedua versi bridge:

```python
mid    = round((tick.bid + tick.ask) / 2, 2)
spread = round((tick.ask - tick.bid) * 10, 1)
...
"bid": ..., "ask": ..., "spread": ...
```

Kekeliruan saya: diagnostik hanya memeriksa kolom `/ohlcv`, lalu digeneralisir
ke seluruh bridge.

**Konsekuensi:** gate spread bisa dibangun **murni di sisi aplikasi** — tidak
perlu menyentuh VPS. Yang kurang ada di `app.py:1103`
(`fetch_price_from_bridge`), yang hanya membaca `data["price"]` dan membuang
`bid`/`ask`/`spread`.

---

## FOLLOW-UP — Instrumentasi pendapat M1 saat entry ✅ SELESAI

**File diubah:** `app.py`, `tests/test_guards.py`
**Perilaku sinyal: TIDAK berubah sama sekali.** Murni pencatatan.

### Kenapa

Log produksi pertama setelah bridge diperbaiki (20 Agu 2026, 19 scan berturut)
menunjukkan M1 dan M5 kini benar-benar berbeda pendapat:

| | Hasil |
|---|---|
| M1 setuju (BUY) | 4 dari 19 (21%) |
| M1 berbeda | 15 dari 19 (79%) |
| `BEST` dari M5 | **19 dari 19** |

Dulu M1 menang 34% lewat ambang ADX longgar; kini tidak pernah menang.

Yang menarik: 6 scan terakhir M1 menandai **OVEREXTENDED** (harga terlalu jauh
dari EMA21) sementara M5 tetap `BUY 5/7 HIGH_CONFIDENCE`. Peringatan itu
**dibuang** — `run_multi_timeframe_scan` memfilter habis `WAIT` sebelum
`max()` (`xauusd_ai_analyst.py:1974`), jadi M1 yang berkata "jangan" tidak
punya suara.

Selama M1 palsu, itu tidak merugikan. Sekarang berarti — apalagi konteksnya
HTF terkunci BULL 15,6 hari dan 4 dari 6 BUY terakhir kena SL (loss-streak
guard aktif memblokir). Dugaan yang masuk akal: entry terlalu telat. Tapi itu
tetap **dugaan**.

### Yang ditambahkan

| Lokasi | Perubahan |
|---|---|
| `init_db()` | 3 kolom: `m1_signal`, `m1_score`, `m1_confidence` |
| `create_trade_monitor()` | 3 param opsional, ikut di-INSERT |
| `run_scheduled_analysis()` | Isi dari `mtf["m1"]` saat trade dibuat |
| `get_m1_agreement_stats()` | Bandingkan hasil trade: M1 setuju vs menolak |
| `/api/admin/guard_status` | Expose blok `m1_agreement` |

Trade lama (`m1_signal` NULL) dipisah ke `belum_terekam` supaya tidak
mencemari perbandingan.

### Pertanyaan yang akan dijawab datanya

> Dari trade yang kena SL, berapa persen lahir saat M1 sedang
> WAIT/OVEREXTENDED?

Angka kuncinya `sl_rate` di kedua kelompok. Kalau kelompok "M1 menolak" jauh
lebih tinggi, menjadikan M1 sebagai **veto** (bukan sekadar kandidat) punya
dasar empiris. Kalau tidak, idenya gugur — persis seperti ADX-rising yang
terlihat masuk akal tapi terbukti merugikan saat diuji A/B.

`alasan_m1_menolak` merinci OVEREXTENDED vs LOW_VOLATILITY vs WAIT biasa,
supaya kalau ternyata ada sinyal, kita tahu jenis penolakan mana yang berarti.

### Cara verifikasi

```bash
GOLDEX_DISABLE_SCHEDULER_AUTOSTART=1 python -X utf8 -c "import app"   # sukses
python -X utf8 -m unittest discover tests                              # 54 tests OK
```

Kolom terbentuk: `['m1_signal', 'm1_score', 'm1_confidence']`

End-to-end (skenario persis dari log — M5 BUY sementara M1 OVEREXTENDED):
```
tersimpan: {'timeframe': 'M5', 'm1_signal': 'WAIT', 'm1_score': 0,
            'm1_confidence': 'OVEREXTENDED', 'efficiency_ratio': 0.31}
```

`/api/admin/guard_status` mengembalikan blok `m1_agreement` (nol karena DB
lokal kosong). Tidak ada error server.

---

## FOLLOW-UP — Instrumentasi spread ✅ SELESAI

**File diubah:** `app.py`, `tests/test_guards.py`
**Perilaku: TIDAK berubah.** Murni pencatatan.

### Konteks: hipotesis martingale terbantah

Produksi terasa memburuk (7D: PF 1,08; 24H: PF 0,82), dugaan awal saya
martingale-lah yang memakan edge. **Salah** — query produksi membantahnya:

```
total trade        : 178
PF apa adanya      : 1.315   PnL +2621.60
PF andai semua 1x  : 1.205   PnL +1066.90
sebaran lot        : {1.0: 125, 2.0: 30, 4.0: 23}
  lot 1.0x: 125 trade,  49 SL (39%), PnL +1326.40
  lot 2.0x:  30 trade,  16 SL (53%), PnL -2333.20
  lot 4.0x:  23 trade,   8 SL (35%), PnL +3628.40
```

Martingale justru **melipatgandakan** PnL. Temuan yang lebih penting:

| | Trade | PF |
|---|---|---|
| Backtest (70 hari) | 177 | 1,38 |
| Produksi (sepanjang waktu) | 178 | **1,315** |

Sampel setara, PF hampir sama — **tidak ada kebocoran sistemik**. Yang terasa
"parah" adalah jendela pendek (7D/24H), ciri khas variance. PF 0,82 dari 8
trade tidak bermakna apa pun.

⚠️ Catatan risiko: seluruh keunggulan martingale berasal dari **23 trade** di
lot 4x (+$3.628) — 13% trade menghasilkan 138% profit pada leverage 4x. Itu
konsentrasi variance, bukan edge terbukti. Tier 2x justru berdarah (−$2.333,
SL rate 53%).

### Kenapa spread

Satu-satunya biaya yang **belum pernah diukur sama sekali**. Backtest
berasumsi nol; produksi membayarnya tiap entry. Dengan SL kerap hanya ~10
poin, spread 2–3 poin = 20–30% risiko habis sebelum harga bergerak.

Data-nya sebenarnya sudah tersedia sejak awal — `/price` di bridge mengirim
`bid`/`ask`/`spread`, tapi `fetch_price_from_bridge()` hanya mengambil
`price` dan membuang sisanya (lihat koreksi audit Task 4).

### Yang ditambahkan

| Lokasi | Perubahan |
|---|---|
| `_bridge_price_cache` | Simpan `bid`/`ask` (sebelumnya dibuang) |
| `get_bridge_spread()` | Spread dalam **satuan harga** (`ask - bid`) |
| `init_db()` | Kolom `entry_spread REAL` |
| `create_trade_monitor()` | Param `entry_spread`, ikut di-INSERT |
| `run_scheduled_analysis()` | Isi dari `get_bridge_spread()` saat entry |
| `get_spread_stats()` | Spread vs jarak SL, estimasi biaya, belah median |
| `/api/admin/guard_status` | Blok `spread` + `spread_sekarang` |

⚠️ **Jebakan satuan yang dihindari:** field `spread` bawaan bridge sudah
dikali 10 (`round((ask-bid)*10, 1)`, komentarnya "dalam pips/10"), jadi
**tidak sebanding** dengan jarak SL. `get_bridge_spread()` menghitung
`ask - bid` sendiri supaya satuannya sama persis dengan harga dan SL.
Diverifikasi: bid 4499.85 / ask 4500.15 → **0.3**, bukan 3.0.

### Cara membacanya

Angka kuncinya `spread_pct_of_sl` — rata-rata spread dibagi jarak SL.
`estimasi_biaya_usd` mengalikannya ke lot efektif (termasuk martingale)
supaya langsung sebanding dengan `gross_profit`. `per_kelompok` membelah di
median untuk melihat apakah trade ber-spread lebar lebih sering kena SL.

Trade tanpa data spread (bridge sedang fallback ke Twelve Data) masuk
`belum_terekam`, **bukan** dihitung nol — kalau dianggap nol, rata-ratanya
turun palsu.

### Cara verifikasi

```bash
GOLDEX_DISABLE_SCHEDULER_AUTOSTART=1 python -X utf8 -c "import app"   # sukses
python -X utf8 -m unittest discover tests                              # 59 tests OK
```

```
spread tanpa bridge : None          (bukan 0.0, bukan crash)
spread dari bid/ask : 0.3           (bukan 3.0 — satuan benar)
tersimpan           : {'entry_spread': 0.3, 'm1_confidence': 'OVEREXTENDED'}
```

`/api/admin/guard_status` mengembalikan blok `spread`. Tidak ada error server.

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

### F4 — `src/db_bridge.py` menyimpan salinan mati `is_direction_blocked()` versi lama

`src/db_bridge.py:485` masih memakai logika guard **beruntun** yang lama
(`LOSS_STREAK_COUNT=2`, `any(r["outcome"] != "SL_HIT")`), sedangkan produksi di
`app.py:1055` sudah pakai rolling window 3-dari-6.

Tidak berbahaya sekarang: `grep -rn "db_bridge" --include=*.py .` tidak
menemukan satu pun importer — file ini tidak dipakai siapa pun. Dicatat karena
salinan guard yang berbeda-beda adalah jebakan kalau suatu saat file ini
dihidupkan lagi, dan karena orang yang membacanya bisa mengira itu perilaku
produksi. Tidak diperbaiki (di luar scope permintaan).

---

## Catatan: angka backtest di dokumen ini

Semua angka backtest yang tercatat di atas (win rate, profit factor, jumlah
trade) dihasilkan `backtest_berkah.py` **sebelum** guard-nya diselaraskan ke
rolling window pada 2026-08-29. Harness lama memakai guard beruntun 2x SL,
yang memblokir lebih jarang daripada produksi — jadi angka-angka lama itu
sedikit lebih optimistis dan **tidak bisa dibandingkan langsung** dengan hasil
run setelah tanggal tersebut. Angka lama tetap dibiarkan apa adanya sebagai
catatan historis pengukuran saat itu.

### Baseline setelah guard diselaraskan (2026-08-29)

Run penuh `backtest_berkah.py` dengan guard rolling-window, periode dan data
sama seperti run terakhir bergaya lama:

| | Guard lama (beruntun 2x) | Guard baru (3 dari 6) |
|---|---|---|
| Trade | 184 | 185 |
| Win rate | 55,6% | **54,9%** |
| Profit factor | 1,387 | **1,35** |
| PnL (0.1 lot) | +$2.417 | +$2.249 |

Selisih PF −0,037. Perlu dicatat: itu **lebih kecil dari noise floor** yang
sudah terukur di sesi ini (menggeser jendela data satu hari saja menggerakkan
PF 1,38 -> 1,25, yaitu 0,13). Jadi cacat guard ini nyata dan layak diperbaiki
demi kebenaran harness, tapi dampak numeriknya tidak cukup besar untuk
membatalkan kesimpulan mana pun yang sudah diambil.

Lebih penting lagi: semua eksperimen A/B di sesi ini menjalankan arm BASE dan
arm varian dengan guard yang **sama**, jadi biasnya sebagian besar saling
menghapus di selisihnya. Yang terpengaruh adalah level absolutnya, bukan
perbandingan antar-varian.

---

## Vision Shadow Mode — instrumentasi screening AI (2026-09-01)

**Permintaan:** bisakah AI membantu screening setelah semua teknikal konfirmasi?

**Temuan awal:** fitur itu sudah ada dan sudah lengkap — `_try_vision_veto()`
(`app.py`), terpasang di alur, dikendalikan `VISION_VETO_NEAR_SMC`, default
`false`, tidak pernah dinyalakan.

### Pengukuran gerbang SMC (tanpa satu pun panggilan AI)

Veto hanya menyentuh sinyal yang harganya dalam 0,5×ATR dari level SMC kuat.
Diukur atas 186 trade backtest:

| | Trade | Win rate | Profit factor |
|---|---|---|---|
| Dekat SMC (target veto) | 169 (**90,9%**) | 54,7% | 1,375 |
| Jauh dari SMC | 17 | 60,0% | 1,419 |

Dua kesimpulan:

1. **Gerbangnya bukan gerbang.** 90,9% trade memenuhinya, karena yang diukur
   adalah jarak ke *salah satu* dari puluhan zona (sampai 30 FVG + OB + 3
   support + 3 resistance). Menyalakan `VISION_VETO_NEAR_SMC` praktis berarti
   men-screening semua sinyal — nama flag dan komentarnya ("harganya
   *kebetulan* dekat level SMC") menyesatkan. Docstring sudah dikoreksi.
2. **Gerbang itu tidak memisahkan yang buruk.** Kelompok "jauh" cuma 17 trade —
   terlalu sedikit untuk disimpulkan. Yang bisa dinyatakan: kedekatan SMC tidak
   menambah informasi sebagai penyeleksi.

Yang diuji di sini adalah **gerbangnya**, bukan **penilaian AI-nya**. Apakah
Vision mampu membedakan setup bagus dari jelek masih sepenuhnya belum teruji.

### Yang dikerjakan

Mode bayangan: catat verdict Vision untuk tiap trade baru **tanpa
menindaklanjutinya**. Nol risiko terhadap trading — trade sudah dibuka sebelum
panggilan dilakukan, dan tidak ada jalur yang membaca kolomnya.

- Kolom baru: `vision_verdict`, `vision_shadow_reason`, `near_smc`
- `_vision_judge_signal()` — helper bersama; `_try_vision_veto()` jadi pembungkus
  tipis di atasnya (perilakunya tidak berubah; jalurnya juga masih mati)
- `_vision_shadow_record()` — dijalankan di thread daemon supaya latensi API
  tidak menunda alert Telegram; kegagalan apa pun ditelan (kolom tetap NULL)
- Sinyal hasil rescue **dilewati** — verdict-nya pasti VALID, jadi memasukkannya
  memberi bias seleksi. Jalur itu sudah diukur `get_vision_rescue_stats()`
- `get_vision_shadow_stats()` + terekspos di `/api/admin/guard_status`
- Flag `VISION_SHADOW_MODE`, default `false`
- 4 test baru (total 63, semua lulus)

### Cara membacanya nanti

Angka penentunya: **`sl_rate` kelompok non-VALID vs VALID.**

- non-VALID jauh lebih tinggi → verdict berkorelasi dengan hasil, veto layak
- kira-kira sama → Vision tidak menambah informasi, biarkan veto mati

Alasannya: veto membuang trade dari sistem yang sudah untung (PF ~1,35). Filter
yang menolak tanpa korelasi ke hasil membuang pemenang dan pecundang dalam
proporsi sama — profit factor tidak membaik, jumlah trade berkurang, varians
naik. **Penolak acak bukan netral, ia merugikan.**

`hipotetis_jika_veto_aktif` langsung menghitung PF yang tersisa kalau semua
non-VALID benar-benar diveto, dibanding kenyataan sekarang.

Butuh 30-50 trade (~2-3/hari → sekitar 2 minggu) sebelum angkanya layak
dipercaya. Sebelum itu, jangan simpulkan apa pun.

**Belum aktif.** Perlu di-set `VISION_SHADOW_MODE=true` di environment Coolify.

---

## Biaya spread dibukukan (2026-09-01)

Permintaan user: spread default 35 poin MT5 = **0,35 satuan harga** (1 poin emas
= 0,01 di MT5), dipakai di backtest DAN produksi.

### Backtest: efek terisolasi

`SPREAD_COST` dikenakan sekali per trade (masuk di ask, keluar di bid = satu
ongkos pulang-pergi), bukan per partial close. Kontrol dijalankan pada jendela
data yang sama, hanya biaya yang dibedakan:

| | Spread 0 | Spread 0,35 |
|---|---|---|
| Trade | 180 | 180 |
| Win rate | 54,8% | 51,1% |
| Profit factor | **1,31** | **1,20** |
| PnL | $1.879,60 | $1.249,60 |
| Netral | 12 | 0 |

Selisih PnL $630,00 = persis 180 x $3,50. Tidak ada residu.

Penurunan PF 0,11 ini **bukan noise**. Noise floor 0,13 yang dipakai di sesi
ini berlaku untuk perbandingan antar-jendela data; di sini trade dan hasilnya
identik, cuma dikurangi biaya tetap, jadi selisihnya eksak.

Catatan metrik: `BE_HIT` tidak lagi netral. Stop di breakeven tetap membayar
spread, jadi 12 trade yang dulu persis nol kini -$3,50 dan pindah ke kolom
rugi. Karena itu win rate 54,8% -> 51,1% BUKAN perbandingan setara -- batas
klasifikasinya bergeser. Profit factor lebih layak dipakai membandingkan.

### Produksi: fallback + penanda asal-usul

`get_entry_spread()` memakai bid/ask bridge; jatuh ke `DEFAULT_SPREAD` (0,35)
kalau bridge diam. Kolom `entry_spread_estimasi` menandai baris yang memakai
nilai cadangan.

Penanda itu ditambahkan karena mengisi NULL dengan konstanta akan menghapus
jejak mana yang benar-benar terukur -- `spread_rata2` perlahan tertarik ke 0,35
seolah itu fakta. `get_spread_stats()` kini melaporkan `spread_rata2_terukur`
(hanya dari bridge) di samping `spread_rata2` (semua).

Peringatan satuan ditulis eksplisit di `.env.example`: menulis `35` berarti
spread $35, tiga kali jarak SL biasa, dan seluruh statistik biaya jadi ngawur
tanpa memunculkan error apa pun.

3 test baru (total 66, semua lulus).

### F5 — `pnl_pips` produksi juga KOTOR dari spread

`_gain()` di `app.py:1724` menghitung `px - entry` dari **harga sinyal**, tanpa
spread. Fill sebenarnya terjadi di ask (BUY) / bid (SELL), jadi PnL yang
tercatat produksi sistematis lebih optimistis sebesar spread per trade.

Ini menutup teka-teki yang menggantung sejak awal sesi. Dibandingkan pada dasar
yang sama, backtest dan produksi ternyata **cocok hampir sempurna**:

| | Kotor | Bersih |
|---|---|---|
| Backtest | 1,31 | 1,20 |
| Produksi (178 trade, all-time) | 1,315 | ~1,20 |

Jadi tidak pernah ada kebocoran sistemik untuk dicari -- yang ada hanya biaya
yang tidak dibukukan di kedua sisi.

Konsekuensi: profit factor dan PnL yang tampil di dashboard/`/performance`
melebih-lebihkan isi rekening sebenarnya, sekitar 0,11 PF. **Tidak diperbaiki**
-- di luar scope permintaan, dan menyentuh angka yang dilihat subscriber. Kalau
mau dikoreksi, pilihannya: kurangi `entry_spread` saat menutup trade, atau
tampilkan dua angka (kotor & bersih) supaya riwayat lama tetap terbaca.

---

## Cap martingale diturunkan 4 -> 2 (2026-09-01)

**Pemicu:** drawdown 7 hari di produksi. User meminta ganti total metode
teknikal (usul Fibonacci); analisis angkanya menunjuk ke arah lain.

| Periode | Trade | Win rate | PnL | Rugi rata-rata/trade |
|---|---|---|---|---|
| 30 hari | 215 | 50,3% | +$1.370 | **+$6,37** |
| 7 hari | 47 | 36,4% | -$1.182 | -$25,16 |
| 24 jam | 8 | 25,0% | -$428 | **-$53,51** |

Dua alasan menolak penggantian metode:

1. **23 hari sebelumnya menghasilkan +$2.552** (168 trade) dengan metode dan
   pasar yang sama. Metode yang rusak fundamental tidak menghasilkan itu.
2. **16 menang dari 44 trade menentukan** hanya butuh win rate sebenarnya 50%
   dan kebetulan: p ~ 3,5%, atau sekitar dua minggu seperti ini per tahun.

Yang TIDAK bisa dijelaskan varians: win rate memburuk 2x lipat, tapi kerugian
rata-rata per trade membengkak **8x lipat**. Selisih itu datang dari pengali
lot, bukan dari mesin sinyal. Dengan cap 4, SL ketiga beruntun dipertaruhkan
4x lot -- satu trade bisa -$400 pada basis 0,10 lot.

Cap 2 membatasi urutan ke 1x -> 2x, memotong kerugian kasus terburuk per trade
jadi separuh, **tanpa menyentuh satu baris pun logika sinyal**.

Keputusan sebelumnya (user mempertahankan martingale) tidak dibatalkan --
martingale tetap hidup, hanya batasnya diturunkan. Bukti yang mendasari
keputusan lama (PF 1,315 dengan vs 1,205 tanpa) diukur sebelum drawdown ini dan
sebelum biaya spread diketahui.

`MAX_MARTINGALE_MULT` kini terdokumentasi di `.env.example` (sebelumnya tidak
sama sekali, meski sudah bisa diatur). 8 test baru mengunci perilakunya (total
74 lulus).

### Diperiksa, ternyata BUKAN masalah

`EARLY_BE_MOVE` ditulis ke kolom `outcome`, dan loop martingale hanya mengenali
SL_HIT (menggandakan) serta TP*/BE_HIT (mereset) -- nilai lain akan dilewati
diam-diam dan menyambung rentetan yang seharusnya putus. Tapi baris itu ditulis
saat `status` masih ACTIVE, sedangkan query martingale menyaring
`status='CLOSED'`, jadi tidak pernah ikut terhitung. Juga hanya ada satu jalur
penutupan trade (`app.py:703`) dan jalur itu selalu mengisi `outcome`, jadi
tidak ada baris CLOSED ber-outcome NULL.

### F6 — pengali martingale buta arah

`get_martingale_multiplier()` (`xauusd_ai_analyst.py:791`) menghitung rentetan
SL **lintas arah**: SL BUY lalu SL SELL tetap menggandakan lot, padahal
keduanya setup independen. Ini tidak konsisten dengan `is_direction_blocked()`
yang justru per-arah.

Akibatnya di pasar choppy -- BUY dan SELL kalah bergantian -- pengali naik lebih
cepat daripada kalau dihitung per arah, tanpa ada rentetan kekalahan nyata di
salah satu arah. Belum diperbaiki (di luar scope permintaan). Perilaku saat ini
sudah dikunci test supaya perubahannya tidak lolos diam-diam.
