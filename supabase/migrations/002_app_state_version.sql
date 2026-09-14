-- 002_app_state_version.sql
--
-- Adds optimistic concurrency control to the single-row application state.
--
-- Why: Pulse Dial commits donor dispatch, assignment creation and notification enqueue as one
-- object graph. Without a version column two concurrent serverless invocations can overwrite each
-- other (lost update) and silently drop a dispatch. Every write now performs a compare-and-swap on
-- (id, version) and retries against the freshly loaded state on conflict.
--
-- The notification outbox intentionally lives inside this same row
-- (`state -> 'outbox'`), so "create assignment + enqueue push" is a single atomic commit and
-- cannot half-apply. It is therefore not a separate table.

alter table public.app_state
  add column if not exists version bigint not null default 0;

alter table public.app_state
  add column if not exists updated_at timestamptz not null default now();

-- Supports the conditional update `... where id = $1 and version = $2`.
create index if not exists app_state_id_version_idx on public.app_state (id, version);

-- Only the service role (server) may read or write application state.
alter table public.app_state enable row level security;

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

-- Existing installs: the column arrives as NOT NULL DEFAULT 0, so a row created by 001 keeps
-- version = 0 and is upgraded in place by the first CAS write (0 -> 1). This is explicit because
-- the API distinguishes two states that must never be confused:
--   * no primary row      -> INSERT the seed at version 1 (fresh project)
--   * primary row @ v0    -> CAS UPDATE 0 -> 1 (project migrated from 001)
-- Conflating them caused a permanent 23505 conflict loop on upgraded projects.
update public.app_state set version = 0 where version is null;

alter table public.app_state
  drop constraint if exists app_state_version_nonnegative;
alter table public.app_state
  add constraint app_state_version_nonnegative check (version >= 0);
