// Business logic for turning a flat list of GHL "won" opportunities into
// every number the dashboard shows. This mirrors, exactly, the manual
// methodology worked out (and debugged) by hand earlier: full pagination
// (never a recency-sorted partial pull), the Won Date custom field read as
// a UTC-only date (never localized), a Sunday-Saturday week, and Mon-Sat
// "working days" for pacing denominators only (Sunday sales still count in
// every dollar total, they just don't count toward the day count).

import { repNames } from './reps.js';

// The "Won Date" custom field id is specific to this GHL location's custom
// field schema. Pass opts.wonDateFieldId to override if you point this at a
// different sub-account; falls back to lastStatusChangeAt for any record
// missing this field (less accurate, since it's a proxy for "when the deal
// was won"). This module reads no environment variables directly, so it
// works unmodified on any runtime (Node/Vercel, Cloudflare Workers, etc.) —
// the caller is responsible for reading env vars and passing them in.
const DEFAULT_WON_DATE_FIELD_ID = 'd4CycZZLInE2PuqJO9uG';

// ---- date helpers (all operate on 'YYYY-MM-DD' strings, UTC-anchored) ----

function todayStrInTZ(tz, when) {
  // en-CA formats as YYYY-MM-DD. `when` defaults to now; pass a Date (or
  // anything `new Date()` accepts) to get the LOCAL calendar date of some
  // other instant instead — needed for turning a raw UTC timestamp like
  // lastStatusChangeAt into "what day was it in the shop" rather than
  // "what day was it in UTC" (those disagree every evening after ~8pm ET).
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(when ? new Date(when) : new Date());
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function dayOfWeekUTC(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay(); // 0 = Sun ... 6 = Sat
}

function isWorkingDay(dateStr) {
  return dayOfWeekUTC(dateStr) !== 0; // Mon-Sat count, Sunday doesn't
}

function countWorkingDays(startStr, endStr) {
  let count = 0;
  let d = startStr;
  while (d <= endStr) {
    if (isWorkingDay(d)) count++;
    d = addDays(d, 1);
  }
  return count;
}

function startOfWeekSunday(dateStr) {
  return addDays(dateStr, -dayOfWeekUTC(dateStr));
}

function startOfMonth(dateStr) {
  return dateStr.slice(0, 7) + '-01';
}

function endOfMonth(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day of this month
  return last.toISOString().slice(0, 10);
}

function startOfYear(dateStr) {
  return dateStr.slice(0, 4) + '-01-01';
}

function endOfYear(dateStr) {
  return dateStr.slice(0, 4) + '-12-31';
}

function shiftMonth(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + delta, 1));
  return dt.toISOString().slice(0, 10);
}

// ---- opportunity -> won date extraction ----

// Which field is "Won Date" ground truth. Per the business: the opportunity
// status flips to 'won' automatically and instantly the moment a contract
// is signed — no rep, no manual entry, no lag. That makes lastStatusChangeAt
// the authoritative signal (it fires the instant the real-world event
// happens), so it's primary. The customFields Won Date is a separate,
// manually-maintained field: across the full history, 47% of won
// opportunities don't even have it set, and where both exist they agree on
// the date 92% of the time (the rest are mostly a 1-day drift from the
// UTC-vs-local boundary below, plus a small number of genuine backdated
// corrections) — not reliable enough to lead on. It's kept only as a
// last-resort fallback for the rare case lastStatusChangeAt is itself
// missing.
//
// lastStatusChangeAt is a real moment in time (not a deliberately-chosen
// calendar date the way the custom field is), so it must be converted to
// the business's own timezone before slicing off a date — a contract
// signed at 9:56pm ET still shows as the NEXT UTC day if you slice the raw
// ISO string, which would misfile every evening signing by one day.
function extractWonDate(opp, wonDateFieldId, tz) {
  if (opp.lastStatusChangeAt) {
    return { date: todayStrInTZ(tz, opp.lastStatusChangeAt), usedFallback: false };
  }
  const fields = opp.customFields || [];
  const wonField = fields.find((f) => f.id === wonDateFieldId && f.fieldValueDate != null);
  if (wonField) {
    // Date-only custom field: stored as epoch-ms at UTC midnight. Do NOT
    // .astimezone()/localize this — that shifts the calendar date backward.
    return { date: new Date(wonField.fieldValueDate).toISOString().slice(0, 10), usedFallback: true };
  }
  return { date: null, usedFallback: null };
}

// ---- name resolution ----

async function resolveName(userId, cache, apiKey, getUserName) {
  if (!userId) return 'Unassigned';
  if (repNames[userId]) return repNames[userId];
  if (cache.has(userId)) return cache.get(userId);
  const name = await getUserName(userId, apiKey);
  cache.set(userId, name);
  return name;
}

// ---- core aggregation ----

function sumRange(records, start, end) {
  const rows = records.filter((r) => r.wonDate >= start && r.wonDate <= end);
  const value = rows.reduce((s, r) => s + (r.monetaryValue || 0), 0);
  return { value: round2(value), count: rows.length, rows };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

function pctChange(current, previous) {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

async function leaderboardFor(rows, cache, apiKey, getUserName) {
  const byRep = new Map();
  for (const r of rows) {
    const key = r.assignedTo || 'UNASSIGNED';
    if (!byRep.has(key)) byRep.set(key, { total: 0, count: 0 });
    const agg = byRep.get(key);
    agg.total += r.monetaryValue || 0;
    agg.count += 1;
  }
  const out = [];
  for (const [userId, agg] of byRep.entries()) {
    const name = userId === 'UNASSIGNED' ? 'Unassigned' : await resolveName(userId, cache, apiKey, getUserName);
    out.push({ name, total: round2(agg.total), count: agg.count });
  }
  out.sort((a, b) => b.total - a.total);
  return out;
}

/**
 * Day-by-day rollup of every won record, with a per-rep breakdown —
 * { 'YYYY-MM-DD': { total, count, byRep: { userId: { total, count } } } }.
 * This is the raw material for the historical period picker: instead of
 * pre-baking every possible week/month/custom range server-side, the
 * client sums whatever range the picker selects out of this object (same
 * pattern the appointment-outcomes section uses). No extra GHL API calls
 * — this just re-slices `records`, already pulled for the live numbers.
 */
function rollupSalesDaily(records) {
  const daily = {};
  for (const r of records) {
    const d = r.wonDate;
    if (!daily[d]) daily[d] = { total: 0, count: 0, byRep: {} };
    const day = daily[d];
    day.total += r.monetaryValue || 0;
    day.count += 1;
    const rep = r.assignedTo || 'UNASSIGNED';
    if (!day.byRep[rep]) day.byRep[rep] = { total: 0, count: 0 };
    day.byRep[rep].total += r.monetaryValue || 0;
    day.byRep[rep].count += 1;
  }
  for (const d of Object.keys(daily)) {
    daily[d].total = round2(daily[d].total);
    for (const rep of Object.keys(daily[d].byRep)) {
      daily[d].byRep[rep].total = round2(daily[d].byRep[rep].total);
    }
  }
  return daily;
}

/** userId -> display name for every rep who appears in `records`, for the client-side leaderboard. */
async function buildRepNameMap(records, cache, apiKey, getUserName) {
  const ids = new Set();
  for (const r of records) if (r.assignedTo) ids.add(r.assignedTo);
  const map = {};
  await Promise.all([...ids].map(async (id) => {
    map[id] = await resolveName(id, cache, apiKey, getUserName);
  }));
  return map;
}

/**
 * Turn a flat list of raw GHL opportunities (any status, any pipeline) into
 * just the won ones, each reduced to its Won Date + dollar value + owning
 * rep. This is the single source of truth for "what sold and when" — every
 * other section of the product that needs won-by-date numbers (the
 * appointment-outcomes $ Sold figure, specifically — see
 * mergeWonSalesIntoDaily in lib/appointments.js) calls this SAME function
 * rather than re-deriving its own version, specifically so those numbers
 * can never drift apart from this dashboard's own totals.
 *
 * @param {Array} opportunities raw GHL opportunity objects, any status
 * @param {Object} opts { tz, wonDateFieldId }
 */
function extractWonRecords(opportunities, opts = {}) {
  const tz = opts.tz || 'America/New_York';
  const wonDateFieldId = opts.wonDateFieldId || DEFAULT_WON_DATE_FIELD_ID;
  return opportunities
    .filter((o) => o.status === 'won')
    .map((o) => {
      const { date, usedFallback } = extractWonDate(o, wonDateFieldId, tz);
      return {
        id: o.id,
        name: o.name,
        monetaryValue: o.monetaryValue || 0,
        wonDate: date,
        usedFallback,
        assignedTo: o.assignedTo || null,
      };
    })
    .filter((r) => r.wonDate);
}

/**
 * @param {Array} opportunities raw GHL opportunity objects (status=won, all pipelines)
 * @param {Object} opts { tz, weeklyTarget, monthlyTarget, yearlyTarget, apiKey, getUserName }
 */
async function computeDashboard(opportunities, opts) {
  const tz = opts.tz || 'America/New_York';
  // opts.today (a 'YYYY-MM-DD' string) overrides "now" — used for tests and
  // for replaying what the dashboard would have shown on a past date.
  const today = opts.today || todayStrInTZ(tz);
  const yesterday = addDays(today, -1);
  const wonDateFieldId = opts.wonDateFieldId || DEFAULT_WON_DATE_FIELD_ID;

  const records = extractWonRecords(opportunities, { tz, wonDateFieldId });

  // ---- day / week windows ----
  const thisWeekStart = startOfWeekSunday(today);
  const lastWeekStart = addDays(thisWeekStart, -7);
  const lastWeekEnd = addDays(thisWeekStart, -1);

  const todayAgg = sumRange(records, today, today);
  const yesterdayAgg = sumRange(records, yesterday, yesterday);
  const thisWeekAgg = sumRange(records, thisWeekStart, today);
  const lastWeekAgg = sumRange(records, lastWeekStart, lastWeekEnd);

  // ---- month windows ----
  const mStart = startOfMonth(today);
  const mEnd = endOfMonth(today);
  const lastMonthAnchor = shiftMonth(today, -1);
  const lastMonthStart = startOfMonth(lastMonthAnchor);
  const lastMonthEnd = endOfMonth(lastMonthAnchor);
  const dayOfMonth = Number(today.slice(8, 10));
  const lastMonthSamePeriodEnd = (() => {
    const candidate = addDays(lastMonthStart, dayOfMonth - 1);
    return candidate > lastMonthEnd ? lastMonthEnd : candidate;
  })();

  const mtdAgg = sumRange(records, mStart, today);
  const lastMonthSamePeriodAgg = sumRange(records, lastMonthStart, lastMonthSamePeriodEnd);
  const fullLastMonthAgg = sumRange(records, lastMonthStart, lastMonthEnd);

  // ---- year windows ----
  const yStart = startOfYear(today);
  const yEnd = endOfYear(today);
  const ytdAgg = sumRange(records, yStart, today);

  // ---- pacing ----
  // "Elapsed working days" drives the average-$-per-working-day that the
  // whole pacing/projection/catch-up system is built on. It must only count
  // COMPLETE days — today is still in progress (the business day isn't
  // over), so its revenue-so-far is a fraction of a normal day's, not a
  // whole one. Dividing that partial number into an average that treats
  // today as fully elapsed systematically understates the run-rate, which
  // understates the projected total, which makes "behind pace" trigger (or
  // look worse) even on a day that's actually going fine. So: the average
  // is computed from records THROUGH YESTERDAY only, over days-elapsed
  // THROUGH YESTERDAY only — today counts as a day still REMAINING (it can
  // still add to the total before the period ends), not as data points in
  // the average. Actual progress-so-far (`total`, used for "reached" and
  // "remaining to target") still includes today's real dollars — that part
  // isn't an average, so a partial day doesn't distort it.
  function elapsedThroughYesterday(periodStart, periodEnd) {
    // yesterday can fall before periodStart (today is the period's first
    // day) or, in principle, after periodEnd — clamp both ways.
    if (yesterday < periodStart) return null; // no complete days yet this period
    const end = yesterday > periodEnd ? periodEnd : yesterday;
    return { workingDays: countWorkingDays(periodStart, end), value: sumRange(records, periodStart, end).value };
  }

  const weekEnd = addDays(thisWeekStart, 6);
  const weekWorkingDaysTotal = countWorkingDays(thisWeekStart, weekEnd); // always 6 (Mon-Sat)
  const weekElapsed = elapsedThroughYesterday(thisWeekStart, weekEnd);
  const weekWorkingDaysElapsed = weekElapsed ? weekElapsed.workingDays : 0;
  const weekAvgPerWorkingDay = weekElapsed && weekElapsed.workingDays ? weekElapsed.value / weekElapsed.workingDays : 0;
  const projectedWeekTotal = weekAvgPerWorkingDay * weekWorkingDaysTotal;

  const monthWorkingDaysTotal = countWorkingDays(mStart, mEnd);
  const monthElapsed = elapsedThroughYesterday(mStart, mEnd);
  const monthWorkingDaysElapsed = monthElapsed ? monthElapsed.workingDays : 0;
  const monthAvgPerWorkingDay = monthElapsed && monthElapsed.workingDays ? monthElapsed.value / monthElapsed.workingDays : 0;
  const projectedMonthTotal = monthAvgPerWorkingDay * monthWorkingDaysTotal;

  const yearWorkingDaysTotal = countWorkingDays(yStart, yEnd);
  const yearElapsed = elapsedThroughYesterday(yStart, yEnd);
  const yearWorkingDaysElapsed = yearElapsed ? yearElapsed.workingDays : 0;
  const yearAvgPerWorkingDay = yearElapsed && yearElapsed.workingDays ? yearElapsed.value / yearElapsed.workingDays : 0;
  const projectedYearTotal = yearAvgPerWorkingDay * yearWorkingDaysTotal;

  // Average working days per calendar month across the year, for expressing
  // a yearly catch-up figure in "$/month" terms.
  const avgWorkingDaysPerMonth = yearWorkingDaysTotal / 12;

  /**
   * How much more per working day (and, where it means something, per week /
   * per month) is needed for the REST of a period to still land on target by
   * the period's end — as distinct from "reached" (already hit it) and
   * distinct from the raw %-of-target-so-far (which looks "behind" early in
   * any period even when the current run-rate is fully on track).
   *
   * onPace   = projected period-end total (at the CURRENT run-rate) already
   *            clears the target — no change of pace needed.
   * behind   = projected total falls short; catchUp gives the required
   *            forward run-rate to still close the gap by period end.
   */
  function paceBlock(total, target, projectedTotal, workingDaysLeft, breakdown) {
    if (!target) return { onPace: null, catchUp: null };
    if (total >= target) return { onPace: true, catchUp: null }; // already reached; see targetBlock.reached
    const onPace = projectedTotal >= target;
    if (onPace || workingDaysLeft <= 0) return { onPace, catchUp: null };
    const remaining = target - total;
    const perWorkingDay = remaining / workingDaysLeft;
    const catchUp = { remaining: round2(remaining), perWorkingDay: round2(perWorkingDay) };
    if (breakdown.perWeek) catchUp.perWeek = round2(perWorkingDay * 6);
    if (breakdown.perMonth) catchUp.perMonth = round2(perWorkingDay * avgWorkingDaysPerMonth);
    return { onPace: false, catchUp };
  }

  // ---- daily series (month to date, for the bar chart) ----
  const dailySeries = [];
  for (let d = mStart; d <= today; d = addDays(d, 1)) {
    const agg = sumRange(records, d, d);
    dailySeries.push({ date: d, value: agg.value, count: agg.count, today: d === today });
  }

  // ---- targets ----
  const weeklyTarget = opts.weeklyTarget;
  const monthlyTarget = opts.monthlyTarget;
  const yearlyTarget = opts.yearlyTarget;

  const targetBlock = (total, target, projectedTotal, workingDaysLeft, breakdown) => {
    const pace = paceBlock(total, target, projectedTotal, workingDaysLeft, breakdown);
    return {
      total,
      target,
      pct: target ? (total / target) * 100 : null,
      reached: target ? total >= target : false,
      diff: target ? total - target : null,
      onPace: pace.onPace,
      catchUp: pace.catchUp,
    };
  };

  // ---- leaderboard ----
  const cache = new Map();
  const [lbWeek, lbMonth, lbYear] = await Promise.all([
    leaderboardFor(thisWeekAgg.rows, cache, opts.apiKey, opts.getUserName),
    leaderboardFor(mtdAgg.rows, cache, opts.apiKey, opts.getUserName),
    leaderboardFor(ytdAgg.rows, cache, opts.apiKey, opts.getUserName),
  ]);

  // ---- historical period picker (daily rollup the client slices into any preset/custom range) ----
  const salesDaily = rollupSalesDaily(records);
  const repNamesResolved = await buildRepNameMap(records, cache, opts.apiKey, opts.getUserName);

  return {
    asOf: new Date().toISOString(),
    asOfTZ: tz,
    today: { date: today, value: todayAgg.value, count: todayAgg.count },
    yesterday: { date: yesterday, value: yesterdayAgg.value, count: yesterdayAgg.count },
    todayVsYesterdayPct: pctChange(todayAgg.value, yesterdayAgg.value),
    thisWeek: { start: thisWeekStart, end: today, value: thisWeekAgg.value, count: thisWeekAgg.count },
    lastWeek: { start: lastWeekStart, end: lastWeekEnd, value: lastWeekAgg.value, count: lastWeekAgg.count },
    weekVsLastWeekPct: pctChange(thisWeekAgg.value, lastWeekAgg.value),
    mtd: {
      start: mStart,
      end: today,
      value: mtdAgg.value,
      count: mtdAgg.count,
      avgDeal: mtdAgg.count ? round2(mtdAgg.value / mtdAgg.count) : 0,
    },
    lastMonthSamePeriod: {
      start: lastMonthStart,
      end: lastMonthSamePeriodEnd,
      value: lastMonthSamePeriodAgg.value,
      count: lastMonthSamePeriodAgg.count,
      avgDeal: lastMonthSamePeriodAgg.count ? round2(lastMonthSamePeriodAgg.value / lastMonthSamePeriodAgg.count) : 0,
    },
    mtdVsLastMonthPct: pctChange(mtdAgg.value, lastMonthSamePeriodAgg.value),
    avgDealVsLastMonthPct: pctChange(
      mtdAgg.count ? mtdAgg.value / mtdAgg.count : 0,
      lastMonthSamePeriodAgg.count ? lastMonthSamePeriodAgg.value / lastMonthSamePeriodAgg.count : 0
    ),
    fullLastMonth: { start: lastMonthStart, end: lastMonthEnd, value: fullLastMonthAgg.value, count: fullLastMonthAgg.count },
    dailySeries,
    monthPacing: {
      workingDaysTotal: monthWorkingDaysTotal,
      workingDaysElapsed: monthWorkingDaysElapsed,
      workingDaysLeft: monthWorkingDaysTotal - monthWorkingDaysElapsed,
      avgPerWorkingDay: round2(monthAvgPerWorkingDay),
      projectedTotal: round2(projectedMonthTotal),
      vsLastMonthPct: pctChange(projectedMonthTotal, fullLastMonthAgg.value),
    },
    ytd: {
      start: yStart,
      end: today,
      value: ytdAgg.value,
      count: ytdAgg.count,
      avgDeal: ytdAgg.count ? round2(ytdAgg.value / ytdAgg.count) : 0,
    },
    yearPacing: {
      workingDaysTotal: yearWorkingDaysTotal,
      workingDaysElapsed: yearWorkingDaysElapsed,
      workingDaysLeft: yearWorkingDaysTotal - yearWorkingDaysElapsed,
      avgPerWorkingDay: round2(yearAvgPerWorkingDay),
      projectedTotal: round2(projectedYearTotal),
    },
    targets: {
      // weekly: a week has no sub-unit worth breaking out below "per day"
      weekly: targetBlock(thisWeekAgg.value, weeklyTarget, projectedWeekTotal, weekWorkingDaysTotal - weekWorkingDaysElapsed, {}),
      // monthly: break the catch-up down into daily AND weekly terms
      monthly: targetBlock(mtdAgg.value, monthlyTarget, projectedMonthTotal, monthWorkingDaysTotal - monthWorkingDaysElapsed, { perWeek: true }),
      // yearly: break the catch-up down into daily, weekly, AND monthly terms
      yearly: targetBlock(ytdAgg.value, yearlyTarget, projectedYearTotal, yearWorkingDaysTotal - yearWorkingDaysElapsed, { perWeek: true, perMonth: true }),
    },
    leaderboard: { week: lbWeek, month: lbMonth, year: lbYear },
    salesDaily,
    reps: repNamesResolved,
    recordCount: records.length,
    fallbackDateCount: records.filter((r) => r.usedFallback).length,
  };
}

export { computeDashboard, extractWonRecords, rollupSalesDaily, DEFAULT_WON_DATE_FIELD_ID };
