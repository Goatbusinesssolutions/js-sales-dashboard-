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
import { kvServe } from '../../lib/kvCache.js';

// ---- weekly target change, effective 2026-10-04 ----
// The business raised its weekly target from $288,000 to $300,000, but
// specifically asked for this to apply "from this week forward" only —
// not retroactively. For the WEEKLY figure itself this needs no special
// handling: aggregate.js's weekly target is only ever compared against the
// CURRENT week-to-date total (there's no stored history of what the target
// used to be on a past week), so simply using the new number from here on
// is already correct — see DEFAULT_WEEKLY_TARGET below.
//
// Monthly and yearly targets are different: they're compared against
// month-to-date / year-to-date totals that span BOTH sides of the change
// (e.g. October 2026 has a few days before the raise and many after). A
// flat monthly/yearly figure derived from only the new weekly number would
// retroactively judge the days before the raise against a target that
// didn't apply yet. Instead, blendedTarget() below sums (old daily rate ×
// working days before the cutoff) + (new daily rate × working days from
// the cutoff onward) for whatever period is being targeted — so the past
// stays evaluated at the old rate and only the portion from the cutoff
// forward reflects the raise. This automatically reduces to a plain
// new-rate target for any period entirely after the cutoff (e.g. all of
// November 2026 onward, or all of 2027), so this doesn't need to be
// revisited once the current month/year fully passes the cutoff.
const TARGET_CUTOFF_DATE = '2026-10-04'; // Sunday starting the week the raise takes effect
const DEFAULT_PRIOR_WEEKLY_TARGET = 288000; // rate that applied BEFORE the cutoff
const DEFAULT_WEEKLY_TARGET = 300000; // rate that applies FROM the cutoff forward

// ---- small date helpers, mirroring aggregate.js's own rules exactly ----
// (Sunday-Saturday week, Monday-Saturday "working days") — duplicated
// rather than imported because aggregate.js doesn't export its internal
// date helpers, and this calculation is specific to the target-blending
// logic above. Keep in sync with aggregate.js if its date rules ever
// change.
function todayStrInTZ(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isWorkingDay(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay() !== 0; // Mon-Sat count, Sunday doesn't
}
function countWorkingDays(startStr, endStr) {
  if (startStr > endStr) return 0;
  let count = 0;
  for (let d = startStr; d <= endStr; d = addDays(d, 1)) {
    if (isWorkingDay(d)) count++;
  }
  return count;
}
function startOfMonth(dateStr) {
  return dateStr.slice(0, 7) + '-01';
}
function endOfMonth(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
function startOfYear(dateStr) {
  return dateStr.slice(0, 4) + '-01-01';
}
function endOfYear(dateStr) {
  return dateStr.slice(0, 4) + '-12-31';
}

// Sums (old daily rate × working days in [periodStart, cutoff)) + (new
// daily rate × working days in [cutoff, periodEnd]) — see the big comment
// above for why.
function blendedTarget(periodStart, periodEnd, oldDailyRate, newDailyRate, cutoff) {
  const oldPortionEnd = addDays(cutoff, -1);
  const oldDays = countWorkingDays(periodStart, oldPortionEnd < periodEnd ? oldPortionEnd : periodEnd);
  const newPortionStart = cutoff > periodStart ? cutoff : periodStart;
  const newDays = countWorkingDays(newPortionStart, periodEnd);
  return Math.round(oldDays * oldDailyRate + newDays * newDailyRate);
}

function json(data, status) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
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
// the KV-cache wrapper below (see lib/kvCache.js) stays simple, and so
// worker/index.js's cron `scheduled` warmer (see wrangler.jsonc's
// triggers.crons) can run the exact same computation a real visitor would,
// just proactively, ahead of anyone actually asking for it. Exported (not
// just used locally) so worker/index.js's scheduled handler can call it
// directly through kvRefresh.
export async function loadDashboard(env) {
  // env.GHL_API_KEY is a Secrets Store binding (see wrangler.jsonc), not a
  // plain string — .get() is what actually fetches the secret value.
  const apiKey = env.GHL_API_KEY ? await env.GHL_API_KEY.get() : undefined;
  const locationId = env.GHL_LOCATION_ID;

  if (!apiKey || !locationId) {
    return { status: 500, body: missingEnvDetail(apiKey, locationId) };
  }

  const tz = env.DASHBOARD_TZ || 'America/New_York';
  const today = todayStrInTZ(tz);

  // weeklyTarget: no blending needed — see the big comment above. This is
  // always just "the current rate," since the weekly tile only ever shows
  // the current week-to-date.
  const weeklyTarget = Number(env.WEEKLY_TARGET) || DEFAULT_WEEKLY_TARGET;

  // monthlyTarget / yearlyTarget: blended across the cutoff — see
  // blendedTarget()'s comment above. An explicit MONTHLY_TARGET/
  // YEARLY_TARGET env var still wins outright if ever set, same as before.
  const priorWeeklyTarget = Number(env.WEEKLY_TARGET_PRIOR) || DEFAULT_PRIOR_WEEKLY_TARGET;
  const oldDailyRate = priorWeeklyTarget / 6;
  const newDailyRate = weeklyTarget / 6;
  const monthlyTarget =
    Number(env.MONTHLY_TARGET) ||
    blendedTarget(startOfMonth(today), endOfMonth(today), oldDailyRate, newDailyRate, TARGET_CUTOFF_DATE);
  const yearlyTarget =
    Number(env.YEARLY_TARGET) ||
    blendedTarget(startOfYear(today), endOfYear(today), oldDailyRate, newDailyRate, TARGET_CUTOFF_DATE);

  const opportunities = await fetchAllWonOpportunities(locationId, apiKey);
  const dashboard = await computeDashboard(opportunities, {
    tz,
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

  try {
    // KV-backed precompute, shared across every Cloudflare colo — see
    // lib/kvCache.js's top comment for why this replaced the earlier
    // per-colo Cache API approach. kvServe reads the "data" key written by
    // worker/index.js's cron warmer (or by itself, on a miss), and only
    // falls through to a live GOAT pull if KV has never been populated.
    return await kvServe(env, ctx, 'data', loadDashboard);
  } catch (err) {
    return json({ error: 'Failed to load dashboard data', detail: String((err && err.message) || err) }, 502);
  }
}
