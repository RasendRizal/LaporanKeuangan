# Keuangan Keluarga (Vercel + Supabase)

Tampilan dan fungsi sama dengan versi Google Apps Script. Bedanya:

- Database: Google Sheets -> Supabase (PostgreSQL)
- Backend: `Code.gs` -> Vercel Serverless Functions (`api/rpc.js` + `lib/server.js`)
- Frontend: `Index/CSS/JS.html` -> `public/index.html`, `public/style.css`, `public/app.js`
- Pengingat email: trigger Apps Script -> Vercel Cron + Resend (opsional)

## Struktur

```
api/rpc.js              satu endpoint untuk semua aksi (POST {fn, args})
api/cron-pengingat.js   email pengingat harian (opsional)
lib/server.js           seluruh logika bisnis (port dari Code.gs)
public/                 index.html, style.css, app.js
supabase/schema.sql     skema tabel
vercel.json, package.json, .env.example
```

## Langkah deploy

### 1. Buat tabel di Supabase
Dashboard Supabase > **SQL Editor** > New query > tempel isi `supabase/schema.sql` > **Run**.

### 2. Upload ke GitHub
Upload seluruh isi folder ini (kecuali file `.env` jika ada) ke repository baru. File Apps Script lama (`Code.gs`, `Index.html`, `CSS.html`, `JS.html`) tidak dipakai lagi dan boleh dihapus atau dibiarkan.

### 3. Import di Vercel
Vercel > Add New > Project > pilih repository. Framework Preset: **Other**. Biarkan build command kosong.
Isi **Environment Variables**:

| Nama | Isi |
|---|---|
| `SUPABASE_URL` | `https://anowfxwrnxxnnmppxmyu.supabase.co` |
| `SUPABASE_SECRET_KEY` | secret key Supabase (yang baru, lihat catatan keamanan) |
| `APP_SECRET` | string acak minimal 32 karakter (penanda tangan token login) |

Opsional untuk email pengingat: `CRON_SECRET`, `RESEND_API_KEY`, `RESEND_FROM`.
Deploy. Selesai.

## Rincian belanja (opsional)

Di form transaksi (tambah maupun edit) ada tautan kecil **+ Rincian belanja (opsional)**. Jika dibuka, Anda bisa mengisi per barang: nama, harga satuan, qty, dan diskon, ditambah PPN (sudah termasuk harga atau ditambahkan ke total). Nominal transaksi dihitung otomatis dari rincian dan dihitung ulang oleh server. Jika tautan tidak dibuka, transaksi bekerja seperti biasa. Di daftar transaksi, item yang punya rincian menampilkan "N barang" yang bisa diketuk untuk melihat detailnya. Tidak berlaku untuk jenis Transfer.

Jika tabel `transaksi` sudah dibuat sebelum fitur ini ada, jalankan satu baris ini di SQL Editor:

```sql
alter table transaksi add column if not exists rincian jsonb;
```

## Catatan penting

- **Keamanan:** secret key hanya boleh ada di Environment Variables Vercel, jangan di file atau GitHub. Karena key sudah pernah ditulis di chat, sebaiknya buat ulang di Supabase (Project Settings > API Keys) lalu pakai yang baru.
- **Publishable key tidak dipakai.** Semua akses data lewat server, dan tabel dikunci dengan Row Level Security tanpa policy sehingga publishable key tidak bisa membaca data.
- **PIN lama tidak bisa dibawa.** Di Apps Script PIN di-hash dengan cara yang tidak bisa dipakai ulang. Semua pengguna perlu Daftar ulang dengan email yang sama (buku kas dibuat otomatis). Bila perlu memindahkan data transaksi lama, impor CSV dari Sheets ke tabel terkait lewat Supabase Table Editor.
- **Email pengingat** berjalan tiap hari 07:00 WIB lewat Vercel Cron, dan hanya aktif bila `RESEND_API_KEY` dan `CRON_SECRET` diisi.
- **Zona waktu:** perhitungan "hari ini" memakai `Asia/Jakarta`.

## Pengembangan lokal

```bash
npm install
cp .env.example .env   # isi nilainya
npx vercel dev
```
