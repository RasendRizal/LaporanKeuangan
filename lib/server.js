/**
 * KEUANGAN KELUARGA - Logika backend (port dari Code.gs, database: Supabase/PostgreSQL).
 * Dipanggil lewat api/rpc.js. Nama fungsi & parameternya sama dengan versi Apps Script.
 */
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

export const APP = {
  TITLE: 'Keuangan Keluarga',
  TZ: 'Asia/Jakarta',
  JENIS: ['Pemasukan', 'Pengeluaran', 'Transfer'],
  DOMPET: ['Tunai', 'Rek. Operasional', 'Rek. Pribadi', 'E-Wallet', 'Kartu Kredit', 'Tabungan'],
  KATEGORI: {
    Pemasukan: ['Gaji', 'Bonus', 'Usaha', 'Investasi', 'Hadiah', 'Lainnya'],
    Pengeluaran: ['Rumah', 'Makanan', 'Transportasi', 'Kewajiban', 'Pribadi', 'Anak', 'Kesehatan', 'Sosial', 'Langganan', 'Tabungan'],
    Transfer: ['Antar Dompet']
  },
  ROLES: ['Admin', 'Viewer'],
  JENIS_TAGIHAN: ['Cicilan', 'Tagihan Rutin', 'Langganan'],
  SIKLUS: ['Bulanan', 'Tahunan'],
  METODE_BUNGA: ['Flat', 'Efektif'],
  REMIND_DAYS: { Bulanan: 3, Tahunan: 30 },
  BUNGA_KE: ['Tabungan', 'Deposito']
};

const TIPE = { DOMPET: 'Dompet', OUT: 'Kategori Pengeluaran', IN: 'Kategori Pemasukan' };
const DOMPET_TERKUNCI = ['Tabungan', 'Kartu Kredit'];

/* ============================ KONEKSI & UTIL ============================ */

let _db = null;
export function db() {
  if (!_db) {
    const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error('Konfigurasi server belum lengkap (SUPABASE_URL / SUPABASE_SECRET_KEY).');
    _db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return _db;
}

function ok(res) {
  if (res.error) throw new Error(res.error.message || 'Kesalahan database.');
  return res.data;
}

/** Ambil semua baris (PostgREST membatasi 1000 baris per permintaan). build(from, to) -> query. */
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = ok(await build(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

function newId(prefix) {
  return prefix + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

const normEmail = e => String(e || '').trim().toLowerCase();
const safeText = (s, max) => String(s || '').trim().slice(0, max || 200);

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function todayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP.TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function kasLabel(nama) {
  const m = String(nama || '').match(/^Kas Pribadi - (.+)$/);
  return m ? 'Dompet ' + m[1].trim().split(/\s+/)[0] : nama;
}

/* ============================ KEAMANAN ============================ */

function secret() {
  const s = process.env.APP_SECRET;
  if (!s || s.length < 16) throw new Error('APP_SECRET belum diatur di server.');
  return s;
}

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pin, salt, 32).toString('hex');
}

function verifyPin(pin, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 2) return false;
  const expected = Buffer.from(parts[1], 'hex');
  const actual = crypto.scryptSync(pin, parts[0], 32);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** Token stateless: User_ID + HMAC-SHA256(User_ID, APP_SECRET). */
function makeToken(userId) {
  return userId + '.' + crypto.createHmac('sha256', secret()).update(userId).digest('base64url');
}

async function auth(token) {
  token = String(token || '');
  const userId = token.split('.')[0];
  if (!userId) throw new Error('Sesi tidak valid. Silakan masuk kembali.');
  const a = Buffer.from(makeToken(userId));
  const b = Buffer.from(token);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Sesi tidak valid. Silakan masuk kembali.');
  const user = ok(await db().from('users').select('user_id,email,nama').eq('user_id', userId).maybeSingle());
  if (!user) throw new Error('Akun tidak ditemukan.');
  return user;
}

async function roleOf(userId, kasId) {
  const a = ok(await db().from('akses').select('role').eq('kas_id', String(kasId || '')).eq('user_id', userId).maybeSingle());
  return a ? a.role : null;
}

async function requireRole(userId, kasId, adminOnly) {
  const role = await roleOf(userId, kasId);
  if (!role) throw new Error('Anda tidak memiliki akses ke buku kas ini.');
  if (adminOnly && role !== 'Admin') throw new Error('Hanya Admin yang dapat melakukan aksi ini.');
  return role;
}

async function listKas(userId) {
  const rows = ok(await db().from('akses').select('role, buku_kas(kas_id, nama_buku)').eq('user_id', userId).order('created_at'));
  return rows.filter(a => a.buku_kas).map(a => ({ id: a.buku_kas.kas_id, nama: kasLabel(a.buku_kas.nama_buku), role: a.role }));
}

/* ============================ AUTENTIKASI ============================ */

async function apiSignUp(nama, email, pin) {
  nama = String(nama || '').trim();
  email = normEmail(email);
  pin = String(pin || '');
  if (nama.length < 2) throw new Error('Nama minimal 2 karakter.');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Format email tidak valid.');
  if (pin.length < 4) throw new Error('PIN/Password minimal 4 karakter.');
  const exist = ok(await db().from('users').select('user_id').eq('email', email).maybeSingle());
  if (exist) throw new Error('Email sudah terdaftar.');
  const userId = newId('USR'), kasId = newId('KAS');
  const ins = await db().from('users').insert({ user_id: userId, email, nama: safeText(nama, 60), pin_hash: hashPin(pin) });
  if (ins.error) throw new Error(ins.error.code === '23505' ? 'Email sudah terdaftar.' : ins.error.message);
  ok(await db().from('buku_kas').insert({ kas_id: kasId, nama_buku: safeText('Dompet ' + nama.split(/\s+/)[0], 80), pembuat_id: userId }));
  ok(await db().from('akses').insert({ kas_id: kasId, user_id: userId, role: 'Admin' }));
  return { token: makeToken(userId) };
}

async function apiLogin(email, pin) {
  email = normEmail(email);
  const user = ok(await db().from('users').select('user_id,pin_hash').eq('email', email).maybeSingle());
  if (!user || !verifyPin(String(pin || ''), user.pin_hash)) throw new Error('Email atau PIN salah.');
  return { token: makeToken(user.user_id) };
}

async function apiBootstrap(token) {
  const user = await auth(token);
  return {
    user: { id: user.user_id, nama: user.nama, email: user.email },
    kasList: await listKas(user.user_id),
    config: { jenis: APP.JENIS, roles: APP.ROLES, jenisTagihan: APP.JENIS_TAGIHAN, siklus: APP.SIKLUS, metodeBunga: APP.METODE_BUNGA, bungaKe: APP.BUNGA_KE, kategoriTransfer: APP.KATEGORI.Transfer }
  };
}

/* ============================ BUKU KAS & KOLABORATOR ============================ */

async function apiCreateKas(token, nama) {
  const user = await auth(token);
  nama = String(nama || '').trim();
  if (nama.length < 2) throw new Error('Nama buku kas minimal 2 karakter.');
  const kasId = newId('KAS');
  ok(await db().from('buku_kas').insert({ kas_id: kasId, nama_buku: safeText(nama, 80), pembuat_id: user.user_id }));
  ok(await db().from('akses').insert({ kas_id: kasId, user_id: user.user_id, role: 'Admin' }));
  return { newId: kasId, kasList: await listKas(user.user_id) };
}

async function apiAddCollaborator(token, kasId, email, role) {
  const user = await auth(token);
  await requireRole(user.user_id, kasId, true);
  email = normEmail(email);
  role = APP.ROLES.indexOf(role) >= 0 ? role : 'Viewer';
  const target = ok(await db().from('users').select('user_id,nama').eq('email', email).maybeSingle());
  if (!target) throw new Error('Email belum terdaftar. Minta yang bersangkutan Sign Up dulu.');
  const has = ok(await db().from('akses').select('user_id').eq('kas_id', kasId).eq('user_id', target.user_id).maybeSingle());
  if (has) throw new Error(target.nama + ' sudah memiliki akses ke buku kas ini.');
  ok(await db().from('akses').insert({ kas_id: kasId, user_id: target.user_id, role }));
  return { nama: target.nama, role };
}

/* ============================ PENGATURAN DOMPET & KATEGORI ============================ */

async function settingRows(kasId) {
  const read = async () => ok(await db().from('pengaturan').select('id,tipe,nama,status,terkunci').eq('kas_id', kasId).order('id'));
  let rows = await read();
  if (!rows.length) {
    const seed = [];
    APP.DOMPET.forEach(n => seed.push({ kas_id: kasId, tipe: TIPE.DOMPET, nama: n, status: 'Aktif', terkunci: DOMPET_TERKUNCI.indexOf(n) >= 0 }));
    APP.KATEGORI.Pengeluaran.forEach(n => seed.push({ kas_id: kasId, tipe: TIPE.OUT, nama: n, status: 'Aktif', terkunci: false }));
    APP.KATEGORI.Pemasukan.forEach(n => seed.push({ kas_id: kasId, tipe: TIPE.IN, nama: n, status: 'Aktif', terkunci: false }));
    ok(await db().from('pengaturan').upsert(seed, { onConflict: 'kas_id,tipe,nama', ignoreDuplicates: true }));
    rows = await read();
  }
  return rows;
}

async function settingNames(kasId, tipe) {
  return (await settingRows(kasId)).filter(r => r.tipe === tipe).map(r => r.nama);
}

async function kategoriNames(kasId, jenis) {
  if (jenis === 'Transfer') return APP.KATEGORI.Transfer;
  return settingNames(kasId, jenis === 'Pemasukan' ? TIPE.IN : TIPE.OUT);
}

async function fetchTransaksi(kasId) {
  return fetchAll((a, b) => db().from('transaksi').select('*').eq('kas_id', kasId)
    .order('tanggal', { ascending: false }).order('created_at', { ascending: false }).order('id_transaksi').range(a, b));
}

async function settingUsage(kasId, trxRows) {
  const u = {};
  const add = (tipe, nama) => { if (nama === '' || nama == null) return; const k = tipe + '|' + nama; u[k] = (u[k] || 0) + 1; };
  (trxRows || await fetchTransaksi(kasId)).forEach(r => {
    if (r.jenis === 'Transfer') String(r.dompet).split(' → ').forEach(p => add(TIPE.DOMPET, p));
    else add(TIPE.DOMPET, r.dompet);
    if (r.jenis === 'Pengeluaran') add(TIPE.OUT, r.kategori);
    if (r.jenis === 'Pemasukan') add(TIPE.IN, r.kategori);
  });
  ok(await db().from('saldo_awal').select('dompet,saldo_awal').eq('kas_id', kasId)).forEach(s => { if (Number(s.saldo_awal)) add(TIPE.DOMPET, s.dompet); });
  ok(await db().from('tagihan').select('dompet,kategori').eq('kas_id', kasId)).forEach(t => { add(TIPE.DOMPET, t.dompet); add(TIPE.OUT, t.kategori || 'Kewajiban'); });
  return u;
}

async function settingsData(kasId, trxRows) {
  const [rows, usage] = await Promise.all([settingRows(kasId), settingUsage(kasId, trxRows)]);
  const pick = tipe => rows.filter(r => r.tipe === tipe).map(r => ({
    nama: r.nama, sembunyi: r.status === 'Sembunyi', terkunci: r.terkunci, dipakai: usage[tipe + '|' + r.nama] || 0
  }));
  return { dompet: pick(TIPE.DOMPET), kategoriOut: pick(TIPE.OUT), kategoriIn: pick(TIPE.IN) };
}

function cleanSettingName(nama) {
  nama = String(nama || '').trim().replace(/\s+/g, ' ');
  if (nama.length < 1 || nama.length > 30) throw new Error('Nama harus 1-30 karakter.');
  if (nama.indexOf('→') >= 0) throw new Error('Nama tidak boleh memuat tanda →.');
  return nama;
}

function checkTipe(tipe) {
  if (!Object.keys(TIPE).some(k => TIPE[k] === tipe)) throw new Error('Jenis pengaturan tidak valid.');
}

function findSetting(rows, tipe, nama) {
  const r = rows.find(x => x.tipe === tipe && x.nama === nama);
  if (!r) throw new Error('Item tidak ditemukan.');
  return r;
}

async function apiAddSetting(token, kasId, tipe, nama) {
  const user = await auth(token);
  await requireRole(user.user_id, kasId, true);
  checkTipe(tipe);
  nama = cleanSettingName(nama);
  const rows = await settingRows(kasId);
  if (rows.some(r => r.tipe === tipe && r.nama.toLowerCase() === nama.toLowerCase())) throw new Error('"' + nama + '" sudah ada.');
  ok(await db().from('pengaturan').insert({ kas_id: kasId, tipe, nama, status: 'Aktif', terkunci: false }));
  return { nama };
}

/** Ganti nama + perbarui semua data yang memakainya (transaksi, saldo awal, tagihan) di buku kas ini. */
async function apiRenameSetting(token, kasId, tipe, lama, baru) {
  const user = await auth(token);
  await requireRole(user.user_id, kasId, true);
  checkTipe(tipe);
  baru = cleanSettingName(baru);
  const rows = await settingRows(kasId);
  const item = findSetting(rows, tipe, lama);
  if (baru === lama) return { nama: baru, diperbarui: 0 };
  if (rows.some(r => r.tipe === tipe && r.nama !== lama && r.nama.toLowerCase() === baru.toLowerCase())) throw new Error('"' + baru + '" sudah ada.');
  let n = 0;
  const cnt = res => ok(res).length;
  if (tipe === TIPE.DOMPET) {
    n += cnt(await db().from('transaksi').update({ dompet: baru }).eq('kas_id', kasId).neq('jenis', 'Transfer').eq('dompet', lama).select('kas_id'));
    const tf = ok(await db().from('transaksi').select('id_transaksi,dompet').eq('kas_id', kasId).eq('jenis', 'Transfer').like('dompet', '%→%'));
    for (const r of tf) {
      const parts = String(r.dompet).split(' → ');
      if (parts.indexOf(lama) < 0) continue;
      const nv = parts.map(p => (p === lama ? baru : p)).join(' → ');
      ok(await db().from('transaksi').update({ dompet: nv }).eq('id_transaksi', r.id_transaksi));
      n++;
    }
    n += cnt(await db().from('saldo_awal').update({ dompet: baru }).eq('kas_id', kasId).eq('dompet', lama).select('kas_id'));
    n += cnt(await db().from('tagihan').update({ dompet: baru }).eq('kas_id', kasId).eq('dompet', lama).select('kas_id'));
  } else if (tipe === TIPE.OUT) {
    n += cnt(await db().from('transaksi').update({ kategori: baru }).eq('kas_id', kasId).eq('jenis', 'Pengeluaran').eq('kategori', lama).select('kas_id'));
    n += cnt(await db().from('tagihan').update({ kategori: baru }).eq('kas_id', kasId).eq('kategori', lama).select('kas_id'));
  } else {
    n += cnt(await db().from('transaksi').update({ kategori: baru }).eq('kas_id', kasId).eq('jenis', 'Pemasukan').eq('kategori', lama).select('kas_id'));
  }
  ok(await db().from('pengaturan').update({ nama: baru }).eq('id', item.id));
  return { nama: baru, diperbarui: n };
}

async function apiSetSettingHidden(token, kasId, tipe, nama, sembunyi) {
  const user = await auth(token);
  await requireRole(user.user_id, kasId, true);
  checkTipe(tipe);
  const rows = await settingRows(kasId);
  const item = findSetting(rows, tipe, nama);
  if (sembunyi) {
    if (item.terkunci) throw new Error('"' + nama + '" adalah item bawaan dan tidak bisa disembunyikan.');
    if (rows.filter(r => r.tipe === tipe && r.status === 'Aktif' && r.nama !== nama).length < 1) throw new Error('Minimal harus ada satu item aktif.');
  }
  ok(await db().from('pengaturan').update({ status: sembunyi ? 'Sembunyi' : 'Aktif' }).eq('id', item.id));
  return { nama, sembunyi: !!sembunyi };
}

async function apiDeleteSetting(token, kasId, tipe, nama) {
  const user = await auth(token);
  await requireRole(user.user_id, kasId, true);
  checkTipe(tipe);
  const rows = await settingRows(kasId);
  const item = findSetting(rows, tipe, nama);
  if (item.terkunci) throw new Error('"' + nama + '" adalah item bawaan dan tidak bisa dihapus (boleh diganti nama).');
  if ((await settingUsage(kasId))[tipe + '|' + nama]) throw new Error('"' + nama + '" sudah dipakai. Sembunyikan saja agar data lama tetap utuh.');
  if (rows.filter(r => r.tipe === tipe && r.nama !== nama && r.status === 'Aktif').length < 1) throw new Error('Minimal harus ada satu item aktif.');
  ok(await db().from('pengaturan').delete().eq('id', item.id));
  return { deleted: nama };
}

/* ============================ TRANSAKSI ============================ */

/** Rincian belanja (opsional). Mengembalikan objek bersih atau null. Tidak berlaku untuk Transfer. */
function cleanRincian(r, jenis) {
  if (!r || jenis === 'Transfer' || !Array.isArray(r.items) || !r.items.length) return null;
  if (r.items.length > 100) throw new Error('Maksimal 100 barang per transaksi.');
  const items = r.items.map((it, i) => {
    it = it || {};
    const nama = safeText(it.nama, 100);
    if (!nama) throw new Error('Nama barang #' + (i + 1) + ' wajib diisi.');
    const harga = Math.round(Number(it.harga));
    const qty = Math.round(Number(it.qty) * 1000) / 1000;
    const diskon = Math.round(Number(it.diskon) || 0);
    if (!(harga >= 0 && harga <= 1e12)) throw new Error('Harga "' + nama + '" tidak valid.');
    if (!(qty > 0 && qty <= 1e6)) throw new Error('Qty "' + nama + '" harus lebih dari 0.');
    if (!(diskon >= 0)) throw new Error('Diskon "' + nama + '" tidak valid.');
    if (diskon > Math.round(harga * qty)) throw new Error('Diskon "' + nama + '" melebihi harga barang.');
    return { nama, harga, qty, diskon };
  });
  const pj = r.pajak || {};
  const pajak = Math.round(Number(pj.nominal) || 0);
  if (!(pajak >= 0 && pajak <= 1e12)) throw new Error('Pajak tidak valid.');
  return { items, pajak: { nominal: pajak, termasuk: pj.termasuk !== false } };
}

/** Total = jumlah (harga x qty - diskon) + pajak bila pajak ditambahkan (bukan sudah termasuk harga). */
function rincianTotal(r) {
  const sub = r.items.reduce((s, it) => s + Math.round(it.harga * it.qty) - it.diskon, 0);
  return sub + (r.pajak.termasuk ? 0 : r.pajak.nominal);
}

async function trxFields(kasId, t) {
  t = t || {};
  if (APP.JENIS.indexOf(t.jenis) < 0) throw new Error('Jenis transaksi tidak valid.');
  if (!validDate(t.tanggal)) throw new Error('Tanggal tidak valid.');
  const dompetList = await settingNames(kasId, TIPE.DOMPET);
  if (dompetList.indexOf(t.dompet) < 0) throw new Error('Dompet tidak valid.');
  if ((await kategoriNames(kasId, t.jenis)).indexOf(t.kategori) < 0) throw new Error('Kategori tidak valid.');
  const nama = String(t.nama || '').trim();
  if (!nama) throw new Error('Nama transaksi wajib diisi.');
  const rincian = cleanRincian(t.rincian, t.jenis);
  // Jika ada rincian, nominal dihitung server dari rincian (sumber kebenaran tunggal).
  const nominal = rincian ? rincianTotal(rincian) : Math.round(Number(t.nominal));
  if (!(nominal > 0)) throw new Error('Nominal harus lebih dari 0.');
  let dompet = t.dompet;
  if (t.jenis === 'Transfer') {
    if (dompetList.indexOf(t.dompetTujuan) < 0 || t.dompetTujuan === t.dompet) throw new Error('Dompet tujuan harus berbeda dari dompet asal.');
    dompet = t.dompet + ' → ' + t.dompetTujuan;
  }
  return { tanggal: t.tanggal, jenis: t.jenis, dompet, nama_transaksi: safeText(nama, 100), kategori: t.kategori, nominal, keterangan: safeText(t.keterangan, 500), rincian };
}

async function apiAddTransaction(token, kasId, t) {
  const user = await auth(token);
  await requireRole(user.user_id, kasId, true);
  const f = await trxFields(kasId, t);
  const id = newId('TRX');
  ok(await db().from('transaksi').insert({ id_transaksi: id, ...f, user_id: user.user_id, kas_id: kasId }));
  return { id };
}

async function apiUpdateTransaction(token, kasId, trxId, t) {
  const user = await auth(token);
  await requireRole(user.user_id, kasId, true);
  const f = await trxFields(kasId, t);
  const res = ok(await db().from('transaksi').update(f).eq('id_transaksi', String(trxId)).eq('kas_id', kasId).select('id_transaksi'));
  if (!res.length) throw new Error('Transaksi tidak ditemukan.');
  return { updated: trxId };
}

async function apiDeleteTransaction(token, kasId, trxId) {
  const user = await auth(token);
  await requireRole(user.user_id, kasId, true);
  const res = ok(await db().from('transaksi').delete().eq('id_transaksi', String(trxId)).eq('kas_id', kasId).select('id_transaksi'));
  if (!res.length) throw new Error('Transaksi tidak ditemukan.');
  return { deleted: trxId };
}

/* ============================ TAGIHAN & CICILAN ============================ */

function addMonth(ym, n) {
  const p = String(ym).split('-');
  const d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1 + n, 1));
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2);
}

function dueDate(ym, day) {
  const p = ym.split('-');
  const last = new Date(Date.UTC(Number(p[0]), Number(p[1]), 0)).getUTCDate();
  return ym + '-' + ('0' + Math.min(day, last)).slice(-2);
}

function daysBetween(a, b) {
  const pa = a.split('-'), pb = b.split('-');
  return Math.round((Date.UTC(+pb[0], +pb[1] - 1, +pb[2]) - Date.UTC(+pa[0], +pa[1] - 1, +pa[2])) / 86400000);
}

async function tagihanList(kasId) {
  const today = todayStr();
  const rows = ok(await db().from('tagihan').select('*').eq('kas_id', kasId).order('created_at'));
  const counts = {};
  if (rows.length) {
    const pays = await fetchAll((a, b) => db().from('bayar_tagihan').select('tagihan_id').in('tagihan_id', rows.map(r => r.tagihan_id)).order('bayar_id').range(a, b));
    pays.forEach(p => { counts[p.tagihan_id] = (counts[p.tagihan_id] || 0) + 1; });
  }
  return rows.map(t => {
    const n = counts[t.tagihan_id] || 0;
    const tenor = Number(t.tenor_total) || 0;
    const nominal = Number(t.nominal) || 0;
    const terbayar = (Number(t.terbayar_awal) || 0) + n;
    const lunas = tenor > 0 && terbayar >= tenor;
    const siklus = t.siklus === 'Tahunan' ? 'Tahunan' : 'Bulanan';
    const step = siklus === 'Tahunan' ? 12 : 1;
    const periode = addMonth(t.mulai_bulan, n * step);
    const o = {
      id: t.tagihan_id, nama: t.nama, pemberi: t.pemberi, jenis: t.jenis, nominal,
      kategori: t.kategori || 'Kewajiban', siklus, berhenti: t.status === 'Berhenti',
      pokok: Number(t.pokok_cicilan) || 0, bunga: Number(t.bunga_persen) || 0, metode: t.metode_bunga || '',
      awal: Number(t.terbayar_awal) || 0, next: periode,
      hari: Number(t.hari_jatuh_tempo), tenor, terbayar, dompet: t.dompet, lunas,
      sisaTotal: tenor > 0 ? nominal * Math.max(0, tenor - terbayar) : 0
    };
    if (!lunas) {
      o.periode = periode;
      o.jatuhTempo = dueDate(o.periode, o.hari);
      o.selisihHari = daysBetween(today, o.jatuhTempo);
    }
    return o;
  }).sort((a, b) => (a.lunas - b.lunas) || (a.berhenti - b.berhenti) || String(a.jatuhTempo || '').localeCompare(String(b.jatuhTempo || '')));
}

async function tagihanFields(kasId, t) {
  t = t || {};
  const nama = String(t.nama || '').trim();
  if (!nama) throw new Error('Nama wajib diisi.');
  if (APP.JENIS_TAGIHAN.indexOf(t.jenis) < 0) throw new Error('Jenis tidak valid.');
  const nominal = Math.round(Number(t.nominal));
  if (!(nominal > 0)) throw new Error('Nominal harus lebih dari 0.');
  const hari = Math.round(Number(t.hari));
  if (!(hari >= 1 && hari <= 31)) throw new Error('Tanggal jatuh tempo harus antara 1 dan 31.');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(t.mulai || '')) throw new Error('Bulan jatuh tempo berikutnya tidak valid.');
  if ((await settingNames(kasId, TIPE.DOMPET)).indexOf(t.dompet) < 0) throw new Error('Dompet tidak valid.');
  const katNames = await settingNames(kasId, TIPE.OUT);
  const defKat = t.jenis === 'Langganan' ? 'Langganan' : 'Kewajiban';
  const kategori = t.kategori || (katNames.indexOf(defKat) >= 0 ? defKat : katNames[0]);
  if (katNames.indexOf(kategori) < 0) throw new Error('Kategori tidak valid.');
  let siklus = APP.SIKLUS.indexOf(t.siklus) >= 0 ? t.siklus : 'Bulanan';
  let tenor = 0, awal = 0, pokok = 0, bunga = 0, metode = '';
  if (t.jenis === 'Cicilan') {
    siklus = 'Bulanan';
    tenor = Math.round(Number(t.tenor));
    awal = Math.round(Number(t.terbayarAwal)) || 0;
    if (!(tenor >= 1 && tenor <= 600)) throw new Error('Tenor cicilan tidak valid.');
    if (awal < 0 || awal >= tenor) throw new Error('Jumlah cicilan yang sudah dibayar harus kurang dari tenor.');
    pokok = Math.max(0, Math.round(Number(t.pokok)) || 0);
    bunga = Number(t.bunga) || 0;
    if (!(bunga >= 0 && bunga <= 100)) throw new Error('Bunga per tahun tidak valid (0-100).');
    metode = APP.METODE_BUNGA.indexOf(t.metode) >= 0 ? t.metode : 'Flat';
  }
  return { nama: safeText(nama, 80), pemberi: safeText(t.pemberi, 80), jenis: t.jenis, nominal, hari, tenor, awal, mulai: t.mulai, dompet: t.dompet, kategori, siklus, pokok, bunga, metode };
}

async function apiSaveTagihan(token, kasId, t) {
  const user = await auth(token);
  await requireRole(user.user_id, kasId, true);
  const f = await tagihanFields(kasId, t);
  const id = newId('TGH');
  ok(await db().from('tagihan').insert({
    tagihan_id: id, kas_id: kasId, nama: f.nama, pemberi: f.pemberi, jenis: f.jenis, nominal: f.nominal, hari_jatuh_tempo: f.hari,
    tenor_total: f.tenor, terbayar_awal: f.awal, mulai_bulan: f.mulai, dompet: f.dompet, kategori: f.kategori, siklus: f.siklus,
    status: 'Aktif', pokok_cicilan: f.pokok, bunga_persen: f.bunga, metode_bunga: f.metode
  }));
  return { id };
}

/** `mulai` dari form = jatuh tempo berikutnya; disimpan sebagai mulai_bulan dikurangi (pembayaran tercatat x langkah siklus). */
async function apiUpdateTagihan(token, kasId, id, t) {
  const user = await auth(token);
  await requireRole(user.user_id, kasId, true);
  const f = await tagihanFields(kasId, t);
  const exist = ok(await db().from('tagihan').select('tagihan_id').eq('tagihan_id', String(id)).eq('kas_id', kasId).maybeSingle());
  if (!exist) throw new Error('Tagihan tidak ditemukan.');
  const { count } = await db().from('bayar_tagihan').select('bayar_id', { count: 'exact', head: true }).eq('tagihan_id', id);
  const n = count || 0;
  const step = f.siklus === 'Tahunan' ? 12 : 1;
  ok(await db().from('tagihan').update({
    nama: f.nama, pemberi: f.pemberi, jenis: f.jenis, nominal: f.nominal, hari_jatuh_tempo: f.hari, tenor_total: f.tenor,
    terbayar_awal: f.awal, mulai_bulan: addMonth(f.mulai, -n * step), dompet: f.dompet, kategori: f.kategori, siklus: f.siklus,
    pokok_cicilan: f.pokok, bunga_persen: f.bunga, metode_bunga: f.metode
  }).eq('tagihan_id', id).eq('kas_id', kasId));
  return { updated: id };
}

async function apiSetStatusTagihan(token, kasId, id, berhenti) {
  const user = await auth(token);
  await requireRole(user.user_id, kasId, true);
  const res = ok(await db().from('tagihan').update({ status: berhenti ? 'Berhenti' : 'Aktif' }).eq('tagihan_id', String(id)).eq('kas_id', kasId).select('tagihan_id'));
  if (!res.length) throw new Error('Tagihan tidak ditemukan.');
  return { id, berhenti: !!berhenti };
}

async function apiDeleteTagihan(token, kasId, id) {
  const user = await auth(token);
  await requireRole(user.user_id, kasId, true);
  const res = ok(await db().from('tagihan').delete().eq('tagihan_id', String(id)).eq('kas_id', kasId).select('tagihan_id'));
  if (!res.length) throw new Error('Tagihan tidak ditemukan.');
  return { deleted: id };
}

async function apiPayTagihan(token, kasId, id, dompet, tanggal) {
  const user = await auth(token);
  await requireRole(user.user_id, kasId, true);
  if ((await settingNames(kasId, TIPE.DOMPET)).indexOf(dompet) < 0) throw new Error('Dompet tidak valid.');
  if (!validDate(tanggal)) throw new Error('Tanggal tidak valid.');
  const t = (await tagihanList(kasId)).find(x => x.id === id);
  if (!t) throw new Error('Tagihan tidak ditemukan.');
  if (t.lunas) throw new Error('Tagihan ini sudah lunas.');
  if (t.berhenti) throw new Error('Langganan ini sudah dihentikan. Aktifkan kembali untuk mencatat pembayaran.');
  const ke = t.terbayar + 1;
  const label = t.tenor > 0 ? t.nama + ' (' + ke + '/' + t.tenor + ')' : t.nama + ' ' + t.periode;
  const trxId = newId('TRX');
  ok(await db().from('transaksi').insert({
    id_transaksi: trxId, tanggal, jenis: 'Pengeluaran', dompet, nama_transaksi: safeText(label, 100), kategori: t.kategori, nominal: t.nominal,
    keterangan: safeText('Pembayaran periode ' + t.periode + (t.pemberi ? ' - ' + t.pemberi : ''), 500), user_id: user.user_id, kas_id: kasId
  }));
  const pay = await db().from('bayar_tagihan').insert({ bayar_id: newId('PAY'), tagihan_id: id, periode: t.periode, tanggal, nominal: t.nominal, id_transaksi: trxId });
  if (pay.error) {
    await db().from('transaksi').delete().eq('id_transaksi', trxId); // batalkan agar tidak ada transaksi yatim
    throw new Error(pay.error.message);
  }
  return { ke, periode: t.periode };
}

/* ============================ DEPOSITO ============================ */

function addMonthsToDate(iso, n) {
  const p = iso.split('-').map(Number);
  return dueDate(addMonth(p[0] + '-' + ('0' + p[1]).slice(-2), n), p[2]);
}

async function depositoList(kasId) {
  const today = todayStr();
  const all = ok(await db().from('deposito').select('*').eq('kas_id', kasId).order('created_at'));
  return all.map(d => {
    const pokok = Number(d.pokok) || 0, bunga = Number(d.bunga_persen) || 0, tenor = Number(d.tenor_bulan) || 0;
    const o = {
      id: d.dep_id, nama: d.nama, institusi: d.institusi, pokok, bunga, tenor,
      mulai: d.tanggal_mulai, jatuhTempo: d.jatuh_tempo, aro: !!d.aro,
      bungaKe: d.bunga_ke === 'Deposito' ? 'Deposito' : 'Tabungan',
      status: d.status, estBunga: Math.round(pokok * bunga / 100 * tenor / 12)
    };
    if (d.status === 'Cair') {
      o.tglCair = d.tanggal_cair;
      o.nominalCair = Number(d.nominal_cair) || 0;
      o.bungaDiterima = o.nominalCair - pokok;
    } else {
      o.selisihHari = daysBetween(today, o.jatuhTempo);
    }
    const next = all.find(x => x.sebelumnya_id === d.dep_id);
    if (next) o.lanjutKe = next.institusi;
    return o;
  }).sort((a, b) => a.status === b.status
    ? (a.status === 'Aktif' ? a.jatuhTempo.localeCompare(b.jatuhTempo) : String(b.tglCair).localeCompare(String(a.tglCair)))
    : (a.status === 'Aktif' ? -1 : 1));
}

async function depositoData(kasId) {
  const list = await depositoList(kasId);
  const year = todayStr().slice(0, 4);
  const r = { terblokir: 0, estBunga: 0, bungaTotal: 0, bungaTahunIni: 0 };
  const inst = {};
  list.forEach(x => {
    const g = inst[x.institusi] = inst[x.institusi] || { institusi: x.institusi, aktif: 0, jumlahAktif: 0, bunga: 0, jumlahCair: 0 };
    if (x.status === 'Aktif') {
      r.terblokir += x.pokok; r.estBunga += x.estBunga; g.aktif += x.pokok; g.jumlahAktif++;
    } else {
      r.bungaTotal += x.bungaDiterima; g.bunga += x.bungaDiterima; g.jumlahCair++;
      if (String(x.tglCair).slice(0, 4) === year) r.bungaTahunIni += x.bungaDiterima;
    }
  });
  r.perInstitusi = Object.keys(inst).map(k => inst[k]).sort((a, b) => (b.aktif - a.aktif) || (b.bunga - a.bunga));
  return { list, ringkas: r };
}

function depositoRow(kasId, d, sebelumnyaId) {
  d = d || {};
  const institusi = String(d.institusi || '').trim();
  if (!institusi) throw new Error('Bank / platform wajib diisi.');
  const pokok = Math.round(Number(d.pokok));
  if (!(pokok > 0)) throw new Error('Nominal deposito harus lebih dari 0.');
  const bunga = Number(d.bunga);
  if (!(bunga >= 0 && bunga <= 100)) throw new Error('Bunga per tahun tidak valid (0-100).');
  const tenor = Math.round(Number(d.tenor));
  if (!(tenor >= 1 && tenor <= 120)) throw new Error('Tenor harus 1-120 bulan.');
  if (!validDate(d.mulai)) throw new Error('Tanggal mulai tidak valid.');
  const nama = String(d.nama || '').trim() || 'Deposito ' + tenor + ' bulan';
  return {
    dep_id: newId('DEP'), kas_id: kasId, nama: safeText(nama, 80), institusi: safeText(institusi, 80), pokok, bunga_persen: bunga,
    tanggal_mulai: d.mulai, tenor_bulan: tenor, jatuh_tempo: addMonthsToDate(d.mulai, tenor), aro: !!d.aro, status: 'Aktif',
    sebelumnya_id: sebelumnyaId || null, tanggal_cair: null, nominal_cair: null,
    bunga_ke: APP.BUNGA_KE.indexOf(d.bungaKe) >= 0 ? d.bungaKe : 'Tabungan'
  };
}

async function apiSaveDeposito(token, kasId, d) {
  const user = await auth(token);
  await requireRole(user.user_id, kasId, true);
  const row = depositoRow(kasId, d, '');
  ok(await db().from('deposito').insert(row));
  return { id: row.dep_id };
}

async function apiUpdateDeposito(token, kasId, id, d) {
  const user = await auth(token);
  await requireRole(user.user_id, kasId, true);
  const row = depositoRow(kasId, d, '');
  const cur = ok(await db().from('deposito').select('status').eq('dep_id', String(id)).eq('kas_id', kasId).maybeSingle());
  if (!cur) throw new Error('Deposito tidak ditemukan.');
  if (cur.status === 'Cair') throw new Error('Deposito yang sudah dicairkan tidak dapat diubah.');
  ok(await db().from('deposito').update({
    nama: row.nama, institusi: row.institusi, pokok: row.pokok, bunga_persen: row.bunga_persen, tanggal_mulai: row.tanggal_mulai,
    tenor_bulan: row.tenor_bulan, jatuh_tempo: row.jatuh_tempo, aro: row.aro, bunga_ke: row.bunga_ke
  }).eq('dep_id', id).eq('kas_id', kasId));
  return { updated: id };
}

async function apiCairkanDeposito(token, kasId, id, tanggal, nominalCair, baru) {
  const user = await auth(token);
  await requireRole(user.user_id, kasId, true);
  if (!validDate(tanggal)) throw new Error('Tanggal cair tidak valid.');
  nominalCair = Math.round(Number(nominalCair));
  if (!(nominalCair > 0)) throw new Error('Total diterima harus lebih dari 0.');
  const cur = ok(await db().from('deposito').select('status,pokok').eq('dep_id', String(id)).eq('kas_id', kasId).maybeSingle());
  if (!cur) throw new Error('Deposito tidak ditemukan.');
  if (cur.status === 'Cair') throw new Error('Deposito ini sudah dicairkan.');
  const newRow = baru ? depositoRow(kasId, baru, id) : null;
  const upd = ok(await db().from('deposito').update({ status: 'Cair', tanggal_cair: tanggal, nominal_cair: nominalCair })
    .eq('dep_id', id).eq('kas_id', kasId).eq('status', 'Aktif').select('dep_id'));
  if (!upd.length) throw new Error('Deposito ini sudah dicairkan.');
  if (newRow) ok(await db().from('deposito').insert(newRow));
  return { bunga: nominalCair - (Number(cur.pokok) || 0), baruId: newRow ? newRow.dep_id : null };
}

async function apiDeleteDeposito(token, kasId, id) {
  const user = await auth(token);
  await requireRole(user.user_id, kasId, true);
  const res = ok(await db().from('deposito').delete().eq('dep_id', String(id)).eq('kas_id', kasId).select('dep_id'));
  if (!res.length) throw new Error('Deposito tidak ditemukan.');
  return { deleted: id };
}

/* ============================ SALDO AWAL ============================ */

async function apiSetSaldoAwal(token, kasId, dompet, nominal) {
  const user = await auth(token);
  await requireRole(user.user_id, kasId, true);
  if ((await settingNames(kasId, TIPE.DOMPET)).indexOf(dompet) < 0) throw new Error('Dompet tidak valid.');
  nominal = Math.round(Number(nominal));
  if (!isFinite(nominal)) throw new Error('Nominal tidak valid.');
  ok(await db().from('saldo_awal').upsert({ kas_id: kasId, dompet, saldo_awal: nominal }, { onConflict: 'kas_id,dompet' }));
  return { dompet, saldoAwal: nominal };
}

/* ============================ DASHBOARD ============================ */

async function apiGetDashboard(token, kasId, ym) {
  const user = await auth(token);
  const role = await requireRole(user.user_id, kasId, false);
  ym = /^\d{4}-\d{2}$/.test(ym || '') ? ym : todayStr().slice(0, 7);

  const rows = await fetchTransaksi(kasId);
  const [settings, saldoRows, tagihan, deposito, aksesRows] = await Promise.all([
    settingsData(kasId, rows),
    db().from('saldo_awal').select('dompet,saldo_awal').eq('kas_id', kasId).then(ok),
    tagihanList(kasId),
    depositoData(kasId),
    db().from('akses').select('user_id,role').eq('kas_id', kasId).order('created_at').then(ok)
  ]);

  const awal = Object.create(null), wallet = Object.create(null);
  settings.dompet.forEach(w => { awal[w.nama] = 0; wallet[w.nama] = 0; });
  saldoRows.forEach(s => {
    if (s.dompet in awal) { awal[s.dompet] = Number(s.saldo_awal) || 0; wallet[s.dompet] = awal[s.dompet]; }
  });

  let income = 0, expense = 0;
  const cat = {};
  const list = [];
  rows.forEach(r => {
    const nominal = Number(r.nominal) || 0;
    const tgl = String(r.tanggal).slice(0, 10);
    if (r.jenis === 'Transfer') {
      const p = String(r.dompet).split(' → ');
      if (p[0] in wallet) wallet[p[0]] -= nominal;
      if (p[1] in wallet) wallet[p[1]] += nominal;
    } else if (r.dompet in wallet) {
      wallet[r.dompet] += r.jenis === 'Pemasukan' ? nominal : -nominal;
    }
    if (tgl.slice(0, 7) === ym) {
      if (r.jenis === 'Pemasukan') income += nominal;
      if (r.jenis === 'Pengeluaran') { expense += nominal; cat[r.kategori] = (cat[r.kategori] || 0) + nominal; }
      list.push({ id: r.id_transaksi, tanggal: tgl, jenis: r.jenis, dompet: r.dompet, nama: r.nama_transaksi, kategori: r.kategori, nominal, keterangan: r.keterangan, rincian: r.rincian || null, _uid: r.user_id });
    }
  });

  const recent = list.slice(0, 30);
  const uids = Array.from(new Set(recent.map(x => x._uid).concat(aksesRows.map(a => a.user_id)).filter(Boolean)));
  const users = uids.length ? ok(await db().from('users').select('user_id,nama,email').in('user_id', uids)) : [];
  const byId = {};
  users.forEach(u => { byId[u.user_id] = u; });
  recent.forEach(x => { x.oleh = (byId[x._uid] || {}).nama || '-'; delete x._uid; });

  const hidden = {};
  settings.dompet.forEach(w => { hidden[w.nama] = w.sembunyi; });
  const wallets = settings.dompet.map(w => ({ dompet: w.nama, saldoAwal: awal[w.nama], saldo: wallet[w.nama] }))
    .filter(w => !hidden[w.dompet] || w.saldo !== 0 || w.saldoAwal !== 0);
  const balance = wallets.reduce((sum, w) => sum + w.saldo, 0);

  return {
    month: ym,
    role,
    settings,
    balance,
    wallets,
    tagihan,
    deposito,
    income,
    expense,
    byCategory: Object.keys(cat).map(k => ({ kategori: k, total: cat[k] })).sort((a, b) => b.total - a.total),
    recent,
    members: aksesRows.map(a => ({ nama: (byId[a.user_id] || {}).nama || '-', email: (byId[a.user_id] || {}).email || '', role: a.role }))
  };
}

/* ============================ PENGINGAT EMAIL ============================ */

const rupiah = n => 'Rp ' + String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/** Dipanggil oleh api/cron-pengingat.js. Mengembalikan jumlah email terkirim. */
export async function kirimPengingat(sendMail) {
  const users = ok(await db().from('users').select('user_id,email,nama'));
  const books = ok(await db().from('buku_kas').select('kas_id,nama_buku'));
  const akses = ok(await db().from('akses').select('kas_id,user_id'));
  const perUser = {};
  for (const b of books) {
    const due = (await tagihanList(b.kas_id)).filter(t => !t.lunas && !t.berhenti && t.selisihHari <= APP.REMIND_DAYS[t.siklus]);
    const dep = (await depositoList(b.kas_id)).filter(x => x.status === 'Aktif' && x.selisihHari <= 7);
    if (!due.length && !dep.length) continue;
    akses.filter(a => a.kas_id === b.kas_id).forEach(a => {
      (perUser[a.user_id] = perUser[a.user_id] || []).push({ kas: kasLabel(b.nama_buku), due, dep });
    });
  }
  let sent = 0;
  for (const uid of Object.keys(perUser)) {
    const u = users.find(x => x.user_id === uid);
    if (!u) continue;
    const lines = [];
    perUser[uid].forEach(g => {
      lines.push('[' + g.kas + ']');
      g.due.forEach(t => {
        const s = t.selisihHari < 0 ? 'TERLAMBAT ' + (-t.selisihHari) + ' hari'
          : t.selisihHari === 0 ? 'jatuh tempo HARI INI' : 'H-' + t.selisihHari + ' (' + t.jatuhTempo + ')';
        lines.push('- ' + t.nama + ': ' + rupiah(t.nominal) + ' - ' + s);
      });
      g.dep.forEach(x => {
        const s = x.selisihHari < 0 ? 'lewat ' + (-x.selisihHari) + ' hari'
          : x.selisihHari === 0 ? 'HARI INI' : 'H-' + x.selisihHari + ' (' + x.jatuhTempo + ')';
        lines.push('- Deposito ' + x.institusi + ' (' + x.nama + '): ' + rupiah(x.pokok) + ' jatuh tempo ' + s);
      });
      lines.push('');
    });
    await sendMail(u.email, 'Pengingat tagihan - ' + APP.TITLE, 'Halo ' + u.nama + ',\n\nTagihan dan deposito yang perlu diperhatikan:\n\n' + lines.join('\n'));
    sent++;
  }
  return sent;
}

/* ============================ DAFTAR FUNGSI YANG BOLEH DIPANGGIL ============================ */

export const handlers = {
  apiSignUp, apiLogin, apiBootstrap,
  apiCreateKas, apiAddCollaborator,
  apiAddTransaction, apiUpdateTransaction, apiDeleteTransaction,
  apiSaveTagihan, apiUpdateTagihan, apiSetStatusTagihan, apiDeleteTagihan, apiPayTagihan,
  apiSaveDeposito, apiUpdateDeposito, apiCairkanDeposito, apiDeleteDeposito,
  apiAddSetting, apiRenameSetting, apiSetSettingHidden, apiDeleteSetting,
  apiSetSaldoAwal, apiGetDashboard
};
