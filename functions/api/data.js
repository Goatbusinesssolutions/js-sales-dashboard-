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
  const missing = [];
  if (!apiKey) missing.push('GHL_API_KEY');
  if (!locationId) missing.push('GHL_LOCATION_ID');
  return {
    error: `Missing ${missing.join(' and ')}. GHL_API_KEY lives in Cloudflare Secrets Store (check wrangler.jsonc's secrets_store_secrets binding and that the secret's status is Active, not Pending); GHL_LOCATION_ID lives in wrangler.jsonc's vars block.`,
    debug: {
      GHL_API_KEY: apiKey
        ? `present, length ${apiKey.length}${apiKey.trim() !== apiKey ? ' — HAS LEADING/TRAILING WHITESPACE, re-paste it' : ''}`
        : 'MISSING (binding not resolving — Secrets Store secret may still be Pending, or store_id/secret_name in wrangler.jsonc is wrong)',
      GHL_LOCATION_ID: locationId ? `present: "${locationId}"` : 'MISSING (undefined or empty string)',
    },
  };
}

export async function onRequestGet(context) {
  const env = context.env;

  try {
    // env.GHL_API_KEY is a Secrets Store binding (see wrangler.jsonc), not
    // a plain string — .get() is what actually fetches the secret value.
    const apiKey = env.GHL_API_KEY ? await env.GHL_API_KEY.get() : undefined;
    const locationId = env.GHL_LOCATION_ID;

    if (!apiKey || !locationId) {
      return json(missingEnvDetail(apiKey, locationId), 500);
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

    // Cache at Cloudflare's edge so a normal amount of traffic doesn't
    // hammer the GHL API (which paginates through every won opportunity on
    // every uncached hit). Any visitor within this window gets the cached
    // response; the next visitor after it expires triggers a fresh pull.
    // Kept short (1 min) so a status change in GOAT shows up on the next
    // client poll (see REFRESH_INTERVAL_MS in index.html) — raise this if
    // GHL call volume ever becomes a concern.
    return json(dashboard, 200, 60);
  } catch (err) {
    return json({ error: 'Failed to load dashboard data', detail: String((err && err.message) || err) }, 502);
  }
}
