# ULD Scanner: Google Sheets sebagai database (sementara)

Skrip `Code.gs` menjadikan satu Google Sheet sebagai tempat simpan data dari
telefon. Ia guna "bahasa" yang sama dengan backend PHP, jadi bila hosting
PHP/MySQL sudah ada, anda cuma tukar satu baris (`API_BASE`) dalam scanner.

## Pasang (lebih kurang 10 minit)

1. Buka Google Sheets, cipta spreadsheet baru. Namakan contohnya "ULD Scanner DB".
2. Menu **Extensions > Apps Script**.
3. Padam semua kod contoh, tampal seluruh isi `Code.gs`, klik **Save**.
4. Di bar atas pilih fungsi **setup**, klik **Run**. Kali pertama Google minta
   kebenaran: Review permissions > pilih akaun > Advanced > Go to project > Allow.
5. Balik ke spreadsheet. Sekarang ada 9 tab: SESSIONS, SCANS, EVENTS, USERS,
   STATIONS, ZONES, CONFIG, CONFLICTS, IMAGES. Email anda sudah ada dalam USERS
   sebagai ADMIN.
6. Dalam Apps Script: **Deploy > New deployment** > ikon gear > **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Deploy, kemudian salin **Web app URL** (berakhir dengan `/exec`).
7. Buka URL itu di browser. Patut keluar `"ok":true,"database":"connected"`.
8. Dalam scanner, buka `js/config.js` dan tukar:
   ```js
   export const API_BASE = 'https://script.google.com/macros/s/XXXX/exec';
   ```
   Jalankan `node tools/update-sw.mjs`, kemudian push ke GitHub seperti biasa.
9. Di telefon: log masuk dengan email anda, scan satu ULD, confirm. Tulisan
   atas bertukar ke "Synced" dan baris baru muncul di tab **SCANS**.

Jika "Anyone" tiada dalam pilihan (hanya "Anyone within <syarikat>"), admin
Google Workspace syarikat telah menyekatnya, dan app tidak akan dapat
berhubung. Bincang dengan IT; jangan pindahkan data syarikat ke akaun Gmail
peribadi tanpa kebenaran.

## Urus melalui tab

| Tab | Guna untuk |
|---|---|
| **USERS** | Tambah staff: satu baris seorang. `stations` = kod dipisah koma (`KUL,PEN`) atau `*` untuk semua. `active` = TRUE / FALSE. Berkuat kuasa serta-merta. |
| **STATIONS**, **ZONES** | Senarai station dan zone. Jangan padam baris yang pernah diguna; tukar `active` kepada FALSE. Yang ada sekarang hanya contoh. |
| **CONFIG** | Peraturan ULD, prefix, kod operator, threshold (dalam bentuk JSON). `company_domains` contohnya `["syarikat.com"]`. |
| **SCANS** | Satu baris satu ULD. Kontena yang dikira: `counted_as_container` = TRUE. Palet yang dikira: `state` = CONFIRMED dan `category` = PALLET. |
| **SESSIONS**, **EVENTS** | Sesi dan apa yang berlaku padanya. |
| **CONFLICTS** | Jika dua telefon ubah rekod yang sama, kedua-dua versi disimpan di sini. |
| **IMAGES** | Gambar crop untuk scan bermasalah sahaja; failnya dalam folder Drive "ULD Scanner crops". |

Jangan ubah tajuk lajur, jangan susun semula (sort) atau padam baris dalam
SESSIONS / SCANS / EVENTS, dan jangan sentuh lajur `data` dan `server_rev`.
Untuk analisis, buat tab lain yang merujuk kepada tab ini (contohnya dengan
`=QUERY(SCANS!A:AB, ...)`).

Semua masa disimpan dalam UTC (Malaysia = UTC+8).

## Palet (scanner versi 0.4)

Scanner versi 0.4 ada mod **Pallets**. Jika Sheet anda dibuat dengan `Code.gs`
yang lama:

1. Tampal `Code.gs` yang baru (ganti semua), **Save**, kemudian deploy versi
   baru seperti di bawah ("Bila kod diubah").
2. Di bar atas Apps Script pilih fungsi **upgradePallets**, klik **Run**
   (sekali sahaja). Ia menambah dalam tab CONFIG: jenis palet dikira, kod
   pemilik R9 / C6 / TG / EK / TRA, dan peraturan untuk kod pemilik 3 huruf
   (contoh `PAJ 0606 TRA`). Tiada apa yang dipadam.

Kalau langkah 2 tidak dibuat, scanner masih boleh scan palet, tetapi palet
berkod pemilik 3 huruf ditolak sebagai tidak sah, dan R9 / C6 / TG / EK
keluar sebagai "Unknown airline/operator code".

## Bila kod diubah

Selepas edit `Code.gs`: **Deploy > Manage deployments > Edit > Version: New
version > Deploy**. URL kekal sama. Jika anda buat "New deployment", URL
bertukar dan `API_BASE` perlu dikemas kini.

## Had yang perlu tahu

- **Belum diuji di Google sebenar.** Logiknya diuji dengan tiruan Apps Script
  di komputer; percubaan pertama anda ialah ujian sebenar.
- **Lebih perlahan daripada MySQL.** Setiap sync ambil beberapa saat. Scan
  tidak terganggu kerana data disimpan dalam telefon dahulu.
- **Sesuai untuk pilot, bukan jangka panjang.** Semakin banyak baris, semakin
  perlahan, dan Google ada kuota harian untuk Apps Script.
- **Log masuk hanya email tanpa kata laluan**, sama seperti versi PHP. URL web
  app terbuka kepada sesiapa, tetapi setiap permintaan disemak dengan senarai
  USERS.
- **Tiada kerja harian automatik**: sesi lama ditutup oleh telefon itu sendiri
  bila app dibuka semula; gambar crop tidak dipadam automatik.
