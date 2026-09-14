-- 004_rate_limit.sql
--
-- Distributed rate limiting for credential endpoints (hospital login, donor OTP start/verify,
-- dispatch worker). Serverless instances cannot share an in-process counter, so the window lives
-- here as a single atomic upsert.
--
-- Keys are a keyed HMAC produced by the API (never a raw email, phone number or credential), so this
-- table can hold no personal data. Rows are plain counters.
--
-- IMPORTANT: the API fails CLOSED. If this function is missing, a production deployment refuses all
-- authentication traffic (HTTP 503) instead of allowing unlimited attempts. Apply this migration.

create table if not exists public.rate_limit_windows (
  bucket       text        not null,
  window_start timestamptz not null,
  hits         integer     not null default 0,
  primary key (bucket, window_start)
);

create index if not exists rate_limit_windows_start_idx on public.rate_limit_windows (window_start);

alter table public.rate_limit_windows enable row level security;
-- No policies: only the service role (which bypasses RLS) may touch these counters.

create or replace function public.rate_limit_hit(
  p_key text,
  p_window_seconds integer,
  p_limit integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window timestamptz;
  v_hits integer;
begin
  if p_key is null or length(p_key) = 0 or p_window_seconds is null or p_window_seconds < 1 or p_limit is null then
    raise exception 'rate_limit_hit requires a key, a positive window and a limit';
  end if;

  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);

  insert into public.rate_limit_windows (bucket, window_start, hits)
  values (p_key, v_window, 1)
  on conflict (bucket, window_start)
    do update set hits = public.rate_limit_windows.hits + 1
  returning hits into v_hits;

  -- Opportunistic retention: windows are only meaningful for a few minutes.
  delete from public.rate_limit_windows where window_start < now() - interval '1 hour';

  return v_hits <= p_limit;
end;
$$;

revoke all on function public.rate_limit_hit(text, integer, integer) from public;
revoke all on function public.rate_limit_hit(text, integer, integer) from anon;
revoke all on function public.rate_limit_hit(text, integer, integer) from authenticated;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;
