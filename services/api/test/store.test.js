import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryAdapter, createStore, createSupabaseAdapter } from '../src/store.js';

// Minimal offline stand-in for the Supabase query builder, covering exactly the calls the adapter
// makes: select().eq().maybeSingle(), insert(), update().eq().eq().select().
function createFakeSupabase({ row = null, conflictOnInsert = false, conflictOnceOnUpdate = false } = {}) {
  const db = {
    row: row ? structuredClone(row) : null,
    inserts: 0,
    updates: 0,
    conflicts: 0,
    pendingUpdateConflict: conflictOnceOnUpdate,
  };

  return {
    db,
    from(table) {
      if (table !== 'app_state') throw new Error(`unexpected table: ${table}`);
      const filters = {};
      return {
        select() { return this; },
        eq(column, value) { filters[column] = value; return this; },
        async maybeSingle() {
          if (!db.row || db.row.id !== 'primary') return { data: null, error: null };
          return { data: { state: db.row.state, version: db.row.version, updated_at: db.row.updated_at }, error: null };
        },
        async insert(payload) {
          db.inserts += 1;
          if (db.row && db.row.id === payload.id) {
            return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
          }
          if (conflictOnInsert) {
            // Another instance won the seed race; its row now exists.
            db.row = { id: 'primary', version: 1, state: { donors: [{ id: 'seeded-by-other' }], requests: [], assignments: [], devices: [], outbox: [] } };
            return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
          }
          db.row = structuredClone(payload);
          return { error: null };
        },
        update(payload) {
          const chain = {
            eq(column, value) { filters[column] = value; return chain; },
            async select() {
              db.updates += 1;
              if (db.pendingUpdateConflict) {
                db.pendingUpdateConflict = false;
                db.conflicts += 1;
                if (db.row) db.row.version += 1; // a competing writer committed first
                return { data: [], error: null };
              }
              if (!db.row) return { data: [], error: null };
              // Postgres semantics after 002: the column exists, so an absent value reads as 0.
              if (Number(db.row.version ?? 0) !== Number(filters.version)) return { data: [], error: null };
              db.row = { ...db.row, ...structuredClone(payload) };
              return { data: [{ version: payload.version }], error: null };
            },
          };
          return chain;
        },
      };
    },
  };
}

const seedState = () => ({ donors: [], requests: [], assignments: [], devices: [], outbox: [], marker: 'seed' });

test('persistent state uses compare-and-swap', async (t) => {
  await t.test('a fresh project is seeded exactly once at version 1', async () => {
    const fake = createFakeSupabase();
    const store = createStore({ adapter: createSupabaseAdapter(fake), seed: seedState() });

    const state = await store.read();
    assert.equal(state.marker, 'seed');
    assert.equal(fake.db.inserts, 1);
    assert.equal(fake.db.row.version, 1);

    const result = await store.mutate(draft => { draft.marker = 'mutated'; return 'ok'; });
    assert.equal(result, 'ok');
    assert.equal(fake.db.row.version, 2);
    assert.equal(fake.db.row.state.marker, 'mutated');
    assert.equal(fake.db.inserts, 1, 'a booted project is never re-seeded');
  });

  await t.test('an existing row at version 0 is updated in place, never re-inserted (002 upgrade path)', async () => {
    const legacy = { donors: [], requests: [], assignments: [], devices: [], outbox: [], marker: 'legacy' };
    const fake = createFakeSupabase({ row: { id: 'primary', state: legacy, version: 0 } });
    const store = createStore({ adapter: createSupabaseAdapter(fake), seed: seedState() });

    await store.read();
    assert.equal(fake.db.inserts, 0, 'a pre-existing row must never be inserted again');

    await store.mutate(draft => { draft.marker = 'mutated'; return true; });
    assert.equal(fake.db.updates, 1);
    assert.equal(fake.db.row.version, 1, 'CAS moved the upgraded row from 0 to 1');
    assert.equal(fake.db.row.state.marker, 'mutated');
  });

  await t.test('a legacy row without a version column behaves like version 0', async () => {
    const fake = createFakeSupabase({ row: { id: 'primary', state: { donors: [], requests: [], assignments: [], devices: [], outbox: [], marker: 'unversioned' } } });
    const store = createStore({ adapter: createSupabaseAdapter(fake), seed: seedState() });

    await store.read();
    assert.equal(fake.db.inserts, 0);
    await store.mutate(draft => { draft.marker = 'mutated'; return true; });
    assert.equal(fake.db.updates, 1);
    assert.equal(fake.db.row.version, 1);
  });

  await t.test('a lost seed race adopts the winning row instead of overwriting it', async () => {
    const fake = createFakeSupabase({ conflictOnInsert: true });
    const store = createStore({ adapter: createSupabaseAdapter(fake), seed: seedState() });

    const state = await store.read();
    assert.equal(fake.db.inserts, 1);
    assert.equal(state.donors[0].id, 'seeded-by-other', 'existing project data is preserved');
    assert.equal(state.marker, undefined);

    await store.mutate(draft => { draft.marker = 'mutated'; return true; });
    assert.equal(fake.db.row.version, 2);
  });

  await t.test('a concurrent update is retried against the freshly loaded state', async () => {
    const fake = createFakeSupabase({
      row: { id: 'primary', state: { donors: [], requests: [], assignments: [], devices: [], outbox: [], counter: 0 }, version: 3 },
      conflictOnceOnUpdate: true,
    });
    const store = createStore({ adapter: createSupabaseAdapter(fake), seed: seedState() });

    const result = await store.mutate(draft => { draft.counter = (draft.counter || 0) + 1; return draft.counter; });
    assert.equal(result, 1);
    assert.equal(fake.db.conflicts, 1, 'the first attempt lost the CAS');
    assert.equal(fake.db.row.version, 5, 'version advanced by the competing write and then by ours');
    assert.equal(fake.db.row.state.counter, 1, 'the retry re-applied the mutation to fresh state');
  });

  await t.test('conflicts that never resolve surface as a retryable error', async () => {
    const alwaysConflict = {
      kind: 'supabase',
      remote: true,
      load: async () => ({ state: seedState(), version: 1, exists: true }),
      save: async () => ({ ok: false, reason: 'conflict' }),
    };
    const store = createStore({ adapter: alwaysConflict, seed: seedState(), maxAttempts: 3 });
    await assert.rejects(() => store.mutate(draft => { draft.marker = 'never'; return true; }), /changed while this operation was in flight/);
  });

  await t.test('the memory adapter uses the same exists/version contract', async () => {
    const adapter = createMemoryAdapter({ donors: [], requests: [], assignments: [], devices: [], outbox: [] });
    const snapshot = await adapter.load();
    assert.equal(snapshot.exists, true);
    assert.equal(snapshot.version, 0);

    const saved = await adapter.save({ donors: [], requests: [], assignments: [], devices: [], outbox: [], marker: 'x' }, 0, { exists: true });
    assert.equal(saved.ok, true);
    assert.equal(saved.version, 1);
    const stale = await adapter.save({ donors: [], requests: [], assignments: [], devices: [], outbox: [] }, 0, { exists: true });
    assert.equal(stale.ok, false, 'a stale version is rejected');
  });
});
