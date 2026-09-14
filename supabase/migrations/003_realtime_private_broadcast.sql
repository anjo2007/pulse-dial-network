-- 003_realtime_private_broadcast.sql
--
-- Private realtime change signals for the web console and the donor app.
--
-- ARCHITECTURE
--   * Topics are PRIVATE and per-actor:
--       hospital:<hospital_id>   -> members of exactly that tenant
--       donor:<auth_user_id>     -> exactly that donor's user account
--   * Broadcasts carry an EMPTY payload and the event name 'changed'. They are a signal to refetch
--     the authenticated, tenant-scoped REST endpoints - never a data channel. No PII, no donor
--     names, no blood types, no counts travel over the wire.
--   * The server broadcasts from a database trigger, so publishing happens inside the write
--     transaction. This matters on Vercel: firing a publish from the request handler would be an
--     unawaited promise that may be killed when the function response completes.
--   * Clients authenticate Realtime with their own Supabase access token (served by
--     GET /sync/config, which never returns the service-role key). RLS below is the only thing that
--     decides who may subscribe, so a tampered client cannot widen its own reach.
--
-- CAVEAT (explicit): application state is a SINGLE row, so one UPDATE fans out one broadcast per
-- topic present in the row and every client of a tenant is woken by any tenant write. That is
-- acceptable at pilot scale (the payload is empty and clients refetch only what they may read).
-- If write volume grows, move state to per-tenant rows and let the trigger derive a single topic.

-- 1. Deny-by-default for realtime messages, then allow read on the caller's own topic.
alter table realtime.messages enable row level security;

drop policy if exists pulse_realtime_read_own_topic on realtime.messages;
create policy pulse_realtime_read_own_topic
  on realtime.messages
  for select
  to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and (
      (
        realtime.topic() like 'hospital:%'
        and auth.jwt() -> 'app_metadata' ->> 'role' = 'hospital'
        and coalesce(auth.jwt() -> 'app_metadata' ->> 'hospital_id', '') <> ''
        and realtime.topic() = 'hospital:' || (auth.jwt() -> 'app_metadata' ->> 'hospital_id')
      )
      or
      (
        realtime.topic() like 'donor:%'
        and auth.uid() is not null
        and realtime.topic() = 'donor:' || auth.uid()::text
      )
    )
  );

-- No INSERT/UPDATE/DELETE policy is created on purpose: clients are listeners only, so they cannot
-- broadcast into their own (or anyone else's) topic. All writes go through the API.

-- 2. Opaque change signal, best-effort: a broadcast failure must never roll back a dispatch write.
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
        -- Payload is intentionally empty; `true` marks the topic private.
        perform realtime.send('{}'::jsonb, 'changed', topic_record.topic, true);
      exception when others then
        -- Best effort only: log and continue, so a Realtime outage never breaks emergency dispatch.
        raise warning 'pulse realtime broadcast failed for topic %: %', topic_record.topic, sqlerrm;
      end;
    end loop;
  exception when others then
    raise warning 'pulse realtime fan-out failed: %', sqlerrm;
  end;
  return null;
end;
$$;

-- 3. Fire only when the state actually changed (old + new are both scanned above, which is what
--    makes removals - a cancelled request, an unbound device - produce a signal too).
drop trigger if exists pulse_app_state_broadcast on public.app_state;
create trigger pulse_app_state_broadcast
  after update on public.app_state
  for each row
  when (old.state is distinct from new.state)
  execute function public.pulse_broadcast_state_change();
