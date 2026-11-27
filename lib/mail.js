/** Kirim email lewat Resend. RESEND_FROM harus memakai domain terverifikasi agar bisa mengirim ke semua alamat. */
export async function sendMail(to, subject, text) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY belum diatur.');
  const from = process.env.RESEND_FROM || 'Finance App <onboarding@resend.dev>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text })
  });
  if (!r.ok) throw new Error('Resend gagal (' + r.status + '): ' + (await r.text()));
}
