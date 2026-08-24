// Appointment-outcome classification and aggregation.
//
// Turns raw calendar events (Estimate Calendar) + opportunities + tagged
// contacts into a per-day rollup of outcome buckets, then lets a caller sum
// any date range (day/week/month/year/custom) out of that rollup and
// compute rates. This mirrors, field-for-field, a Python prototype that was
// validated against a real one-time pull of this location's data (1,627
// calendar events, 6,526 opportunities, 2,605 tagged contacts) before being
// ported here — see the project's design notes for that verification run.
//
// Business rules (confirmed with the client, GHL location WXp6Vk4nCuljh1ZHTP4l):
//   Sold      = opportunity status "won" — dated by WON DATE, not by the
//               calendar appointment's date (see mergeWonSalesIntoDaily).
//               A deal that closed with no matching calendar appointment at
//               all still counts as a sale (and a demo, for rate math) on
//               the day it actually won — this is also why the Sold rep
//               breakdown is attributed to the opportunity's own assignedTo,
//               not the appointment's assignedUserId; they're occasionally
//               different people.
//   DNS       = opportunity status "open" AND pipeline stage is a
//               DNS-equivalent stage (estimate/price already given, still
//               being worked): "Rep Working", "Rehash" (Leads Pipeline), or
//               "Estimate Sent" (Leads Commercial pipeline)
//   No Show   = calendar appointmentStatus "noshow" (folds in "one leg" —
//               GHL has no separate tracking for that distinction)
//   NI        = opportunity status "lost" (post-fix), or a "not interested"
//               family tag when no opportunity exists (pre-fix fallback)
//   NQ        = opportunity status "abandoned" (post-fix), or a
//               "not qualified" family tag when no opportunity exists
//   Unresulted = showed appointment that doesn't fit any bucket above — a
//               data-quality signal, not a business outcome. Excluded from
//               rate math and reported as its own count.
//   Excluded  = calendar appointmentStatus "cancelled" or "invalid"
//   Upcoming  = "confirmed"/"new" status with a future startTime
//
// Before 2026-08-16 the automation that applies NI/NQ tags DELETED the
// opportunity instead of changing its status, so NI/NQ counts (and the tag
// fallback) are incomplete for appointments before that date. Sold/DNS/
// NoShow are unaffected and reconstructable at any date. See computeRates:
// ranges that include any pre-fix date use "modified mode", which drops
// NI/NQ from the math entirely rather than report unreliable numbers.

export const REP_WORKING_STAGE_ID = '6b0d75db-07bf-4fe4-a2f2-2950a0aa2799';
export const REHASH_STAGE_ID = 'ad2903ec-58ee-42f7-9779-2090dedac88f';
export const ESTIMATE_SENT_STAGE_ID = '7f1052d1-278c-470a-b04c-645ce5f8c955';
const DNS_STAGE_IDS = new Set([REP_WORKING_STAGE_ID, REHASH_STAGE_ID, ESTIMATE_SENT_STAGE_ID]);

const NI_TAGS = new Set(['not interested', 'no intereest', 'no interest', 'nor interested', 'not intersted']);
const NQ_TAGS = new Set([
  'not qualified', 'not qualified credit', 'not qualified does not own',
  'not qualified out of area', 'not qualified repair', 'not qualifed', 'not  qualified',
]);

export const DEFAULT_ESTIMATE_CALENDAR_ID = 'esfjNW6NLDhVB7MRgbVb';
export const DEFAULT_FIX_DATE = '2026-08-16';

const BUCKET_KEYS = ['Sold', 'DNS', 'NoShow', 'NI', 'NQ', 'Unresulted', 'Excluded', 'Upcoming'];

// Human-readable names for pipeline stage ids that show up in "Unresulted"
// notes, so a manager reading the drill-down list doesn't have to memorize
// GHL's internal stage ids. Not exhaustive — any stage not in this map
// falls back to showing its raw id.
export const STAGE_NAMES = {
  [REP_WORKING_STAGE_ID]: 'Rep Working',
  [REHASH_STAGE_ID]: 'Rehash',
  [ESTIMATE_SENT_STAGE_ID]: 'Estimate Sent',
  '32897848-90bc-4767-9ea5-b1b70b3c956a': 'Insurance Working',
  '1f6d8d6f-b626-4bcd-9039-e46fdf52ade3': 'Warm Leads',
  '9e09d076-40bd-4bec-80a1-e78b6813125d': 'Closed Canceled',
  '19da1a42-58ee-4e1e-87d8-7bc715aa0c30': 'Audit / Material Pickup / Review / Referrals / Marketing',
  '5af5b875-cbfd-4e9e-a5c5-da19800e2cc3': 'Reset',
  '95d77cb4-8cc1-48b9-b41e-bca33cbb70d4': 'Appointment Scheduled',
  '7ac22062-6566-429d-9969-03a08e80e92d': 'Needs Financing',
};

/** Turn a classifyEvent() note into plain English for the Unresulted drill-down list. */
export function describeReason(note) {
  if (!note) return 'Needs a result on the calendar';
  if (note === 'past-due-unstatused') return "Appointment date passed but was never marked showed / no-show on the calendar";
  if (note === 'no-opp-no-tag') return 'No linked deal, and no Not Interested / Not Qualified tag found';
  if (note === 'tag-fallback-no-opp') return 'Classified from a tag on the contact — no linked deal found';
  if (note === 'superseded-by-later-appointment') return 'Estimate appointment was later reset and re-booked';
  if (note.startsWith('opp-open-other-stage:')) {
    const stageId = note.slice('opp-open-other-stage:'.length);
    return `Linked deal is open in the "${STAGE_NAMES[stageId] || stageId}" stage — needs to move to Rep Working/Rehash, Won, Lost, or Abandoned`;
  }
  return note;
}

function emptyCounts() {
  const c = {};
  for (const k of BUCKET_KEYS) c[k] = 0;
  return c;
}

function buildOppsByContact(opportunities) {
  const map = new Map();
  for (const o of opportunities) {
    const cid = o.contactId;
    if (!cid) continue;
    if (!map.has(cid)) map.set(cid, []);
    map.get(cid).push(o);
  }
  return map;
}

function buildTagsByContact(taggedContacts) {
  const map = new Map();
  for (const c of taggedContacts) {
    map.set(c.id, new Set(c.tags || []));
  }
  return map;
}

// How close (in days) an opportunity's createdAt has to be to another
// opportunity for the same contact — the "anchor", see below — to be
// considered part of the same engagement. Wide enough to catch a same-visit
// multi-estimate (two quotes created minutes apart), narrow enough to
// exclude a repeat customer's old, unrelated job (which in practice show up
// months or years apart, not days).
const OPP_ENGAGEMENT_WINDOW_DAYS = 7;

function daysBetween(dateStrA, dateStrB) {
  if (!dateStrA || !dateStrB) return Infinity;
  const a = new Date(dateStrA + 'T00:00:00Z').getTime();
  const b = new Date(dateStrB + 'T00:00:00Z').getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return Infinity;
  return Math.abs(a - b) / 86400000;
}

/**
 * Pick the opportunity that best represents a contact's current outcome —
 * prefer won, else prefer any opportunity sitting in a DNS-equivalent
 * stage, else the most recently updated.
 *
 * A contact can carry more than one opportunity record for what was really
 * one appointment: e.g. an advisor quotes both a metal-roof option and a
 * shingle-roof option in the same visit, and each gets its own opportunity.
 * If neither has been won yet, "most recently updated" alone is an
 * arbitrary tie-breaker — whichever record someone happened to touch last
 * — and can flip an appointment between DNS and Unresulted depending on
 * which of the two got edited more recently, even though an estimate was
 * genuinely given either way. Checking for DNS-equivalent stages first
 * fixes that: "was an estimate given on at least one of the options" is
 * true regardless of what the other, still-undecided option's stage says.
 *
 * A contact can ALSO carry opportunities from entirely separate, unrelated
 * engagements spread out over time — a repeat customer whose roof job sold
 * a year ago booking a brand-new gutter job today, for instance. "Prefer
 * won" alone can't tell those apart from the same-visit case above: it'll
 * grab the old, already-closed job's opportunity (and dollar value) for a
 * brand new appointment that hasn't been resulted yet, even though a
 * separate, still-open opportunity for the new job exists right there.
 * Fixed the same way as the same-visit case, generalized: first find
 * whichever opportunity was created closest to THIS appointment (the
 * "anchor"), then only pool in siblings created within
 * OPP_ENGAGEMENT_WINDOW_DAYS of that anchor before applying the won / DNS
 * / most-recent tie-break — so an old unrelated deal can't outrank a brand
 * new one just because it happens to be won.
 */
function pickOpportunity(contactId, oppsByContact, apptDateStr) {
  const opps = oppsByContact.get(contactId);
  if (!opps || !opps.length) return null;

  let pool = opps;
  if (apptDateStr && opps.length > 1) {
    let anchor = null;
    for (const o of opps) {
      const created = (o.createdAt || '').slice(0, 10);
      if (!created) continue;
      if (!anchor || daysBetween(created, apptDateStr) < daysBetween((anchor.createdAt || '').slice(0, 10), apptDateStr)) {
        anchor = o;
      }
    }
    if (anchor) {
      const anchorCreated = (anchor.createdAt || '').slice(0, 10);
      pool = opps.filter((o) => daysBetween((o.createdAt || '').slice(0, 10), anchorCreated) <= OPP_ENGAGEMENT_WINDOW_DAYS);
    }
  }

  const won = pool.filter((o) => o.status === 'won');
  if (won.length) return mostRecentlyUpdated(won);

  const dnsStageOpen = pool.filter((o) => o.status === 'open' && DNS_STAGE_IDS.has(o.pipelineStageId));
  if (dnsStageOpen.length) return mostRecentlyUpdated(dnsStageOpen);

  return mostRecentlyUpdated(pool);
}

function mostRecentlyUpdated(opps) {
  let best = null;
  for (const o of opps) {
    if (!best || (o.updatedAt || '') > (best.updatedAt || '')) best = o;
  }
  return best;
}

function tagFallback(contactId, tagsByContact) {
  const tags = tagsByContact.get(contactId);
  if (!tags) return null;
  for (const t of tags) if (NI_TAGS.has(t)) return 'NI';
  for (const t of tags) if (NQ_TAGS.has(t)) return 'NQ';
  return null;
}

/** Classify a single calendar event. todayStr = 'YYYY-MM-DD' pull-time cutoff. */
export function classifyEvent(ev, oppsByContact, tagsByContact, todayStr) {
  const status = ev.appointmentStatus;
  const start = (ev.startTime || '').slice(0, 10);

  if (status === 'noshow') return { bucket: 'NoShow', note: null };
  if (status === 'cancelled') return { bucket: 'Excluded', note: null };
  if (status === 'invalid') {
    // The NI/NQ tag workflows result the appointment as 'invalid' AND set
    // the linked opportunity's status (lost for NI, abandoned for NQ) in
    // the same automation, so once status is 'invalid' the opportunity's
    // status is the authoritative signal for telling NI from NQ. Not every
    // 'invalid' event traces back to that workflow though, so fall back to
    // Excluded when there's no linked opp or it's in some other status.
    const invCid = ev.contactId;
    const invOpp = pickOpportunity(invCid, oppsByContact, start);
    if (invOpp) {
      if (invOpp.status === 'lost') return { bucket: 'NI', note: null };
      if (invOpp.status === 'abandoned') return { bucket: 'NQ', note: null };
    }
    // Pre-fix-date events: the old automation deleted the opportunity
    // instead of changing its status, so there's nothing to look up. Fall
    // back to the same tag-based signal used elsewhere for that era.
    const invFb = tagFallback(invCid, tagsByContact);
    if (invFb) return { bucket: invFb, note: 'tag-fallback-invalid-no-opp' };
    return { bucket: 'Excluded', note: null };
  }
  if (status === 'confirmed' || status === 'new') {
    if (start && start < todayStr) return { bucket: 'Unresulted', note: 'past-due-unstatused' };
    return { bucket: 'Upcoming', note: null };
  }
  if (status !== 'showed') return { bucket: 'Excluded', note: `unknown-status:${status}` };

  const cid = ev.contactId;
  const opp = pickOpportunity(cid, oppsByContact, start);
  if (opp) {
    const ostatus = opp.status;
    const stage = opp.pipelineStageId;
    if (ostatus === 'won') return { bucket: 'Sold', note: null, value: opp.monetaryValue || 0 };
    if (ostatus === 'open' && DNS_STAGE_IDS.has(stage)) return { bucket: 'DNS', note: null };
    if (ostatus === 'lost') return { bucket: 'NI', note: null };
    if (ostatus === 'abandoned') return { bucket: 'NQ', note: null };
    return { bucket: 'Unresulted', note: `opp-open-other-stage:${stage}` };
  }
  const fb = tagFallback(cid, tagsByContact);
  if (fb) return { bucket: fb, note: 'tag-fallback-no-opp' };
  return { bucket: 'Unresulted', note: 'no-opp-no-tag' };
}

/**
 * Classify a raw list of calendar events (any calendar) against
 * opportunities + tagged contacts. Returns a flat array of
 * { date, bucket, assignedUserId, note } — deleted events and events on a
 * different calendar are dropped.
 *
 * Reset-and-retry appointments: when a DNS/Rehash deal gets reset and a
 * NEW appointment is booked to attempt the sale again, that contact ends
 * up with more than one "showed" event on the calendar, all pointing at
 * the SAME opportunity record. Classifying every one of those events off
 * the opportunity's *current* status would let a later successful re-sell
 * retroactively turn the earlier estimate appointment into a "Sold" too —
 * wrong, since that earlier appointment is exactly what DNS means (an
 * estimate was given, not yet sold, reset to try again). So: only the
 * most recent showed appointment for a contact is evaluated against the
 * opportunity/tag state — it "stands on its own." Every earlier showed
 * appointment for that same contact is classified as DNS outright.
 */
export function classifyEvents(events, opportunities, taggedContacts, opts = {}) {
  const calendarId = opts.calendarId || DEFAULT_ESTIMATE_CALENDAR_ID;
  const todayStr = opts.todayStr;
  if (!todayStr) throw new Error('classifyEvents requires opts.todayStr (YYYY-MM-DD)');

  const oppsByContact = buildOppsByContact(opportunities);
  const tagsByContact = buildTagsByContact(taggedContacts);

  const relevant = events.filter((ev) => ev.calendarId === calendarId && !ev.deleted);

  const showedByContact = new Map();
  for (const ev of relevant) {
    if (ev.appointmentStatus !== 'showed') continue;
    if (!showedByContact.has(ev.contactId)) showedByContact.set(ev.contactId, []);
    showedByContact.get(ev.contactId).push(ev);
  }
  const latestShowedEventId = new Map(); // contactId -> id of that contact's most recent showed event
  for (const [cid, evs] of showedByContact.entries()) {
    if (evs.length < 2) continue;
    evs.sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
    latestShowedEventId.set(cid, evs[evs.length - 1].id);
  }

  const results = [];
  for (const ev of relevant) {
    let bucket, note, value;
    const isSupersededShowed =
      ev.appointmentStatus === 'showed' &&
      latestShowedEventId.has(ev.contactId) &&
      latestShowedEventId.get(ev.contactId) !== ev.id;
    if (isSupersededShowed) {
      bucket = 'DNS';
      note = 'superseded-by-later-appointment';
      value = 0;
    } else {
      ({ bucket, note, value } = classifyEvent(ev, oppsByContact, tagsByContact, todayStr));
    }
    results.push({
      id: ev.id,
      date: (ev.startTime || '').slice(0, 10),
      bucket,
      assignedUserId: ev.assignedUserId || 'unassigned',
      contactId: ev.contactId || null,
      title: ev.title || '',
      note,
      // Dollar value of the won opportunity, only meaningful when
      // bucket === 'Sold' (0 for every other bucket). Attributed to the
      // appointment's own date and assigned rep — NOT the opportunity's
      // Won Date/assignedTo used by the sales-$ dashboard above, so this
      // can differ slightly from that section's totals for the same rep.
      value: value || 0,
    });
  }
  return results;
}

/**
 * Roll a flat classified list up into { 'YYYY-MM-DD': { counts, byRep } }.
 * This is the compact payload shape sent to the client — the client sums
 * whatever date range the picker selects out of this object rather than
 * re-fetching per range.
 *
 * 'Sold' entries are deliberately NOT tallied here, even though
 * classifyEvent still labels an appointment tied to a won deal as 'Sold'
 * (that label stays on the flat per-event record — useful metadata). The
 * Sold bucket's count and dollar value come entirely from a separate pass
 * over won opportunities by Won Date instead — see mergeWonSalesIntoDaily,
 * always called right after this. Two reasons: (1) a deal almost never
 * closes on the same day as its estimate appointment, so pinning $ Sold to
 * the appointment date makes it disagree with the sales-$ dashboard (which
 * is Won-Date based) for the exact same period — the business wants these
 * two numbers to always match; (2) a deal that closed with no matching
 * calendar appointment at all (no estimate ever booked, or booked outside
 * this calendar) previously never showed up as a sale anywhere in this
 * section — now it does, credited as a sale (and a demo, for the rate math)
 * on the day it actually won.
 */
export function rollupByDay(classified) {
  const days = {};
  for (const r of classified) {
    if (!r.date) continue;
    if (r.bucket === 'Sold') continue;
    if (!days[r.date]) days[r.date] = { counts: emptyCounts(), byRep: {}, soldValue: 0, byRepValue: {} };
    const day = days[r.date];
    day.counts[r.bucket] = (day.counts[r.bucket] || 0) + 1;
    const rep = r.assignedUserId || 'unassigned';
    if (!day.byRep[rep]) day.byRep[rep] = emptyCounts();
    day.byRep[rep][r.bucket] = (day.byRep[rep][r.bucket] || 0) + 1;
  }
  return days;
}

/**
 * Merge a "won opportunities by Won Date" rollup — the SAME data structure
 * that powers the sales-$ dashboard's daily series (rollupSalesDaily /
 * extractWonRecords in lib/aggregate.js: `{ 'YYYY-MM-DD': { total, count,
 * byRep: { userId: { total, count } } } }`) — into an appointment-outcomes
 * daily rollup's Sold bucket. This is the ONLY source rollupByDay's Sold
 * count/value get filled from, which is what guarantees $ Sold here always
 * exactly matches the sales-$ dashboard for the same date range: same
 * opportunities, same Won Date extraction, same math, not a coincidence.
 *
 * Mutates and returns `daily`. Adds a day entry if one doesn't already
 * exist (a won deal can land on a date with zero calendar appointments at
 * all — it still needs to show up).
 */
export function mergeWonSalesIntoDaily(daily, salesDaily) {
  for (const date of Object.keys(salesDaily || {})) {
    const s = salesDaily[date];
    if (!s || !s.count) continue;
    if (!daily[date]) daily[date] = { counts: emptyCounts(), byRep: {}, soldValue: 0, byRepValue: {} };
    const day = daily[date];
    day.counts.Sold = (day.counts.Sold || 0) + s.count;
    day.soldValue = (day.soldValue || 0) + (s.total || 0);
    for (const rep of Object.keys(s.byRep || {})) {
      // rollupSalesDaily keys unassigned deals 'UNASSIGNED'; this module's
      // convention (assignedUserId || 'unassigned') is lowercase — normalize
      // so an unassigned rep doesn't split into two separate rows client-side.
      const repKey = rep === 'UNASSIGNED' ? 'unassigned' : rep;
      if (!day.byRep[repKey]) day.byRep[repKey] = emptyCounts();
      day.byRep[repKey].Sold = (day.byRep[repKey].Sold || 0) + s.byRep[rep].count;
      day.byRepValue[repKey] = (day.byRepValue[repKey] || 0) + (s.byRep[rep].total || 0);
    }
  }
  return daily;
}

/** Sum a daily rollup over [startDate, endDate] inclusive, both 'YYYY-MM-DD'. */
export function sumRange(daily, startDate, endDate) {
  const counts = emptyCounts();
  const byRep = {};
  let soldValue = 0;
  const byRepValue = {};
  for (const date of Object.keys(daily)) {
    if (date < startDate || date > endDate) continue;
    const day = daily[date];
    for (const k of BUCKET_KEYS) counts[k] += day.counts[k] || 0;
    soldValue += day.soldValue || 0;
    for (const rep of Object.keys(day.byRep)) {
      if (!byRep[rep]) byRep[rep] = emptyCounts();
      for (const k of BUCKET_KEYS) byRep[rep][k] += day.byRep[rep][k] || 0;
    }
    for (const rep of Object.keys(day.byRepValue || {})) {
      byRepValue[rep] = (byRepValue[rep] || 0) + day.byRepValue[rep];
    }
  }
  return { counts, byRep, soldValue, byRepValue };
}

/**
 * Full mode (ranges entirely on/after the fix date): NI/NQ trusted.
 *   Opp rate       = (Sold+DNS+NI) / all resulted (Sold+DNS+NoShow+NI+NQ)
 *   Demo-to-opp rate = (Sold+DNS) / (Sold+DNS+NI)
 *   Close rate     = Sold / (Sold+DNS+NI)
 *
 * Modified mode (range touches any pre-fix date): NI/NQ unreliable
 * (opportunity could've been silently deleted), so they're dropped from
 * the math entirely rather than reported wrong.
 *   Modified demo rate  = (Sold+DNS) / (Sold+DNS+NoShow)
 *   Modified close rate = Sold / (Sold+DNS)
 */
export function computeRates(counts, mode) {
  const sold = counts.Sold || 0;
  const dns = counts.DNS || 0;
  const noShow = counts.NoShow || 0;
  const ni = counts.NI || 0;
  const nq = counts.NQ || 0;
  const resulted = sold + dns + noShow + ni + nq;

  if (mode === 'full') {
    const oppPool = sold + dns + ni;
    return {
      mode: 'full',
      resulted,
      oppRate: resulted ? oppPool / resulted : null,
      demoToOppRate: oppPool ? (sold + dns) / oppPool : null,
      closeRate: oppPool ? sold / oppPool : null,
    };
  }

  const demoPool = sold + dns + noShow;
  return {
    mode: 'modified',
    resulted,
    modifiedDemoRate: demoPool ? (sold + dns) / demoPool : null,
    modifiedCloseRate: (sold + dns) ? sold / (sold + dns) : null,
  };
}

/** Whole-range mode: 'full' only if every day in range is >= fixDate. */
export function modeForRange(startDate, fixDate) {
  return startDate >= fixDate ? 'full' : 'modified';
}

/** Build the full report (overall + per-rep) for one date range. */
export function reportForRange(daily, startDate, endDate, fixDate) {
  const { counts, byRep } = sumRange(daily, startDate, endDate);
  const mode = modeForRange(startDate, fixDate);
  const rates = computeRates(counts, mode);
  const reps = {};
  for (const rep of Object.keys(byRep)) {
    reps[rep] = { counts: byRep[rep], rates: computeRates(byRep[rep], mode) };
  }
  return { startDate, endDate, mode, counts, rates, reps };
}
