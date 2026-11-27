-- Token reset PIN lewat email. Jalankan sekali di Supabase SQL Editor.
-- Yang disimpan hanya hash SHA-256 token, bukan token aslinya.
create table if not exists password_reset (
  token_hash  text primary key,
  user_id     text not null references users(user_id) on delete cascade,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists password_reset_user_idx on password_reset (user_id, created_at desc);

-- Kunci seperti tabel lain: tanpa policy, hanya server (secret key) yang bisa mengakses.
alter table password_reset enable row level security;
revoke all on password_reset from anon, authenticated;
