// Thin client for the GoHighLevel (HighLevel) public REST API v2.
//
// Auth: a location-scoped "Private Integration" token, used directly as a
// Bearer token (no OAuth exchange). Create one in the GHL UI under
// Settings -> Private Integrations, with opportunities.readonly,
// contacts.readonly, and users.readonly scopes. See README.md.

const BASE_URL = 'https://services.leadconnectorhq.com';
const API_VERSION = '2021-07-28';

function headers(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: API_VERSION,
    Accept: 'application/json',
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// How long to wait before retry N (0-indexed) of a 429/5xx: 500ms, 1500ms,
// 4000ms. A single short retry (the old behavior) wasn't enough to clear a
// real rate-limit window — GOAT's 429s come in bursts lasting a few
// seconds when this dashboard's own pulls (cron warmers + a visitor
// loading the page at the same moment) stack up, not just one-off blips —
// so this backs off harder across up to 3 attempts total instead of giving
// up after one. Capped at 3 extra attempts (4 total) so a sustained outage
// still fails in a bounded time rather than hanging the request.
const RETRY_DELAYS_MS = [500, 1500, 4000];

// If GOAT sends a Retry-After header on a 429, honor it instead of our own
// backoff schedule — it's telling us exactly how long it wants us to wait.
// Clamped to 10s so one slow-to-clear rate limit can't stall the whole
// Worker request past Cloudflare's execution limits.
function retryDelayMs(res, attempt) {
  const retryAfter = res && res.headers && res.headers.get && res.headers.get('Retry-After');
  const parsed = retryAfter ? Number(retryAfter) * 1000 : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, 10000);
  return RETRY_DELAYS_MS[attempt] || RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
}

// GOAT's API occasionally blips or briefly rate-limits under the
// ~15-120-call pulls this dashboard does per request — a 5xx or 429 that
// clears itself a few seconds later. Retrying with backoff absorbs that
// instead of surfacing the "Couldn't load dashboard data" banner to
// whoever happens to be looking at that moment. Deliberately narrow: only
// network-level failures, 5xx, and 429 — a real 4xx (bad param, auth/scope
// problem) won't change on retry, so those still fail immediately with the
// original error.
async function ghlFetch(path, apiKey, attempt = 0) {
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, { headers: headers(apiKey) });
  } catch (networkErr) {
    if (attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      return ghlFetch(path, apiKey, attempt + 1);
    }
    throw new Error(`GHL API network error on ${path}: ${networkErr.message}`);
  }
  if (!res.ok) {
    if ((res.status >= 500 || res.status === 429) && attempt < RETRY_DELAYS_MS.length) {
      await sleep(retryDelayMs(res, attempt));
      return ghlFetch(path, apiKey, attempt + 1);
    }
    const body = await res.text().catch(() => '');
    throw new Error(`GHL API ${res.status} on ${path}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

async function ghlFetchPost(path, apiKey, body, attempt = 0) {
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: { ...headers(apiKey), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (networkErr) {
    if (attempt < RETRY_DELAYS_MS.length) {
      await sleep(RETRY_DELAYS_MS[attempt]);
      return ghlFetchPost(path, apiKey, body, attempt + 1);
    }
    throw new Error(`GHL API network error on ${path}: ${networkErr.message}`);
  }
  if (!res.ok) {
    if ((res.status >= 500 || res.status === 429) && attempt < RETRY_DELAYS_MS.length) {
      await sleep(retryDelayMs(res, attempt));
      return ghlFetchPost(path, apiKey, body, attempt + 1);
    }
    const t = await res.text().catch(() => '');
    throw new Error(`GHL API ${res.status} on ${path}: ${t.slice(0, 500)}`);
  }
  return res.json();
}

/**
 * Fetch every won opportunity for a location, across all pipelines,
 * following the meta.startAfter / meta.startAfterId cursor until the
 * result set is exhausted. This is a FULL pull, not a recency-sorted
 * top-N — that distinction matters: an opportunity's business "Won Date"
 * custom field can be back-dated or corrected well after its
 * lastStatusChangeAt, so a partial recency-sorted pull can silently miss
 * real records. See the dashboard's design notes for the bug this caused
 * the first time this was built by hand.
 */
export async function fetchAllWonOpportunities(locationId, apiKey) {
  return fetchAllOpportunitiesByStatus(locationId, apiKey, 'won');
}

/**
 * Fetch every opportunity in a single status for a location, across all
 * pipelines, following the meta.startAfter / meta.startAfterId cursor
 * until the result set is exhausted. Generalization of the original
 * won-only pull (see fetchAllWonOpportunities) so the same paginator can
 * pull open/lost/abandoned too — needed to classify appointment outcomes,
 * which look at an opportunity's *current* status and pipeline stage, not
 * just won deals.
 */
// Minimum gap between successive pages of the SAME paginated pull. Even
// with the retry/backoff in ghlFetch, a single pagination loop firing 20-
// 30+ page requests back-to-back with zero gap can trip GOAT's own rate
// limit entirely on its own — confirmed live: the 429s traced back to this
// exact loop (opportunities/search, status=won) even after spacing out
// this dashboard's two unrelated cron pulls, so the burst was coming from
// one pagination loop's own request rate, not from two endpoints
// colliding. This is deliberately a small, fixed gap (not exponential
// backoff — that's what ghlFetch's retry already does for an actual
// failure) so a small pull isn't slowed down much, while a large one
// (hundreds/thousands of records → dozens of pages) spreads its calls out
// over real wall-clock time instead of spiking them all at once.
const PAGE_GAP_MS = 250;

export async function fetchAllOpportunitiesByStatus(locationId, apiKey, status) {
  const opportunities = [];
  const limit = 100;
  let startAfter = null;
  let startAfterId = null;

  for (let page = 0; page < 500; page++) {
    // hard cap of 500 pages (50k records) as a runaway-loop backstop
    //
    // NOTE: this endpoint's query param is `location_id` (snake_case), not
    // the `locationId` (camelCase) every other GHL endpoint in this file
    // uses. Confirmed live on 2026-08-25 — GHL started rejecting the
    // camelCase form with a 422 ("property locationId should not exist",
    // "location_id must be a string/should not be empty"). Only this one
    // endpoint has been observed to require the snake_case form; don't
    // "fix" the others (contacts/search, calendars/events) to match unless
    // they show the same error — they haven't.
    if (page > 0) await sleep(PAGE_GAP_MS);
    let path = `/opportunities/search?location_id=${encodeURIComponent(locationId)}&status=${encodeURIComponent(status)}&limit=${limit}`;
    if (startAfter && startAfterId) {
      path += `&startAfter=${startAfter}&startAfterId=${encodeURIComponent(startAfterId)}`;
    }
    const data = await ghlFetch(path, apiKey);
    const batch = data.opportunities || [];
    opportunities.push(...batch);

    if (batch.length < limit || !data.meta || !data.meta.nextPage) break;
    startAfter = data.meta.startAfter;
    startAfterId = data.meta.startAfterId;
    if (!startAfter || !startAfterId) break;
  }

  return opportunities;
}

/**
 * Fetch every opportunity regardless of status (open/won/lost/abandoned),
 * for classifying appointment outcomes. This is 4x the API traffic of the
 * won-only pull — see the subrequest-budget note in functions/api/data.js
 * before raising this further (e.g. adding more statuses or a tighter
 * poll interval).
 *
 * Fetched ONE STATUS AT A TIME, not via Promise.all — this location has
 * thousands of opportunities per status, each paginating dozens of pages
 * back-to-back, and 4 of those pagination loops all firing at once was
 * enough concurrent request volume to trip GOAT's own rate limit (a 429
 * that even ghlFetch's retry couldn't clear, since the whole burst was
 * still in flight). Sequential is slower wall-clock but spreads the same
 * total calls out instead of spiking them, which is what actually avoids
 * the 429 rather than just retrying after hitting it.
 */
export async function fetchAllOpportunities(locationId, apiKey) {
  const statuses = ['open', 'won', 'lost', 'abandoned'];
  const results = [];
  for (const s of statuses) {
    results.push(...(await fetchAllOpportunitiesByStatus(locationId, apiKey, s)));
  }
  return results;
}

/**
 * Fetch every event on one calendar between startMs and endMs (epoch
 * milliseconds), chunked into <=31-day windows. GET /calendars/events
 * takes required startTime/endTime in millis and has no documented
 * pagination cursor; chunking keeps each request's result set bounded in
 * case there's an undocumented per-call cap, rather than trusting one huge
 * multi-month window to return everything.
 */
export async function fetchCalendarEvents(locationId, apiKey, calendarId, startMs, endMs) {
  const events = [];
  const DAY_MS = 24 * 60 * 60 * 1000;
  const CHUNK_MS = 31 * DAY_MS;
  let chunkStart = startMs;

  let firstChunk = true;
  while (chunkStart < endMs) {
    const chunkEnd = Math.min(chunkStart + CHUNK_MS, endMs);
    // Same GOAT rate-limit spacing as fetchAllOpportunitiesByStatus's
    // PAGE_GAP_MS — a long history window chunked into many 31-day slices
    // is the same "many sequential calls back-to-back" shape that tripped
    // the 429 there.
    if (!firstChunk) await sleep(PAGE_GAP_MS);
    firstChunk = false;
    // NOTE: locationId is required here too (confirmed live 2026-08-25 —
    // "Location ID is required" 400 without it). Using the camelCase form
    // like contacts/search and every other GET endpoint here except
    // opportunities/search, which is the one confirmed outlier that wants
    // snake_case location_id instead.
    const path = `/calendars/events?calendarId=${encodeURIComponent(calendarId)}&locationId=${encodeURIComponent(locationId)}&startTime=${chunkStart}&endTime=${chunkEnd}`;
    const data = await ghlFetch(path, apiKey);
    events.push(...(data.events || []));
    chunkStart = chunkEnd;
  }

  return events;
}

/**
 * Fetch every contact carrying any of the given tag names (OR-match via
 * contains_set), paginating via the searchAfter cursor each contact record
 * echoes back. Used as a fallback classification signal for appointments
 * whose linked opportunity was deleted by the pre-fix NI/NQ automation
 * (see README/design notes) — only the id and tags are kept from each
 * record to keep memory/payload small.
 */
export async function fetchTaggedContacts(locationId, apiKey, tagNames) {
  const contacts = [];
  let searchAfter = null;

  for (let page = 0; page < 500; page++) {
    // Same GOAT rate-limit spacing as fetchAllOpportunitiesByStatus's
    // PAGE_GAP_MS — see that comment for why this matters.
    if (page > 0) await sleep(PAGE_GAP_MS);
    // NOTE: unlike the GET endpoints in this file, /contacts/search wants
    // locationId in the POST body, not the URL query string. Confirmed
    // live on 2026-08-25 — putting it in the query string got back a 422
    // ("locationId must be a string"), i.e. the body's locationId field was
    // seen as missing even though the query string had it.
    const body = {
      locationId,
      filters: [{ field: 'tags', operator: 'contains_set', value: tagNames }],
      sort: [{ field: 'dateAdded', direction: 'desc' }],
      pageLimit: 100,
    };
    if (searchAfter) body.searchAfter = searchAfter;

    const data = await ghlFetchPost('/contacts/search', apiKey, body);
    const batch = data.contacts || [];
    for (const c of batch) {
      contacts.push({ id: c.id, tags: c.tags || [] });
    }

    if (batch.length < 100) break;
    const last = batch[batch.length - 1];
    if (!last || !last.searchAfter) break;
    searchAfter = last.searchAfter;
  }

  return contacts;
}

/** Resolve a single userId to a display name via GET /users/{id}. */
export async function getUserName(userId, apiKey) {
  try {
    const data = await ghlFetch(`/users/${encodeURIComponent(userId)}`, apiKey);
    if (data.name) return data.name;
    if (data.firstName || data.lastName) {
      return [data.firstName, data.lastName].filter(Boolean).join(' ').trim();
    }
    return userId;
  } catch (e) {
    return userId; // fall back to the raw id rather than failing the whole request
  }
}
