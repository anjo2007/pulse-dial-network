// Atomic, persistent application state.
//
// Guarantees:
//  * Every write goes through a compare-and-swap on a monotonically increasing `version` column,
//    so two concurrent instances (or two concurrent requests in the same instance) can never
//    clobber each other. On conflict the mutation function is re-applied to the freshly loaded
//    state, up to `maxAttempts` times.
//  * All mutations are additionally serialized by a per-process promise chain, which removes
//    lost-update windows inside a single instance.
//  * Reads are cheap and can be served from a short-lived cache (`maxAgeMs`), while the CAS check
//    on write keeps correctness independent of that cache.
//
// The same object graph holds donors, requests, assignments, devices and the notification outbox,
// which means "create a dispatch assignment + enqueue its notification" is a single atomic commit.

export function createMemoryAdapter(seedState, options = {}) {
  let version = 0;
  let state = structuredClone(seedState);
  const onSave = options.onSave;
  return {
    kind: 'memory',
    remote: false,
    async load() {
      return { state: structuredClone(state), version, exists: true };
    },
    async save(next, expectedVersion) {
      if (typeof onSave === 'function') {
        // Test hook: lets a suite force a CAS conflict.
        const decision = onSave({ expectedVersion, version });
        if (decision === false) return { ok: false, reason: 'conflict' };
      }
      if (expectedVersion !== version) return { ok: false, reason: 'conflict' };
      version += 1;
      state = structuredClone(next);
      return { ok: true, version };
    },
  };
}

export function createSupabaseAdapter(supabase, options = {}) {
  const table = options.table || 'app_state';
  const rowId = options.rowId || 'primary';
  let hasVersionColumn = true;
  return {
    kind: 'supabase',
    remote: true,
    async load() {
      let { data, error } = await supabase.from(table).select('state, version').eq('id', rowId).maybeSingle();
      if (error) {
        if (error.code === '42P01') {
          throw new Error(`Supabase table 'public.${table}' does not exist. Run 'supabase/migrations/001_app_state.sql' and 'supabase/migrations/002_app_state_version.sql'.`);
        }
        if (error.code === '42703' || String(error.message || '').includes('version')) {
          hasVersionColumn = false;
          const fallback = await supabase.from(table).select('state').eq('id', rowId).maybeSingle();
          if (fallback.error) {
            throw new Error(`Supabase could not load application state: ${fallback.error.message}`);
          }
          data = fallback.data ? { state: fallback.data.state, version: 0 } : null;
          error = null;
        } else {
          throw new Error(`Supabase could not load application state: ${error.message}`);
        }
      } else {
        hasVersionColumn = true;
      }
      if (!data) return { state: null, version: 0, exists: false };
      // `exists` is what distinguishes "row is missing, so INSERT the seed" from "row exists with
      // version 0 (pre-002 installs), so CAS-UPDATE it". Treating both as insert caused a permanent
      // 23505 conflict loop after migration 002 added the column to an existing row.
      return { state: data.state, version: Number(data.version ?? 0), exists: true };
    },
    // `exists` is required context, not a guess: a row that already exists at version 0 (install
    // migrated from 001 to 002) must be CAS-UPDATED, never re-inserted.
    async save(next, expectedVersion, { exists = expectedVersion > 0 } = {}) {
      if (!hasVersionColumn) {
        const { error } = await supabase.from(table).upsert({ id: rowId, state: next, updated_at: new Date().toISOString() });
        if (error) throw new Error(`Supabase could not save application state: ${error.message}`);
        return { ok: true, version: (expectedVersion || 0) + 1 };
      }
      if (!exists) {
        const { error } = await supabase.from(table).insert({ id: rowId, state: next, version: 1, updated_at: new Date().toISOString() });
        if (error) {
          if (error.code === '23505') return { ok: false, reason: 'conflict' }; // another instance seeded first
          if (error.code === '42703' || String(error.message || '').includes('version')) {
            hasVersionColumn = false;
            const fallback = await supabase.from(table).upsert({ id: rowId, state: next, updated_at: new Date().toISOString() });
            if (fallback.error) throw new Error(`Supabase could not initialize application state: ${fallback.error.message}`);
            return { ok: true, version: 1 };
          }
          throw new Error(`Supabase could not initialize application state: ${error.message}`);
        }
        return { ok: true, version: 1 };
      }
      const target = expectedVersion + 1;
      const { data, error } = await supabase
        .from(table)
        .update({ state: next, version: target, updated_at: new Date().toISOString() })
        .eq('id', rowId)
        .eq('version', expectedVersion)
        .select('version');
      if (error) {
        if (error.code === '42703' || String(error.message || '').includes('version')) {
          hasVersionColumn = false;
          const fallback = await supabase.from(table).update({ state: next, updated_at: new Date().toISOString() }).eq('id', rowId);
          if (fallback.error) throw new Error(`Supabase could not save application state: ${fallback.error.message}`);
          return { ok: true, version: target };
        }
        throw new Error(`Supabase could not save application state: ${error.message}`);
      }
      if (!Array.isArray(data) || data.length === 0) return { ok: false, reason: 'conflict' };
      return { ok: true, version: target };
    },
  };
}

export class StateConflictError extends Error {
  constructor() {
    super('The application state changed while this operation was in flight. Please retry.');
    this.name = 'StateConflictError';
    this.statusCode = 409;
  }
}

export function createStore({ adapter, seed, maxAttempts = 5, logger } = {}) {
  let state = structuredClone(seed);
  let version = 0;
  let hasRow = false;
  let loaded = false;
  let revision = 0;
  let lastLoadedAt = 0;
  let queue = Promise.resolve();

  function locked(task) {
    const run = queue.then(task, task);
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async function refreshLocked() {
    const snapshot = await adapter.load();
    hasRow = snapshot.exists !== false;
    if (!hasRow) {
      // First boot: seed the store. A concurrent writer racing on the same seed is detected by the
      // adapter (unique key) and simply resolved by reloading.
      state = structuredClone(seed);
      const saved = await adapter.save(state, 0, { exists: false });
      if (!saved.ok) {
        // Another instance seeded first: adopt its row instead of fighting it.
        const retry = await adapter.load();
        hasRow = retry.exists !== false;
        if (!hasRow) throw new StateConflictError();
        state = retry.state ?? structuredClone(seed);
        version = retry.version ?? 0;
      } else {
        version = saved.version;
        hasRow = true;
      }
    } else {
      state = snapshot.state;
      version = snapshot.version;
    }
    loaded = true;
    lastLoadedAt = Date.now();
    return state;
  }

  return {
    adapterKind: adapter.kind,
    get revision() {
      return revision;
    },
    async read({ maxAgeMs = 0 } = {}) {
      return locked(async () => {
        const stale = adapter.remote && (!loaded || Date.now() - lastLoadedAt >= Math.max(maxAgeMs, 0));
        if (!loaded || stale) await refreshLocked();
        return structuredClone(state);
      });
    },
    async mutate(mutator, { maxAttempts: attemptsOverride } = {}) {
      return locked(async () => {
        const attempts = Math.max(1, attemptsOverride ?? maxAttempts);
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          if (adapter.remote) await refreshLocked();
          else if (!loaded) await refreshLocked();

          const draft = structuredClone(state);
          const result = await mutator(draft);
          const saved = await adapter.save(draft, version, { exists: hasRow });
          if (saved.ok) {
            state = draft;
            version = saved.version;
            hasRow = true;
            revision += 1;
            return result;
          }
          if (adapter.remote) {
            logger?.warn?.({ event: 'state_conflict', attempt });
            continue;
          }
        }
        throw new StateConflictError();
      });
    },
  };
}
