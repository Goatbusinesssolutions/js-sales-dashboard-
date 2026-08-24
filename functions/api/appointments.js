// Cloudflare Pages Function — reachable at /api/appointments.
//
// Separate from /api/data (the dollar-totals dashboard) on purpose: this
// endpoint is far more expensive to compute (see the budget note below), so
// it gets its own, much longer edge cache instead of slowing down or
// competing with the sales-dashboard pull.

import { fetchAllOpportunities, fetchCalendarEvents, fetchTaggedContacts, getUserName } from '../../lib/ghlClient.js';
import { classifyEvents, rollupByDay, mergeWonSalesIntoDaily, describeReason, DEFAULT_ESTIMATE_CALENDAR_ID, DEFAULT_FIX_DATE } from '../../lib/appointments.js';
import { extractWonRecords, rollupSalesDaily } from '../../lib/aggregate.js';
import { repNames } from '../../lib/reps.js';

// Every typo variant seen in this location's tag list for each family (see
// lib/appointments.js for how these are used as a fallback when an
// opportunity was deleted by the pre-fix NI/NQ automation instead of
// having its status changed).
const NI_NQ_TAG_NAMES = [
  'not interested', 'no intereest', 'no interest', 'nor interested', 'not intersted',
  'not qualified', 'not qualified credit', 'not qualified does not own',
  'not qualified out of area', 'not qualified repair', 'not qualifed', 'not  qualified',
];

function json(data, status, cacheSeconds) {
  const headers = { 'Content-Type': 'application/json' };
  if (cacheSeconds) headers['Cache-Control'] = `public, s-maxage=${cacheSeconds}, stale-while-revalidate=300`;
  return new Response(JSON.stringify(data), { status, headers });
}

function todayStrInTZ(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export async function onRequestGet(context) {
  const env = context.env;

  try {
    const apiKey = env.GHL_API_KEY;
    const locationId = env.GHL_LOCATION_ID;
    if (!apiKey || !locationId) {
      return json({ error: 'Missing GHL_API_KEY or GHL_LOCATION_ID. Set them under Workers & Pages > your project > Settings > Variables and Secrets.' }, 500);
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
    // API calls per cache miss (vs ~15-20 for /api/data), and it grows
    // slowly over time as the location adds more opportunities/contacts.
    // Cloudflare's free Workers plan caps a single request at 50
    // subrequests, and a cache miss here already exceeds that on its own —
    // this endpoint requires Workers Paid ($5/mo, 1000-subrequest cap)
    // regardless of cache duration. If you ever need to cut the per-pull
    // cost instead, lower APPOINTMENTS_HISTORY_DAYS. The 2-minute cache
    // below is a deliberate tradeoff — short enough that a status change
    // in GOAT shows up within a couple of client polls (see
    // REFRESH_INTERVAL_MS in index.html), long enough that this expensive
    // pull doesn't re-run on literally every poll from every open tab.
    const [opportunities, events, taggedContacts] = await Promise.all([
      fetchAllOpportunities(locationId, apiKey),
      fetchCalendarEvents(locationId, apiKey, calendarId, startMs, endMs),
      fetchTaggedContacts(locationId, apiKey, NI_NQ_TAG_NAMES),
    ]);

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

    // Drill-down list for the "Unresulted" bucket — a count alone doesn't
    // tell anyone which appointment to go fix. Newest first, since those
    // are the most actionable (older ones are more likely already stale/
    // moot). No hard cap: this location's Unresulted count is in the low
    // hundreds, so the payload stays small; revisit if that changes.
    const unresulted = classified
      .filter((r) => r.bucket === 'Unresulted')
      .map((r) => ({
        date: r.date,
        title: r.title,
        contactId: r.contactId,
        assignedUserId: r.assignedUserId,
        reason: describeReason(r.note),
      }))
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    // Resolve any rep not already in the static reps.js cache (e.g. a new
    // hire) via a live lookup, same pattern as /api/data's leaderboard.
    const repIds = new Set();
    for (const day of Object.values(daily)) {
      for (const rep of Object.keys(day.byRep)) repIds.add(rep);
    }
    for (const r of unresulted) repIds.add(r.assignedUserId);
    const names = { ...repNames };
    await Promise.all([...repIds].map(async (id) => {
      if (id === 'unassigned' || names[id]) return;
      names[id] = await getUserName(id, apiKey);
    }));

    return json({
      asOf: new Date().toISOString(),
      tz,
      fixDate,
      calendarId,
      locationId,
      historyStart: new Date(startMs).toISOString().slice(0, 10),
      daily,
      unresulted,
      reps: names,
    }, 200, 120);
  } catch (err) {
    return json({ error: 'Failed to load appointment outcomes', detail: String((err && err.message) || err) }, 502);
  }
}
