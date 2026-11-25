// "Fallout" = a deal that was WON (contract signed) and later canceled or
// credit-rejected, landing in the Closed pipeline's Closed Canceled or
// Closed Credit Reject stage. Both are now automatically marked
// status='lost' by their matching GOAT workflow (credit-reject tag ->
// Status=Lost; canceled-sale tag -> Status=Lost; see the Nov 2026 fix),
// which is also what keeps a fallen-out deal out of Gross Sales
// automatically — see aggregate.js's extractWonRecords.
//
// This module only extracts raw fallout records from the full opportunity
// pull (any status) — the per-period / per-rep rate math happens
// client-side in index.html, the same way the rest of the Appointment
// Outcomes section already works off of small pre-extracted record lists
// rather than raw GHL objects.

const CLOSED_CANCELED_STAGE_ID = '9e09d076-40bd-4bec-80a1-e78b6813125d';
const CLOSED_CREDIT_REJECT_STAGE_ID = 'e025ff1f-3a8a-4aab-a652-6fc104d41e22';
const FALLOUT_REASON_BY_STAGE = {
  [CLOSED_CANCELED_STAGE_ID]: 'canceled',
  [CLOSED_CREDIT_REJECT_STAGE_ID]: 'creditReject',
};

// Same field id aggregate.js uses for the manually-maintained "Won Date"
// custom field. Not imported from aggregate.js to keep this module
// independently testable/standalone; pass opts.wonDateFieldId to override
// both in the same direction if this ever points at a different location.
const DEFAULT_WON_DATE_FIELD_ID = 'd4CycZZLInE2PuqJO9uG';

function todayStrInTZ(tz, when) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(when ? new Date(when) : new Date());
}

/**
 * Recover the ORIGINAL Won Date for a deal currently sitting in a fallout
 * stage.
 *
 * lastStatusChangeAt is only trustworthy here if status is STILL 'won' —
 * meaning this particular deal's status was never corrected after it fell
 * out (an older, pre-Oct-2026 straggler that the bulk fix didn't reach and
 * neither workflow has re-processed), so lastStatusChangeAt still reflects
 * the original win, exactly like every other won deal on this dashboard
 * (see aggregate.js's extractWonDate).
 *
 * Once status flips to 'lost' — the Oct 2026 bulk fix, or either tag
 * workflow from here on — lastStatusChangeAt gets overwritten with the
 * FALLOUT transition's own timestamp; it can no longer stand in for Won
 * Date at all for that record. The only thing that survives that
 * overwrite is the manually-maintained "Won Date" custom field, which is
 * far from always filled in (roughly half the time, historically). When
 * it's missing there too, this deliberately returns null — an "unknown
 * cohort" deal — rather than guessing from a timestamp that's actually
 * just the fallout date, which would silently miscount it into the wrong
 * period.
 */
function extractFalloutWonDate(opp, wonDateFieldId, tz) {
  if (opp.status === 'won' && opp.lastStatusChangeAt) {
    return todayStrInTZ(tz, opp.lastStatusChangeAt);
  }
  const fields = opp.customFields || [];
  const wonField = fields.find((f) => f.id === wonDateFieldId && f.fieldValueDate != null);
  if (wonField) {
    // Date-only custom field: stored as epoch-ms at UTC midnight — do NOT
    // localize this, same reasoning as aggregate.js's extractWonDate.
    return new Date(wonField.fieldValueDate).toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Every opportunity currently sitting in Closed Canceled or Closed Credit
 * Reject, regardless of its current status field — a deal counts as
 * fallen out based on where it IS (its current pipeline stage), not on
 * whether its status field was ever corrected to 'lost' (see the module
 * comment above for why that distinction matters for dating it).
 *
 * @param {Array} opportunities raw GHL opportunity objects, any status —
 *   pass the SAME full (all-statuses) pull /api/appointments already does
 *   for calendar classification; this is free, no extra GHL calls.
 * @param {Object} opts { tz, wonDateFieldId }
 */
function extractFalloutRecords(opportunities, opts = {}) {
  const tz = opts.tz || 'America/New_York';
  const wonDateFieldId = opts.wonDateFieldId || DEFAULT_WON_DATE_FIELD_ID;
  return opportunities
    .filter((o) => FALLOUT_REASON_BY_STAGE[o.pipelineStageId])
    .map((o) => ({
      id: o.id,
      name: o.name || null,
      contactId: o.contactId || null,
      assignedTo: o.assignedTo || null,
      monetaryValue: o.monetaryValue || 0,
      reason: FALLOUT_REASON_BY_STAGE[o.pipelineStageId],
      wonDate: extractFalloutWonDate(o, wonDateFieldId, tz),
    }));
}

export {
  extractFalloutRecords,
  CLOSED_CANCELED_STAGE_ID,
  CLOSED_CREDIT_REJECT_STAGE_ID,
  DEFAULT_WON_DATE_FIELD_ID,
};
