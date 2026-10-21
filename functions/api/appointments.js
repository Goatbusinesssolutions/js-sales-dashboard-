// Handler for /api/appointments — called from worker/index.js, the actual
// Cloudflare Worker entry point (see wrangler.jsonc).
//
// Separate from /api/data (the dollar-totals dashboard) on purpose: this
// endpoint is far more expensive to compute (see the budget note below), so
// it gets its own KV key instead of slowing down or competing with the
// sales-dashboard pull.

import { fetchAllOpportunities, fetchCalendarEvents, fetchTaggedContacts, getUserName } from '../../lib/ghlClient.js';
import { classifyEvents, rollupByDay, mergeWonSalesIntoDaily, describeReason, DEFAULT_ESTIMATE_CALENDAR_ID, DEFAULT_FIX_DATE } from '../../lib/appointments.js';
import { extractWonRecords, rollupSalesDaily } from '../../lib/aggregate.js';
import { repNames } from '../../lib/reps.js';
import { kvServe } from '../../lib/kvCache.js';

// Every typo variant seen in this location's tag list for each family (see
// lib/appointments.js for how these are used: NI/NQ as a fallback when an
// opportunity was deleted by the pre-fix automation instead of having its
// status changed; "inc time" as the ONLY signal for that bucket, since
// Inc. Time doesn't touch the opportunity's status at all). This list has
// to include every tag lib/appointments.js checks for, because
// fetchTaggedContacts only pulls contacts carrying one of these tags in
// the first place — a tag missing here means classifyEvents can never see
// it, live, no matter what the classification code checks for.
const NI_NQ_TAG_NAMES = [
  'not interested', 'no intereest', 'no interest', 'nor interested', 'not intersted',
  'not qualified', 'not qualified credit', 'not qualified does not own',
  'not qualified out of area', 'not qualified repair', 'not qualifed', 'not  qualified',
  'inc time', 'inc. time', 'inconvenient time',
];

function json(data, status) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function todayStrInTZ(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// See the matching helper + comment in functions/api/data.js. Takes the
// already-resolved apiKey/locationId strings, since GHL_API_KEY is now a
// Secrets Store binding (an object with .get()), not a plain string.
function missingEnvDetail(apiKey, locationId) {
  // The `error` string here is what actually reaches the browser (see
  // index.html's fetchAppointments, which only ever displays body.error) —
  // so it must stay GOAT-branded, not name the underlying env vars. The
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

// Does the actual GOAT pull + classification — no knowledge of caching or
// HTTP status codes. Split out from onRequestGet so the KV-cache wrapper
// below (see lib/kvCache.js) stays simple, and so worker/index.js's cron
// `scheduled` warmer (see wrangler.jsonc's triggers.crons) can run this
// same expensive computation proactively instead of a visitor ever
// triggering it live. Exported (not just used locally) so worker/index.js's
// scheduled handler can call it directly through kvRefresh.
export async function loadAppointments(env) {
    // env.GHL_API_KEY is a Secrets Store binding (see wrangler.jsonc), not
    // a plain string — .get() is what actually fetches the secret value.
    const apiKey = env.GHL_API_KEY ? await env.GHL_API_KEY.get() : undefined;
    const locationId = env.GHL_LOCATION_ID;
    if (!apiKey || !locationId) {
      return { status: 500, body: missingEnvDetail(apiKey, locationId) };
    }

    const tz = env.DASHBOARD_TZ || 'America/New_York';
    const calendarId = env.GHL_ESTIMATE_CALENDAR_ID || DEFAULT_ESTIMATE_CALENDAR_ID;
    const fixDate = env.APPOINTMENTS_FIX_DATE || DEFAULT_FIX_DATE;
    // How far back to pull calendar events. Bounded by an env var (not a
    // hardcoded "since the calendar began") because every extra month here
    // is ~1 more GHL API call — see the budget note below.
    const historyDays = Number(env.APPOINTMENTS_HISTORY_DAYS) || 260;

    const todayStr = todayStrInTZ(tz);
    const endMs = Date.now();
    const startMs = endMs - historyDays * 24 * 60 * 60 * 1000;

    // ---- GHL API subrequest budget ----
    // This endpoint pulls ALL opportunities (every status, not just won —
    // classification needs an opportunity's *current* stage), every
    // contact carrying an NI/NQ-family tag, and every event on the
    // Estimate Calendar in the history window. That's roughly 90-120 GHL
    // API calls per pull (vs ~15-20 for /api/data), and it grows
    // slowly over time as the location adds more opportunities/contacts.
    // Cloudflare's free Workers plan caps a single request at 50
    // subrequests, and a pull here already exceeds that on its own —
    // this endpoint requires Workers Paid ($5/mo, 1000-subrequest cap)
    // regardless of caching. If you ever need to cut the per-pull
    // cost instead, lower APPOINTMENTS_HISTORY_DAYS.
    //
    // Fetched ONE AT A TIME, not via Promise.all. This used to run all
    // three pulls concurrently — each one already paces its OWN internal
    // pagination (see PAGE_GAP_MS in lib/ghlClient.js), but running three
    // separately-paced loops at the same time still adds their request
    // rates together against GOAT's one shared per-location rate limit,
    // which is exactly the kind of burst that was tripping the 429 even
    // after every earlier fix to the pacing *within* a single loop. This
    // is slower wall-clock (a pull here can take up to a minute or so) but
    // that time is pure network/await time, not CPU time Cloudflare bills
    // or limits — and it's the only way to actually keep this endpoint's
    // own total request rate to GOAT bounded, rather than tripling it
    // right when the very first call of each loop goes out. A real visitor
    // almost never pays this cost directly, since the cron warmer (see
    // worker/index.js) does it in the background ahead of time via
    // kvRefresh in the overwhelming majority of cases.
    const opportunities = await fetchAllOpportunities(locationId, apiKey);
    const events = await fetchCalendarEvents(locationId, apiKey, calendarId, startMs, endMs);
    const taggedContacts = await fetchTaggedContacts(locationId, apiKey, NI_NQ_TAG_NAMES);

    const classified = classifyEvents(events, opportunities, taggedContacts, { calendarId, todayStr });
    const daily = rollupByDay(classified);
    // Sold ($ and count) is sourced entirely from won opportunities by Won
    // Date — the exact same derivation /api/data uses — not from calendar
    // events, so this section's $ Sold always matches the sales-$ dashboard
    // for the same range, and a won deal with no matching appointment still
    // shows up. `opportunities` here already includes every status (fetched
    // above for classification), so this is free — no extra GHL calls.
    const wonRecords = extractWonRecords(opportunities, { tz });
    mergeWonSalesIntoDaily(daily, rollupSalesDaily(wonRecords));

    // Drill-down lists — a bucket count alone doesn't tell anyone WHICH
    // appointment/contact it's made of. Every bucket except Sold gets one
    // row per classified calendar appointment, newest first (most
    // actionable). Sold is deliberately excluded here and sourced from
    // `sold` below instead — see the big comment on `wonRecords` above:
    // the Sold COUNT in `daily` comes from won-by-Won-Date, not from these
    // calendar-classified 'Sold' events, so a calendar-based Sold list here
    // would occasionally disagree with the Sold count shown next to it.
    // No hard cap: this location's per-bucket counts are in the low
    // hundreds to low thousands at most, so the payload stays small.
    const outcomeEvents = classified
      .filter((r) => r.bucket !== 'Sold')
      .map((r) => ({
        date: r.date,
        bucket: r.bucket,
        title: r.title,
        contactId: r.contactId,
        assignedUserId: r.assignedUserId,
        reason: r.bucket === 'Unresulted' ? describeReason(r.note) : null,
      }))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    // Sold drill-down — sourced from the SAME won-by-Won-Date records that
    // drive the Sold count/value above (wonRecords), not from `classified`,
    // so this list's length always exactly matches the Sold count it's
    // attached to.
    const sold = wonRecords
      .map((r) => ({
        date: r.wonDate,
        title: r.name,
        contactId: r.contactId,
        assignedUserId: r.assignedTo || 'unassigned',
        value: r.monetaryValue,
      }))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    // Resolve any rep not already in the static reps.js cache (e.g. a new
    // hire) via a live lookup, same pattern as /api/data's leaderboard.
    const repIds = new Set();
    for (const day of Object.values(daily)) {
      for (const rep of Object.keys(day.byRep)) repIds.add(rep);
    }
    for (const r of outcomeEvents) repIds.add(r.assignedUserId);
    for (const r of sold) repIds.add(r.assignedUserId);
    const names = { ...repNames };
    await Promise.all([...repIds].map(async (id) => {
      if (id === 'unassigned' || names[id]) return;
      names[id] = await getUserName(id, apiKey);
    }));

    return {
      status: 200,
      body: {
        asOf: new Date().toISOString(),
        tz,
        fixDate,
        calendarId,
        locationId,
        historyStart: new Date(startMs).toISOString().slice(0, 10),
        daily,
        // Per-appointment drill-down data — every classified calendar
        // appointment except Sold (`events`), plus the authoritative
        // won-by-Won-Date Sold list (`sold`). The client unions these by
        // whichever bucket (or virtual group like "Opportunities"/"Demos")
        // the visitor clicked on, filtered to the currently selected date
        // range — see goatContactUrl/openDrilldown in index.html.
        events: outcomeEvents,
        sold,
        reps: names,
      },
    };
}

export async function onRequestGet(context) {
  const { env, ctx } = context;

  try {
    // KV-backed precompute, shared across every Cloudflare colo — see
    // lib/kvCache.js's top comment for why this replaced the earlier
    // per-colo Cache API approach. This is the endpoint that benefits most:
    // a cold pull here is ~90-120 GOAT API calls, so actually serving a
    // precomputed value from KV (instead of only setting a Cache-Control
    // header the browser saw but each colo's own cache may not have had
    // yet) is most of the "why is this slow / why does it sometimes error"
    // fix. kvServe reads the "appointments" key written by
    // worker/index.js's cron warmer (or by itself, on a miss), and only
    // falls through to a live GOAT pull if KV has never been populated.
    return await kvServe(env, ctx, 'appointments', loadAppointments);
  } catch (err) {
    return json({ error: 'Failed to load appointment outcomes', detail: String((err && err.message) || err) }, 502);
  }
}
