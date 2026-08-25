// Single Worker entry point (see wrangler.jsonc's "main"). Cloudflare Pages
// used to auto-route a functions/ directory for you; a plain Worker doesn't
// do that, so this file is the router. It's deliberately thin — the actual
// logic for each endpoint still lives in functions/api/data.js and
// functions/api/appointments.js, unchanged, and is just called directly
// from here with a {request, env, ctx} object shaped like the Pages
// "context" argument those files were originally written for (both only
// ever read context.env, so this shim is all that's needed — no rewrite).
import { onRequestGet as handleData } from '../functions/api/data.js';
import { onRequestGet as handleAppointments } from '../functions/api/appointments.js';

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
};
