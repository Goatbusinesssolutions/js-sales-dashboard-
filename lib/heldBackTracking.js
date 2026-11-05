// Tracks, across successive /api/data pulls, which currently-"held-back"
// won deals (see aggregate.js's HELD_BACK_STAGE_IDS — Sales Issues/Closed
// Canceled/Closed Credit Reject) have RESOLVED since the last pull: moved
// out of a held-back stage into a normal one.
//
// Why this needs its own tracking instead of just reading current data: a
// deal's GHL record only ever shows its CURRENT pipeline stage, never its
// stage history, so there's no way to tell "just resolved" from "was
// already fine" without comparing against what was held back last time.
//
// This is for the monthly sales-bonus workflow specifically. Net Sales
// (aggregate.js's netSales block) already always reflects live stage
// status, so a deal that resolves AFTER its month's bonus was paid
// automatically shows up in that month's Net Sales total from then on —
// no code needed for that part, it falls out of recomputing from live data
// every time. What code can't derive after the fact is "which deals
// specifically resolved since I last ran bonuses," for a targeted true-up
// payment — because by the time someone asks, the deal's current stage no
// longer shows it was ever held back. So every /api/data pull snapshots
// the held-back set to KV and diffs it against the previous snapshot:
// whatever disappeared from the held-back set between two pulls just
// resolved, and gets appended to a running resolved-events log with a
// timestamp. index.html's Net Sales section reads that log and lets the
// user filter it by any cutoff date they pick (e.g. "the last time I ran
// bonuses") to see exactly which deals to true up.
//
// Uses the same DASH_CACHE KV namespace as lib/kvCache.js (see
// wrangler.jsonc), under two keys this module owns exclusively:
//   "heldBackSnapshot"   — current held-back set, dealId -> deal info
//   "heldBackResolvedLog" — growing(-ish, capped) log of resolve events
//
// Deliberately only WRITES to KV when the held-back set actually changed
// since the last pull (not on every single cron tick) — /api/data refreshes
// every ~2 minutes (see worker/index.js's scheduled handler) and a job's
// pipeline stage changes far less often than that, so an unconditional
// write would be almost entirely wasted KV write quota for no benefit.
const SNAPSHOT_KEY = 'heldBackSnapshot';
const RESOLVED_LOG_KEY = 'heldBackResolvedLog';

// Bounds on how far back the resolved log is allowed to grow — this is a
// rolling "what happened recently" feed for a monthly bonus workflow, not
// a permanent audit trail, so it's fine (and keeps the KV value small) to
// drop entries once they're old enough that no realistic bonus-run cutoff
// would still need them.
const RESOLVED_LOG_MAX_AGE_DAYS = 400;
const RESOLVED_LOG_MAX_ENTRIES = 2000;

function daysAgo(iso, nowMs) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Infinity; // malformed entry — drop it rather than keep it forever
  return (nowMs - t) / 86400000;
}

/**
 * @param {Object} env Worker env (needs env.DASH_CACHE — same binding
 *   lib/kvCache.js uses)
 * @param {Array} heldBackList current held-back deals, exactly as
 *   aggregate.js's computeDashboard produces them (dashboard.heldBack.list):
 *   [{ id, name, wonDate, monetaryValue, assignedTo, stageName, ... }]
 * @returns {Array} the resolved-events log (after any update this call
 *   made), for attaching to the dashboard response as `resolvedRecently`.
 *   Each entry: { id, name, wonDate, monetaryValue, assignedTo, wasStage,
 *   resolvedAt }.
 */
export async function trackHeldBack(env, heldBackList) {
  const kv = env.DASH_CACHE;
  if (!kv) return []; // no KV binding (e.g. a local/test run) — feature just no-ops rather than erroring

  let snapshot = {};
  let resolvedLog = [];
  try {
    const [snapRaw, logRaw] = await Promise.all([kv.get(SNAPSHOT_KEY), kv.get(RESOLVED_LOG_KEY)]);
    if (snapRaw) snapshot = JSON.parse(snapRaw);
    if (logRaw) resolvedLog = JSON.parse(logRaw);
  } catch (err) {
    // A corrupt or missing snapshot must not break the dashboard — treat
    // it as "no prior snapshot" and start tracking fresh from this pull
    // onward. Worst case, one pull's worth of resolve events is missed;
    // nothing gets duplicated or fabricated.
    snapshot = {};
  }

  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const currentIds = new Set(heldBackList.map((r) => r.id));
  const priorIds = Object.keys(snapshot);

  let changed = false;
  const newlyResolved = [];

  // Resolved: was held back last pull, isn't anymore.
  for (const id of priorIds) {
    if (!currentIds.has(id)) {
      const prior = snapshot[id];
      newlyResolved.push({
        id,
        name: prior.name,
        wonDate: prior.wonDate,
        monetaryValue: prior.monetaryValue,
        assignedTo: prior.assignedTo,
        contactId: prior.contactId,
        wasStage: prior.stageName,
        resolvedAt: nowIso,
      });
      delete snapshot[id];
      changed = true;
    }
  }

  // Newly held back, or still held back but details changed (e.g. a
  // corrected dollar value) — keep the snapshot current either way so the
  // next diff compares against accurate prior state.
  for (const r of heldBackList) {
    const prior = snapshot[r.id];
    if (!prior || prior.stageName !== r.stageName || prior.monetaryValue !== r.monetaryValue || prior.wonDate !== r.wonDate) {
      snapshot[r.id] = {
        name: r.name,
        wonDate: r.wonDate,
        monetaryValue: r.monetaryValue,
        assignedTo: r.assignedTo,
        contactId: r.contactId,
        stageName: r.stageName,
      };
      changed = true;
    }
  }

  if (newlyResolved.length) {
    resolvedLog = [...resolvedLog, ...newlyResolved]
      .filter((e) => daysAgo(e.resolvedAt, nowMs) <= RESOLVED_LOG_MAX_AGE_DAYS)
      .slice(-RESOLVED_LOG_MAX_ENTRIES);
  }

  if (changed) {
    try {
      const writes = [kv.put(SNAPSHOT_KEY, JSON.stringify(snapshot))];
      if (newlyResolved.length) writes.push(kv.put(RESOLVED_LOG_KEY, JSON.stringify(resolvedLog)));
      await Promise.all(writes);
    } catch (err) {
      // A write failure here must not fail the dashboard response — the
      // next pull just re-attempts the same diff against the KV value
      // that's still there (stale, but not wrong).
    }
  }

  return resolvedLog;
}
