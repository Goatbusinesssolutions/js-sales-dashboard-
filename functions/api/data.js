// Handler for /api/data — called from worker/index.js, which is the actual
// Cloudflare Worker entry point (see wrangler.jsonc). Kept as a standalone
// onRequestGet(context) function (rather than folded directly into the
// router) so it stays a plain, easily-tested unit on its own.
//
// Runs on Cloudflare's Workers runtime, not Node.js: env vars come from
// context.env (never process.env), and the response is a standard Web
// Response object rather than Vercel's res.status()/res.json() helpers.

import { fetchAllWonOpportunities, getUserName } from '../../lib/ghlClient.js';
import { computeDashboard } from '../../lib/aggregate.js';

const DEFAULT_WEEKLY_TARGET = 288000;

// A fixed, made-up URL used only as a lookup key for Cloudflare's edge
// Cache API (caches.default) — deliberately NOT the real request URL, so
// the cached entry doesn't fragment across whatever hostname a request
// actually arrives on (today's workers.dev domain, a custom domain later,
// or the synthetic request worker/index.js's cron `scheduled` warmer uses).
// Every reader and writer of this cache must agree on this exact key.
const CACHE_KEY = new Request('https://js-dashboard-cache.internal/api/data');

function json(data, status, cacheSeconds) {
  const headers = { 'Content-Type': 'application/json' };
  if (cacheSeconds) headers['Cache-Control'] = `public, s-maxage=${cacheSeconds}, stale-while-revalidate=120`;
  return new Response(JSON.stringify(data), { status, headers });
}

// Diagnostic-grade version of the missing-env-var check: says exactly which
// var is missing (not just "one of these two"), and for the ones that ARE
// present, reports a length/whitespace check WITHOUT ever echoing the
// secret value itself — safe to leave in permanently. Takes the already-
// resolved apiKey/locationId strings (not the raw env), since GHL_API_KEY
// is now a Secrets Store binding — an object with a .get() method, not a
// plain string — so it has to be awaited before it can be inspected at all.
function missingEnvDetail(apiKey, locationId) {
  // The `error` string here is what actually reaches the browser (see
  // index.html's fetchAndRender, which only ever displays body.error) — so
  // it must stay GOAT-branded, not name the underlying env vars. The
  // `debug` object below is server-side diagnostic detail only (never
  // rendered in the UI), so it's fine for it to use the real Cloudflare
  // binding names for whoever's actually troubleshooting the config.
  const missingLabels = [];
  if (!apiKey) missingLabels.push('API key');
  if (!locationId) missingLabels.push('location ID');
  return {
    error: `Can't connect to GOAT right now — missing ${missingLabels.join(' and ')} in the server configuration. This needs to be fixed in the Cloudflare setup, not in GOAT itself — contact whoever manages the dashboard.`,
    debug: {
      GHL_API_KEY: apiKey
        ? `present, length ${apiKey.length}${apiKey.trim() !== apiKey ? ' — HAS LEADING/TRAILING WHITESPACE, re-paste it' : ''}`
        : 'MISSING (binding not resolving — Secrets Store secret may still be Pending, or store_id/secret_name in wrangler.jsonc is wrong)',
      GHL_LOCATION_ID: locationId ? `present: "${locationId}"` : 'MISSING (undefined or empty string)',
    },
  };
}

// Does the actual GOAT pull + aggregation — no knowledge of caching or HTTP
// status codes, just "here's what happened." Split out from onRequestGet so
// the cache-lookup/cache-store wrapper below stays simple, and so
// worker/index.js's cron `scheduled` warmer (see wrangler.jsonc's
// triggers.crons) can run the exact same computation a real visitor would,
// just proactively, ahead of anyone actually asking for it.
async function loadDashboard(env) {
  // env.GHL_API_KEY is a Secrets Store binding (see wrangler.jsonc), not a
  // plain string — .get() is what actually fetches the secret value.
  const apiKey = env.GHL_API_KEY ? await env.GHL_API_KEY.get() : undefined;
  const locationId = env.GHL_LOCATION_ID;

  if (!apiKey || !locationId) {
    return { status: 500, body: missingEnvDetail(apiKey, locationId) };
  }

  const weeklyTarget = Number(env.WEEKLY_TARGET) || DEFAULT_WEEKLY_TARGET;
  const monthlyTarget = Number(env.MONTHLY_TARGET) || Math.round((weeklyTarget * 52) / 12);
  const yearlyTarget = Number(env.YEARLY_TARGET) || weeklyTarget * 52;

  const opportunities = await fetchAllWonOpportunities(locationId, apiKey);
  const dashboard = await computeDashboard(opportunities, {
    tz: env.DASHBOARD_TZ || 'America/New_York',
    weeklyTarget,
    monthlyTarget,
    yearlyTarget,
    wonDateFieldId: env.GHL_WON_DATE_FIELD_ID,
    apiKey,
    getUserName,
  });

  return { status: 200, body: dashboard };
}

export async function onRequestGet(context) {
  const { env, ctx } = context;
  const cache = caches.default;

  try {
    // Edge cache check FIRST, before touching GOAT at all. Cloudflare's own
    // cache is the actual fix here — the Cache-Control header alone (below)
    // only ever told the *browser*/downstream CDNs how to treat the
    // response; it never made Cloudflare itself store it, so every page
    // load and every 60s auto-refresh was paying for a full live pull from
    // GOAT. A hit here means either a recent real visitor or
    // worker/index.js's cron warmer already paid that cost — see
    // CACHE_KEY's comment for why this ignores the actual incoming request
    // URL. Deliberately inside this same try/catch as the live pull below
    // (NOT checked before it) — if the Cache API itself ever errors, this
    // must fall back to a normal live pull rather than crashing the whole
    // request with an unhandled exception (which is what a 500 with no
    // JSON body — instead of this function's own error responses — would
    // mean).
    const cached = await cache.match(CACHE_KEY);
    if (cached) return cached;

    const result = await loadDashboard(env);
    // Raised from 60s to 120s to match the cron warmer's new every-2-minutes
    // cadence (see wrangler.jsonc's triggers.crons + worker/index.js's
    // scheduled() — this pull and the much heavier /api/appointments pull
    // used to both land on the same every-2-minutes tick, since the old
    // every-1-minute schedule here necessarily overlapped it; that combined
    // burst was enough to trip GOAT's own rate limit (a 429 even the
    // retry logic in lib/ghlClient.js couldn't fully absorb). Offsetting
    // the two crons onto alternating minutes fixes the collision, but only
    // if this cache lives exactly as long as the gap between this
    // endpoint's own warms — hence 120s, not 60s. A status change in GOAT
    // now takes up to 2 minutes to show up instead of 1; that's the
    // deliberate trade for not periodically failing to load at all. Only a
    // successful pull is worth caching; a transient failure should let the
    // very next request try again rather than serving (or extending) an
    // error for the full window.
    const response = json(result.body, result.status, result.status === 200 ? 120 : undefined);
    if (result.status === 200) {
      // A cache.put failure must not fail the response itself — the
      // visitor already has their (freshly computed, correct) data;
      // losing the ability to cache it just means the next request pays
      // for another live pull, same as if caching didn't exist at all.
      try {
        ctx.waitUntil(cache.put(CACHE_KEY, response.clone()));
      } catch (cacheErr) {
        // ignore — see comment above
      }
    }
    return response;
  } catch (err) {
    return json({ error: 'Failed to load dashboard data', detail: String((err && err.message) || err) }, 502);
  }
}
