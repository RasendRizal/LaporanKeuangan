import { handlers } from '../lib/server.js';

/** Satu endpoint untuk semua aksi: POST { fn: 'apiLogin', args: [...] } -> { ok, data | error } */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Metode tidak diizinkan.' });
    return;
  }
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  const fn = body && body.fn;
  const args = body && Array.isArray(body.args) ? body.args : [];
  if (typeof fn !== 'string' || !Object.prototype.hasOwnProperty.call(handlers, fn)) {
    res.status(400).json({ ok: false, error: 'Permintaan tidak valid.' });
    return;
  }
  try {
    const data = await handlers[fn](...args);
    res.status(200).json({ ok: true, data });
  } catch (e) {
    res.status(200).json({ ok: false, error: (e && e.message) || String(e) });
  }
}
