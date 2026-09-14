/**
 * The only module that touches the optional @supabase/supabase-js dependency.
 *
 * Loaded lazily so the portal still starts - and still polls - when the package is
 * absent, and so the realtime client never sits in the critical rendering path.
 */
export async function createSupabaseClient(url, key, options) {
  const module = await import('@supabase/supabase-js');
  const createClient = module.createClient ?? module.default?.createClient;
  if (typeof createClient !== 'function') {
    throw new Error('@supabase/supabase-js does not export createClient');
  }
  return createClient(url, key, options);
}
