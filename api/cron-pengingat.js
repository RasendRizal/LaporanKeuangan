import { kirimPengingat, APP } from '../lib/server.js';

/** Dipanggil Vercel Cron (lihat vercel.json) tiap hari 00:00 UTC = 07:00 WIB. Butuh CRON_SECRET dan RESEND_API_KEY. */
export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== 'Bearer ' + secret) {
    res.status(401).json({ ok: false, error: 'Tidak diizinkan.' });
    return;
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    res.status(200).json({ ok: true, skipped: 'RESEND_API_KEY belum diatur, pengingat email tidak dikirim.' });
    return;
  }
  const from = process.env.RESEND_FROM || APP.TITLE + ' <onboarding@resend.dev>';
  const sendMail = async (to, subject, text) => {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text })
    });
    if (!r.ok) throw new Error('Resend gagal (' + r.status + '): ' + (await r.text()));
  };
  try {
    const sent = await kirimPengingat(sendMail);
    res.status(200).json({ ok: true, sent });
  } catch (e) {
    res.status(500).json({ ok: false, error: (e && e.message) || String(e) });
  }
}
