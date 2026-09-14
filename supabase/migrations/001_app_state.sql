-- Pulse Dial MVP state store. Run this in the Supabase SQL Editor before deployment.
-- Access is server-only; the Vercel API uses the Supabase secret key.
create table if not exists public.app_state (
  id text primary key,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;

-- No browser roles get direct database access. The server-only secret key bypasses RLS.
revoke all on public.app_state from anon, authenticated;
