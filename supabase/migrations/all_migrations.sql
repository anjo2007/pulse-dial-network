-- ============================================================================
-- Pulse Dial - Complete Consolidated Supabase Database Schema
--
-- This script combines migrations 001, 002, 003, and 004.
-- You can run this directly in the Supabase Dashboard -> SQL Editor.
-- It is completely idempotent and safe to run multiple times.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Migration 001: app_state table
-- ----------------------------------------------------------------------------
create table if not exists public.app_state (
  id text primary key,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;
revoke all on public.app_state from anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2. Migration 002: optimistic concurrency control (version column)
-- ----------------------------------------------------------------------------
alter table public.app_state
  add column if not exists version bigint not null default 0;

alter table public.app_state
  add column if not exists updated_at timestamptz not null default now();

create index if not exists app_state_id_version_idx on public.app_state (id, version);

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'app_state' and policyname = 'app_state_service_role_only'
  ) then
    create policy app_state_service_role_only on public.app_state
      for all to service_role using (true) with check (true);
  end if;
end
$$;

update public.app_state set version = 0 where version is null;

alter table public.app_state
  drop constraint if exists app_state_version_nonnegative;
alter table public.app_state
  add constraint app_state_version_nonnegative check (version >= 0);

-- ----------------------------------------------------------------------------
-- 3. Migration 003: private realtime broadcast signals
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'realtime') then
    execute 'alter table realtime.messages enable row level security;';
    execute 'drop policy if exists pulse_realtime_read_own_topic on realtime.messages;';
    execute 'create policy pulse_realtime_read_own_topic
      on realtime.messages
      for select
      to authenticated
      using (
        realtime.messages.extension in (''broadcast'', ''presence'')
        and (
          (
            realtime.topic() like ''hospital:%''
            and auth.jwt() -> ''app_metadata'' ->> ''role'' = ''hospital''
            and coalesce(auth.jwt() -> ''app_metadata'' ->> ''hospital_id'', '''') <> ''''
            and realtime.topic() = ''hospital:'' || (auth.jwt() -> ''app_metadata'' ->> ''hospital_id'')
          )
          or
          (
            realtime.topic() like ''donor:%''
            and auth.uid() is not null
            and realtime.topic() = ''donor:'' || auth.uid()::text
          )
        )
      );';
  end if;
exception when others then
  raise notice 'Realtime messages table policy skipped: %', sqlerrm;
end
$$;

create or replace function public.pulse_broadcast_state_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  topic_record record;
begin
  begin
    for topic_record in
      with rows as (
        select coalesce(old.state, '{}'::jsonb) as state
        union all
        select coalesce(new.state, '{}'::jsonb) as state
      ),
      entries as (
        select jsonb_array_elements(coalesce(state -> 'requests', '[]'::jsonb)) as item from rows
        union all
        select jsonb_array_elements(coalesce(state -> 'donors', '[]'::jsonb)) as item from rows
      ),
      topics as (
        select distinct
          case
            when coalesce(item ->> 'hospitalId', '') <> '' then 'hospital:' || (item ->> 'hospitalId')
            when coalesce(item ->> 'authUserId', '') <> '' then 'donor:' || (item ->> 'authUserId')
            else null
          end as topic
        from entries
      )
      select topic from topics where topic is not null
    loop
      begin
        perform realtime.send('{}'::jsonb, 'changed', topic_record.topic, true);
      exception when others then
        raise warning 'pulse realtime broadcast failed for topic %: %', topic_record.topic, sqlerrm;
      end;
    end loop;
  exception when others then
    raise warning 'pulse realtime fan-out failed: %', sqlerrm;
  end;
  return null;
end;
$$;

drop trigger if exists pulse_app_state_broadcast on public.app_state;
create trigger pulse_app_state_broadcast
  after update on public.app_state
  for each row
  when (old.state is distinct from new.state)
  execute function public.pulse_broadcast_state_change();

-- ----------------------------------------------------------------------------
-- 4. Migration 004: distributed rate limiting
-- ----------------------------------------------------------------------------
create table if not exists public.rate_limit_windows (
  bucket       text        not null,
  window_start timestamptz not null,
  hits         integer     not null default 0,
  primary key (bucket, window_start)
);

create index if not exists rate_limit_windows_start_idx on public.rate_limit_windows (window_start);

alter table public.rate_limit_windows enable row level security;

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

  delete from public.rate_limit_windows where window_start < now() - interval '1 hour';

  return v_hits <= p_limit;
end;
$$;

revoke all on function public.rate_limit_hit(text, integer, integer) from public;
revoke all on function public.rate_limit_hit(text, integer, integer) from anon;
revoke all on function public.rate_limit_hit(text, integer, integer) from authenticated;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;
