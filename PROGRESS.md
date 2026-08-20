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

### Yang perlu dipantau

Cadence scan naik dari 5 menit ke **1 menit**, dan seleksi sinyal berubah
karena M1 kini benar-benar independen dari M5. Butuh beberapa hari data
sebelum bisa dinilai. Kolom `trade_monitors.efficiency_ratio` ikut merekam
rezim baru ini.

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
