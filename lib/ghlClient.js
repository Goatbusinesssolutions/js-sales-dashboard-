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

async function ghlFetch(path, apiKey) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: headers(apiKey) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GHL API ${res.status} on ${path}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

async function ghlFetchPost(path, apiKey, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { ...headers(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
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
export async function fetchAllOpportunitiesByStatus(locationId, apiKey, status) {
  const opportunities = [];
  const limit = 100;
  let startAfter = null;
  let startAfterId = null;

  for (let page = 0; page < 500; page++) {
    // hard cap of 500 pages (50k records) as a runaway-loop backstop
    let path = `/opportunities/search?locationId=${encodeURIComponent(locationId)}&status=${encodeURIComponent(status)}&limit=${limit}`;
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
 */
export async function fetchAllOpportunities(locationId, apiKey) {
  const statuses = ['open', 'won', 'lost', 'abandoned'];
  const results = await Promise.all(
    statuses.map((s) => fetchAllOpportunitiesByStatus(locationId, apiKey, s))
  );
  return results.flat();
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

  while (chunkStart < endMs) {
    const chunkEnd = Math.min(chunkStart + CHUNK_MS, endMs);
    const path = `/calendars/events?calendarId=${encodeURIComponent(calendarId)}&startTime=${chunkStart}&endTime=${chunkEnd}`;
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
    const body = {
      filters: [{ field: 'tags', operator: 'contains_set', value: tagNames }],
      sort: [{ field: 'dateAdded', direction: 'desc' }],
      pageLimit: 100,
    };
    if (searchAfter) body.searchAfter = searchAfter;

    const data = await ghlFetchPost(`/contacts/search?locationId=${encodeURIComponent(locationId)}`, apiKey, body);
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
