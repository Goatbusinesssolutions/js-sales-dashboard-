// Shared KV-backed precompute cache for the dashboard's two heavy,
// GOAT-backed endpoints (/api/data and /api/appointments).
//
// This replaces the earlier approach of using Cloudflare's per-colo Cache
// API (caches.default): that cache is fast once warm, but each of
// Cloudflare's 300+ edge locations keeps its own independent copy, so a
// visitor landing on a colo the cron warmer hadn't happened to run through
// yet still paid for a live, multi-second-to-a-minute pull from GOAT.
// Workers KV is globally replicated instead — once ANY colo writes a
// value, every colo can read it — so a visitor is reliably served the
// precomputed result no matter which edge they land on. Requires the
// DASH_CACHE binding declared in wrangler.jsonc's kv_namespaces (see that
// file's comment for the Cloudflare dashboard-wipe issue this sidesteps by
// being committed to git instead of only added by hand).
//
// Value format: `${13-digit epoch ms}|${JSON body}` — the leading
// timestamp lets kvServe() tell how old a stored value is without a
// second KV read, so it can decide whether to also kick off a background
// refresh while still serving the (slightly stale) value immediately.

const STALE_AFTER_MS = 6 * 60 * 1000; // serve-stale-while-refreshing past this age

function encode(body) {
  return `${String(Date.now()).padStart(13, '0')}|${JSON.stringify(body)}`;
}

function decode(raw) {
  const sep = raw.indexOf('|');
  return { savedAt: Number(raw.slice(0, sep)) || 0, body: JSON.parse(raw.slice(sep + 1)) };
}

function json(body, status, cacheTag) {
  const headers = { 'Content-Type': 'application/json' };
  if (cacheTag) headers['X-Dash-Cache'] = cacheTag; // diagnostic only — see "Check after every deploy" note below
  return new Response(JSON.stringify(body), { status, headers });
}

// Called by each endpoint's onRequestGet for a real visitor. Reads KV
// first; on a hit, returns it immediately and — only if the value is old
// enough to be worth getting ahead of the next cron tick — kicks off a
// non-blocking refresh via ctx.waitUntil rather than making the visitor
// wait on it. On a miss (e.g. right after this binding is first added, or
// KV was somehow cleared, before any cron tick has run) falls back to a
// live loader() call so the endpoint still works rather than erroring,
// and seeds KV with that result for the next request.
export async function kvServe(env, ctx, key, loader) {
  const kv = env.DASH_CACHE;
  if (kv) {
    try {
      const raw = await kv.get(key);
      if (raw) {
        const { savedAt, body } = decode(raw);
        if (Date.now() - savedAt > STALE_AFTER_MS) {
          ctx.waitUntil(kvRefresh(env, key, loader).catch(() => {}));
        }
        return json(body, 200, 'kv');
      }
    } catch (err) {
      // A KV read failure must not break the endpoint — fall through to a
      // live pull, same as a genuine miss.
    }
  }

  const result = await loader(env);
  if (result.status === 200 && kv) {
    try {
      ctx.waitUntil(kv.put(key, encode(result.body)));
    } catch (err) {
      // A KV write failure must not fail the response itself — the visitor
      // already has their (freshly computed, correct) data.
    }
  }
  return json(result.body, result.status, 'live');
}

// Called unconditionally by worker/index.js's cron `scheduled` handler —
// always does a fresh GOAT pull and writes it to KV, keeping every colo's
// view of the data current roughly every 2 minutes regardless of whether
// any visitor's request happened to trip kvServe's own staleness check in
// between. Also used by kvServe's background-refresh path above.
export async function kvRefresh(env, key, loader) {
  const kv = env.DASH_CACHE;
  const result = await loader(env);
  if (result.status === 200 && kv) {
    await kv.put(key, encode(result.body));
  }
  return result;
}
