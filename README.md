# JS Construction — Live Sales Dashboard

A small, self-contained web app that reads won-opportunity data straight
from GoHighLevel and renders the same dashboard you've been getting as a
static file — except this one recomputes itself on real, current data
every time it's loaded, instead of being a snapshot frozen at whatever
moment I built it.

**Deploys to Cloudflare as a Worker** (Cloudflare Pages is no longer
offered for new projects — this project uses Cloudflare's current
recommended setup: a Worker with a static-assets binding, which does the
same job Pages used to). No database, so **Supabase isn't used here** —
everything this dashboard needs comes straight from GHL on each request;
there's nothing to store.

**What "live" means here, concretely:** every visit to the page fetches
`/api/data`, which the deployed Worker (`worker/index.js`) routes to the
handler in `functions/api/data.js` — it pulls every won opportunity from
GHL, recomputes every number on the dashboard (today, this week,
month/year to date, pacing, targets, the leaderboard — everything), and
returns it as JSON. The page never talks to GHL directly, and your GHL
API key never reaches anyone's browser — it lives only on the Worker, as
an environment variable/secret.

## What happens as more sales are made

Nothing needs to happen on your end. The next time anyone opens (or
refreshes, or the page auto-refreshes itself every 1 minute) the
dashboard, it re-pulls from GHL and every figure — today's total, the
weekly/monthly/yearly target meters, the leaderboard rankings, the pacing
projections — reflects whatever's true in GHL at that moment. A deal that
gets marked won a minute ago shows up on the next refresh.

To avoid hammering the GHL API if several people have the dashboard open
(e.g. on an office TV), responses are cached at Cloudflare's edge for 1
minute (`Cache-Control: s-maxage=60`) — so during any 1-minute window,
everyone sees the same cached pull, and the next visitor after that
window triggers a fresh one. Change the number in
`functions/api/data.js` (`json(dashboard, 200, 60)`) if you want it
faster or slower. Appointment outcomes (`/api/appointments`) follow the
same auto-refresh but keep a slightly longer 2-minute edge cache of their
own — see the "Appointment outcomes" section below for why.

## One-time setup

### 1. Get a GHL API credential (5 minutes)

You need a **Private Integration Token** — this is GHL's sanctioned way to
get a long-lived server-side API credential for a single sub-account,
without building a full OAuth marketplace app.

1. In GoHighLevel, switch to the **JS Construction** sub-account.
2. Go to **Settings → Private Integrations** (enable it under Labs first
   if you don't see it).
3. Click **Create new Integration**. Name it something like "Sales
   Dashboard".
4. Grant these scopes (read-only is all this needs):
   - `opportunities.readonly`
   - `contacts.readonly`
   - `users.readonly`
5. Click create, then **copy the token immediately** — GHL only shows it
   once. If you lose it, delete the integration and make a new one.

You'll also need your **Location ID** for JS Construction. It's already
baked into `.env.example` as a default (`WXp6Vk4nCuljh1ZHTP4l`) — that's
the id this whole project was already built against, so you can leave it
as-is unless GHL ever changes it.

GHL private integration tokens don't expire automatically, but GHL
recommends rotating them roughly every 90 days (rotating gives you a
7-day grace period where the old and new token both work, so nothing
breaks mid-rotation).

### 2. Get the code into a Git repo

Cloudflare deploys Workers from a Git repository (GitHub or GitLab) via
its built-in CI ("Workers Builds").

1. Create a new repo (GitHub is easiest) — **js-sales-dashboard**, private
   is fine.
2. Upload everything in this folder to it, **keeping the folder structure
   intact**: the `public` folder (with `index.html` and `lib/appointments.js`
   inside it), the `functions` folder, the `worker` folder, the `lib`
   folder, `package.json`, and `wrangler.jsonc`. On GitHub's website this
   is **Add file → Upload files** — drag the whole folders in (not just
   the files inside them) so `public/`, `functions/`, `worker/`, and
   `lib/` come across as subfolders, then commit. No git command line
   needed.

   > **Why the folders are laid out this way.** `wrangler.jsonc` tells
   > Cloudflare to deploy `worker/index.js` as the Worker itself, and to
   > serve everything in `public/` as static files. `worker/index.js`
   > routes `/api/*` requests to the handlers in `functions/api/*.js`
   > (unchanged from before) and hands everything else straight to the
   > static files in `public/`. Cloudflare's own build tooling installs
   > into `node_modules` at the repo root while preparing the deploy —
   > since that's a sibling of `public/`, not inside it, it's never
   > mistaken for part of the site.

### 3. Deploy on Cloudflare (you already have an account)

1. In the Cloudflare dashboard, go to **Workers & Pages → Create
   application**, then **Connect to Git** (or **Import a repository** —
   the exact wording varies by account, but it's the git-connect option,
   not "Deploy from CLI" or a template).
2. Authorize GitHub if you haven't already, then pick the
   **js-sales-dashboard** repo.
3. On the **Build configuration** screen, set:
   - **Build command:** `npm run build`
   - **Deploy command:** leave as the default, `npx wrangler deploy`
   - **Version command:** leave as the default,
     `npx wrangler versions upload`
   - **Root directory:** leave as `/`

   Then click through to deploy.

   > **Why these settings matter — and the story of the error you may
   > have already hit.** This project deploys as a Cloudflare Worker
   > (Pages is no longer offered for new projects), and `wrangler.jsonc`
   > at the repo root does the actual work: it points `wrangler deploy`
   > at `worker/index.js` and tells it to serve `public/` as static
   > assets. Since `public/` only contains the dashboard page and one
   > small JS file, the `node_modules` folder Cloudflare's build step
   > creates at the repo root (which is where the `Asset too large` /
   > `workerd` 144 MiB error came from) is never part of what gets
   > uploaded — it lives outside `public/` entirely, so the asset-size
   > problem can't happen with this layout, regardless of what Cloudflare
   > installs there. **The `Build command` (`npm run build`) is what
   > copies `lib/appointments.js` into `public/lib/` on every deploy**,
   > since the dashboard's own client-side code needs that one file
   > alongside it — see the callout in step 2 and "Project layout" below.
   > (Two earlier fix attempts — a `.assetsignore` file, then a
   > Pages-specific "Build output directory" setting — don't apply here;
   > this repo is a Worker project now, not a Pages project, which is why
   > the settings screen looks different than older guides describe.)
4. Once the first deploy finishes, go to your new Worker's
   **Settings → Variables and Secrets → Add** and add:
   - `GHL_API_KEY` — the token from step 1 (check **Encrypt** so it's
     stored as a secret)
   - Optionally `WEEKLY_TARGET`, `MONTHLY_TARGET`, `YEARLY_TARGET` if you
     ever want to change the sales targets without touching code.

   `GHL_LOCATION_ID` does **not** go here — it's already committed in
   `wrangler.jsonc`'s `vars` block, on purpose (see the note in step 2's
   callout above). Adding it again in the dashboard won't break anything,
   but it's not necessary.

   > **Known Cloudflare issue:** dashboard-only variables and secrets can
   > occasionally get wiped out by the *next* git-triggered deploy on a
   > project like this one (Cloudflare's own build tooling, not this
   > project). If `GHL_API_KEY` ever goes missing again after a deploy you
   > didn't expect to touch it, that's why — just re-add it under
   > Settings → Variables and Secrets and retry the deployment. This is
   > why `GHL_LOCATION_ID` was moved into `wrangler.jsonc` instead:
   > anything committed to the repo can't be wiped this way, only things
   > that are dashboard-only (which `GHL_API_KEY`, being an actual secret,
   > has to stay).
5. Trigger a redeploy so the new variable takes effect (**Deployments →
   ⋯ → Retry deployment**, or just push any small change to the repo).
6. Open the `*.workers.dev` URL Cloudflare gives you — that's your live
   dashboard. Bookmark it, put it on an office TV, whatever you like. You
   can also attach your own domain later under the project's **Custom
   domains** tab.

### 4. Confirm it's working

Open the deployed URL. You should see the dashboard load with a brief
"Loading live data…" banner, then populate with current numbers. If
instead you see a red error banner, it's almost always one of:

- `GHL_API_KEY` or `GHL_LOCATION_ID` not set (or set on a different
  environment — Cloudflare Workers has separate "Production" and "Preview"
  variable sets; make sure yours are on Production)
- the Private Integration Token was revoked/regenerated since you set it
- the token's scopes don't include `opportunities.readonly` /
  `users.readonly`

The error banner shows the underlying error message to make this easy to
diagnose. You can also hit `/api/data` directly in a browser tab to see
the raw JSON and the exact error, if any.

## What you can safely change later

- **Targets.** Set `WEEKLY_TARGET` / `MONTHLY_TARGET` / `YEARLY_TARGET` as
  variables in your Worker's settings and redeploy (no code change). If
  you only set `WEEKLY_TARGET`, monthly/yearly are still derived from it
  automatically (×52/12 and ×52).
- **Refresh cadence.** `REFRESH_INTERVAL_MS` in `public/index.html` controls how
  often an open tab re-fetches (default 1 minute — same constant drives
  both `/api/data` and `/api/appointments` polling). The `60` in
  `functions/api/data.js`'s `json(dashboard, 200, 60)` call controls how
  long a pull is cached at Cloudflare's edge before the *next* visitor
  triggers a fresh one (default 1 minute, in seconds); the equivalent
  `120` in `functions/api/appointments.js` does the same for appointment
  outcomes (kept a bit longer since that pull is far more GHL-API-call
  expensive — see below).
- **Known reps.** `lib/reps.js` maps GHL user IDs to display names for the
  leaderboard. Any rep not in that list gets looked up live via the GHL
  API automatically — the map is just there to skip that extra lookup for
  people you already know. Update the flag comment at the top of that
  file if the "these accounts look like install crew, not sales reps"
  caveat stops being accurate.
- **Timezone.** `DASHBOARD_TZ` variable, defaults to `America/New_York`.
  This is what "today" means for every date boundary on the dashboard.

## Viewing past periods (the "Viewing" picker at the top)

The top of the dashboard has a "Viewing" dropdown: **Current — live**, **This
week**, **Last week**, **This month**, **Last month**, **This year**, or
**Custom range…**. Every option besides "Current" swaps in a leaner view —
total, deal count, avg deal (with a "vs. the equal-length period right
before this one" comparison line), a target callout, a daily/monthly bar
chart, and a rep leaderboard — all sliced from `salesDaily`, a day-by-day
breakdown the API sends down once per load. No extra network calls happen
when you switch periods; it's all client-side math over that one payload,
so switching is instant and works for literally any custom date range, not
just the presets.

## Appointment outcomes (Sold / DNS / No Show / NI / NQ)

A second section on the dashboard tracks estimate-appointment results —
Sold, DNS (demo, no sale), No Show, Not Interested, Not Qualified — with a
date-range picker (today/yesterday/this week/last week/MTD/last
month/YTD/custom) and opp-rate / demo-to-opp-rate / close-rate math. It's
backed by its own endpoint, `/api/appointments`, kept separate from
`/api/data` because it's much more expensive to compute.

**Why it's expensive:** classifying an appointment needs the *current*
status of its linked opportunity (open/won/lost/abandoned) and, when no
opportunity exists, a tag-based fallback — so this endpoint pulls **every**
opportunity (not just won ones), every contact carrying a Not
Interested/Not Qualified tag, and every event on the Estimate Calendar
going back `APPOINTMENTS_HISTORY_DAYS` days (default 260). That's roughly
90-120 GHL API calls per cache miss, versus ~15-20 for `/api/data`.

- **Cloudflare's free Workers plan caps a single request at 50
  subrequests, and a cache miss here already exceeds that on its own** —
  this endpoint requires Workers Paid ($5/mo, 1000 subrequests)
  regardless of how it's cached. If you need to cut the per-pull cost
  instead, lower `APPOINTMENTS_HISTORY_DAYS` in your Worker's
  variables.
- This endpoint caches at Cloudflare's edge for **2 minutes** (vs. 1
  minute for `/api/data`) — a status change still shows up within a
  couple of client polls, but the much-more-expensive pull doesn't re-run
  on literally every poll from every open tab.

**Classification rules** (see the comment block at the top of
`lib/appointments.js` for the full write-up):

- **Sold** — opportunity status `won`, dated by **Won Date** (same
  extraction as the sales-$ dashboard above — status-change timestamp
  first, the Won Date custom field as fallback), not by the calendar
  appointment's date. This is deliberate: a deal almost never closes the
  same day as its estimate, and the business wants $ Sold here to always
  match the sales-$ dashboard for the same range. A practical consequence:
  a won deal with no matching calendar appointment at all (or one whose
  appointment falls outside the pulled history window) still counts as a
  sale — and a demo, for the rate math below — on the day it actually won.
  The per-rep $ Sold breakdown follows from this too: it's attributed to
  the opportunity's own `assignedTo`, not the appointment's assigned rep —
  usually the same person, occasionally not.
- **DNS** — opportunity status `open`, pipeline stage is "Rep Working",
  "Rehash" (Leads Pipeline), or "Estimate Sent" (Leads Commercial) — an
  estimate was already given and it's still being worked.
- **No Show** — the calendar event's own `appointmentStatus` is
  `noshow` (this also folds in "one leg" — GHL has no separate tracking
  for that distinction).
- **Not Interested (NI)** — opportunity status `lost`, or (when no
  opportunity exists) a "not interested"-family tag.
- **Not Qualified (NQ)** — opportunity status `abandoned`, or (when no
  opportunity exists) a "not qualified"-family tag.
- **Unresulted** — a showed appointment that doesn't fit any bucket above
  (e.g. still sitting in some other open pipeline stage, or never
  restatused on the calendar). This is a data-quality signal, not a
  business outcome — it's reported on its own and excluded from every
  rate calculation.
- **Reset-and-retry appointments count on their own.** When a DNS deal
  gets reset and a new appointment is booked to attempt the sale again,
  that contact ends up with two (or more) "showed" appointments tied to
  the same opportunity. Only the most recent one is evaluated against the
  opportunity's current status — every earlier showed appointment for
  that contact is classified as DNS outright, so a later successful
  re-sell can't retroactively turn the original estimate appointment into
  a "Sold" too.

**Finding out which appointments to go fix.** A count of "Unresulted"
doesn't tell anyone what to do about it, so the API also returns an
`unresulted` list — every Unresulted appointment's date, title (from the
calendar event, e.g. "John - Hannah Looney - Bristol Tn - Shingle
estimate"), assigned rep, and a plain-English reason (e.g. "Appointment
date passed but was never marked showed / no-show" or "Linked deal is
open in the 'Reset' stage"). On the dashboard, a **Show unresulted list**
button appears under the counts whenever the selected date range has any
— click it to see exactly which appointments need a status change in GHL,
and who's assigned to them.

**Full vs. modified mode:** a GHL automation used to *delete* the
opportunity when an NI/NQ tag was applied, instead of changing its
status — that was fixed on **2026-08-16** (`APPOINTMENTS_FIX_DATE`). Any
date range that includes a day before the fix uses "modified mode": NI/NQ
are dropped from the rate math entirely (since they're unreliable for
that period) and only a modified demo rate / modified close rate are
shown, based on Sold/DNS/No-Show. Ranges entirely on/after the fix date
use "full mode" with the normal opp rate / demo-to-opp rate / close rate.

**New optional environment variables** (all have working defaults, same
place as `GHL_API_KEY`):

- `GHL_ESTIMATE_CALENDAR_ID` — which calendar to pull appointments from.
- `APPOINTMENTS_FIX_DATE` — the full/modified mode cutoff (`YYYY-MM-DD`).
- `APPOINTMENTS_HISTORY_DAYS` — how many days back to pull calendar
  events (default 260). Lower this if you hit Cloudflare's subrequest
  limit.

## How the numbers are computed (so nobody has to take it on faith)

This mirrors, exactly, the methodology worked out by hand while building
the first version of this dashboard — including two bugs that were found
and fixed the hard way:

- **Status-change date, not the Won Date custom field.** Every total on
  this dashboard is bucketed by `lastStatusChangeAt` — the moment GHL
  flipped the opportunity to "won" — because the business's own contract
  automation marks a deal "won" automatically and instantly the moment
  the contract is signed. That makes the status change itself the
  authoritative, always-present signal. The opportunity's "Won Date"
  custom field is a separate, manually-maintained field that's missing on
  47% of all won opportunities historically and, even when present,
  disagrees with the status-change date about 8% of the time (mostly a
  one-day drift, occasionally a real backdated correction) — not reliable
  enough to lead on. It's kept only as a last-resort fallback for the rare
  case `lastStatusChangeAt` is itself missing.
- **`lastStatusChangeAt` is converted to the business's own timezone
  before taking the date; the Won Date custom field is read as UTC-only,
  never localized.** These are opposite rules for a reason: the custom
  field is a date-only value GHL stores as an epoch timestamp at UTC
  midnight — a deliberately chosen calendar date, not a moment in time —
  so converting it to Eastern time before reading the date would shift it
  backward by a day (e.g. "Aug 14 00:00 UTC" becomes "Aug 13, 8pm ET").
  `lastStatusChangeAt`, by contrast, IS a real moment in time (whenever
  the automation actually fired), so it has to be converted to Eastern
  time first — a contract signed at 9:56pm ET still reads as the next day
  if you slice the raw UTC timestamp instead. Using the wrong rule for
  either field misfiles it by a day. `lib/aggregate.js` applies each rule
  to the field it belongs to.
- **Full pagination, never a partial recency-sorted pull.** GHL's API
  doesn't expose a reliable way to filter or sort opportunities by
  `lastStatusChangeAt` server-side, and a recency-sorted top-N pull was
  empirically found to miss real records (see the "missing won deals"
  investigation in git history — a deal opened weeks earlier and won late
  in the evening didn't surface near the top of any tested sort order).
  This dashboard always pages through every won opportunity in GHL, in
  full, every time it computes — there is no partial/top-N shortcut.
- **A week is Sunday–Saturday.** "Working days" (used only as the
  denominator for pacing projections, never for whether a sale counts)
  are Monday–Saturday — a Sunday sale still counts in every dollar total,
  it just doesn't count as a "day" for the purposes of dividing MTD/YTD
  sales by days elapsed.
- **"On pace" vs. "reached."** Early in a month or year, the raw
  percent-of-target will always look behind, even when the current
  run-rate is fully on track to clear the target by the period's end.
  The dashboard distinguishes the two: it projects the period-end total
  at the current daily run-rate, and only shows a "behind pace, here's
  what you need to do" callout when that projection actually falls short
  of the target — with the exact $/working day (and, for month/year
  targets, $/week and $/month) needed for the rest of the period to close
  the gap.

## Project layout

```
wrangler.jsonc             — tells Cloudflare what to deploy: worker/index.js as the Worker, public/ as static assets
worker/index.js            — the actual Worker entry point; routes /api/* to functions/api/*.js, else serves public/
lib/aggregate.js          — sales-dashboard date math and business logic (pure functions, no I/O, no env reads)
lib/appointments.js       — appointment-outcome classification + rollup/rate math (pure functions) — canonical copy
lib/ghlClient.js          — GHL API calls (pagination, user lookup, calendar events, tag search)
lib/reps.js               — known GHL userId -> display name map
functions/api/data.js          — route handler for /api/data (env vars via context.env), called from worker/index.js
functions/api/appointments.js  — route handler for /api/appointments, called from worker/index.js
public/index.html         — the dashboard itself (fetches /api/data and /api/appointments, renders everything)
public/lib/appointments.js     — GENERATED copy of lib/appointments.js — see note below, don't hand-edit
package.json               — declares the `npm run build` step Cloudflare runs before deploying
```

**Why there are two copies of `lib/appointments.js`.** `index.html` needs
a handful of pure math helpers from it (`sumRange`, `computeRates`,
`modeForRange`) to run client-side in the browser, but browsers resolve a
page's `<script type="module">` imports relative to the page's own served
URL — so that file has to physically exist inside `public/` (alongside
`index.html`) for the browser to fetch it, while `functions/api/*.js`
needs the exact same file to exist at the true repo root, since that's
where `worker/index.js` imports it from. Rather than maintain two files by
hand and risk them drifting apart, `lib/appointments.js` at the repo root
is the only one anyone should ever edit — `npm run build` (which
Cloudflare's "Build command" setting runs automatically before every
deploy, per step 3 above) copies it into `public/lib/appointments.js` on
every deploy, so the two are always identical. If you ever run this
locally, run `npm run build` yourself first (or just `npm run dev`, which
does it for you) before opening the page.

**Why there's both a `functions/` folder and a `worker/` folder.**
`functions/api/data.js` and `functions/api/appointments.js` hold the
actual logic and predate this project's move off Cloudflare Pages (which
used to auto-route a `functions/` folder for you); a plain Cloudflare
Worker doesn't do that auto-routing, so `worker/index.js` is a small
router in front of them — it checks the request path and calls straight
into whichever handler matches, then falls back to serving `public/` for
everything else. The two handler files didn't need to change at all to
make this work.

No bundler, no database. `lib/aggregate.js` and `lib/ghlClient.js` are
plain ES modules with no Cloudflare-specific code in them —
`functions/api/data.js` is the only file that touches Cloudflare's
`context.env`/`Response` APIs, which is why it was possible to verify the
business logic byte-for-byte against every number on the static dashboard
you'd already gotten, entirely outside of Cloudflare, before this was
ever deployed anywhere.

### Why not Vercel or Supabase?

- **Vercel** would work too (it's the same category of product as
  Cloudflare Workers), but its free tier is technically restricted to
  personal/non-commercial use — Cloudflare's free Workers tier has no such
  restriction, which matters for a business dashboard. Since you already
  have a Cloudflare account, there's no reason to add a second vendor.
- **Supabase** is a hosted database + auth platform, not a place to host a
  website or run a function — it solves a different problem than this
  dashboard has. Nothing here is stored anywhere; every number is
  recomputed from GHL on each request.
