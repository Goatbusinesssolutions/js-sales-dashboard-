// Single Worker entry point (see wrangler.jsonc's "main"). Cloudflare Pages
// used to auto-route a functions/ directory for you; a plain Worker doesn't
// do that, so this file is the router. It's deliberately thin — the actual
// logic for each endpoint still lives in functions/api/data.js and
// functions/api/appointments.js, unchanged, and is just called directly
// from here with a {request, env, ctx} object shaped like the Pages
// "context" argument those files were originally written for (both only
// ever read context.env, so this shim is all that's needed — no rewrite).
import { onRequestGet as handleData, loadDashboard } from '../functions/api/data.js';
import { onRequestGet as handleAppointments, loadAppointments } from '../functions/api/appointments.js';
import { kvRefresh } from '../lib/kvCache.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const context = { request, env, ctx };

    if (url.pathname === '/api/data') return handleData(context);
    if (url.pathname === '/api/appointments') return handleAppointments(context);

    // Anything else (the dashboard page itself, its one JS import) is a
    // static file — wrangler.jsonc's "run_worker_first" is scoped to
    // /api/* only, so in practice Cloudflare serves those requests straight
    // from public/ without ever reaching this function. This fallback just
    // covers the same behavior if that ever changes.
    return env.ASSETS.fetch(request);
  },

  // Runs on Cloudflare's own clock (see wrangler.jsonc's triggers.crons),
  // not in response to any visitor — this is what keeps the KV cache warm
  // (see lib/kvCache.js's kvServe/kvRefresh and the DASH_CACHE binding in
  // wrangler.jsonc) so a real visitor's request almost always finds an
  // already-computed response — read from KV, which is replicated to every
  // Cloudflare colo — instead of waiting on a live pull from GOAT on
  // whichever colo happens to handle their request.
  //
  // Calls kvRefresh unconditionally (not the fake-request/cache-API-warming
  // approach this used before) — kvRefresh always does a fresh GOAT pull
  // and writes straight to the "data"/"appointments" KV keys, which is both
  // simpler and is what makes the cache global instead of per-colo.
  //
  // Two separate cron schedules, both every 2 minutes but deliberately on
  // ALTERNATING minutes (see wrangler.jsonc's triggers.crons comment) —
  // the old every-1-minute / every-2-minutes pair both landed on every
  // even minute, so /api/data's ~15-20 GOAT calls and /api/appointments'
  // ~90-120 GOAT calls fired at GOAT simultaneously, which was enough
  // combined burst to trip GOAT's own rate limit. Matching this file's
  // string comparisons to wrangler.jsonc's cron expressions is required —
  // if the two ever drift apart, a tick fires without a matching branch
  // here and silently warms nothing.
  async scheduled(event, env, ctx) {
    const tasks = [];
    if (event.cron === '*/2 * * * *') {
      tasks.push(kvRefresh(env, 'data', loadDashboard));
    }
    if (event.cron === '1-59/2 * * * *') {
      tasks.push(kvRefresh(env, 'appointments', loadAppointments));
    }
    // Swallow errors here — a failed warm attempt just means KV stays as it
    // was (or a real visitor pays for a live pull instead); it must never
    // crash the cron invocation itself.
    await Promise.all(tasks.map((p) => p.catch(() => {})));
  },
};
