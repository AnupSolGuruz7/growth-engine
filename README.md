# GrowthOS

Website activity tracking and analytics. This is the **auth-free testing build**: the tracking SDK (M1), event ingestion and processing, and the analytics dashboard (M2). The full product spec is in [docs/spec.md](docs/spec.md).

```
website ──SDK──▶ POST /v1/events/batch ──▶ Postgres (raw events, monthly partitions)
                       (api)                  │
                                              ▼
                     BullMQ (Redis) ──▶ worker: sessions + daily rollups
                                              │
                 dashboard ◀── /v1/analytics/* (api, X-Dev-Key)
```

| Package | What it is |
|---|---|
| [packages/sdk](packages/sdk) | Zero-dependency tracker. ESM + script-tag IIFE (about 3 KB gzipped) |
| [packages/shared-types](packages/shared-types) | zod schemas, API types, and URL/bot/device/channel helpers |
| [packages/db](packages/db) | TypeORM migrations, the dedup insert, sessionisation and rollups, seeds |
| [services/api](services/api) | NestJS: ingestion, sites, analytics, `/health`, `/metrics`, `/sdk.js` |
| [services/worker](services/worker) | NestJS standalone + BullMQ: processing, partitions, dead-letter queue |
| [apps/dashboard](apps/dashboard) | React + Ant Design + Recharts dashboard |
| [apps/demo-site](apps/demo-site) | Multi-page site (script-tag install) plus an `/app` SPA (npm install) |

## Local setup

**Prerequisites:** Node 20.19+, pnpm 9 (`corepack enable`), and Docker Desktop running.

```bash
cp .env.example .env          # then set DEV_KEY and VITE_DEV_KEY to the same long random value
pnpm install
pnpm infra:up                 # Postgres on :5433, Redis on :6379
pnpm build
pnpm db:migrate
pnpm db:seed                  # dev organisation + "Demo site" (public id gos_demo_local)
pnpm db:seed-demo             # optional: 4 weeks of synthetic traffic for the demo site
```

Then run each service in its own terminal:

```bash
pnpm --filter @growthos/api dev          # http://localhost:4000
pnpm --filter @growthos/worker dev
pnpm --filter @growthos/dashboard dev    # http://localhost:5180
pnpm --filter @growthos/demo-site dev    # http://localhost:5174
```

To run everything in Docker instead, use `pnpm stack:up`. The API is at :4000 and the dashboard at :5180. The API container runs migrations and the seed on start. Stop it with `pnpm stack:down`.

**Ports:** Postgres is published on **5433**, because a native Postgres often owns 5432. The dashboard uses **5180**, because Vite's default 5173 often clashes with other projects. Change them in `docker-compose.yml` or the Vite configs if needed.

## Create a site and install the snippet

1. Open the dashboard. Click **Add site**, then enter a name, the domain (e.g. `example.com`) and the reporting timezone. Every daily number is bucketed at midnight in that timezone.
2. Copy the snippet into the `<head>` of every page:

   ```html
   <script src="https://YOUR-API-HOST/sdk.js" data-site-id="gos_xxxxxxxxxxxx" async></script>
   ```

   For SPAs and bundlers, install it programmatically instead:

   ```ts
   import GrowthOS from "@growthos/sdk";

   GrowthOS.init({ siteId: "gos_xxxxxxxxxxxx", endpoint: "https://YOUR-API-HOST", consent: "pending" });
   GrowthOS.track("enquiry_submitted", { form: "contact" });
   ```

3. Hook up your consent manager:

   ```js
   GrowthOS.setConsent("granted"); // or "denied"
   ```

   Until consent is granted the SDK is cookieless: it writes no persistent identifiers, and visitors are counted per visit (labelled *estimated*). `GrowthOS.optOut()` and `GrowthOS.optIn()` are also available.

   If you need to call the SDK before the async script has loaded, queue the calls: `window.gosq = [["track", "name", {...}]]`.

The public site id is **not a secret**. It only allows sending events. `POST /v1/sites/:id/rotate-public-id` (or **Sites → Rotate public id**) retires it immediately.

### Script-tag attributes

| Attribute | Default | Meaning |
|---|---|---|
| `data-site-id` | (required) | The site's public id |
| `data-endpoint` | origin of the `src` URL | API base URL |
| `data-consent` | `pending` | Initial consent state |
| `data-spa` | `true` | Track History API route changes |
| `data-auto-pageviews` | `true` | Send a `page_view` on load |
| `data-debug` | `false` | Log to the console |

## Testing on a real website

The SDK only sends to HTTPS endpoints (except `localhost`), so expose the API through a tunnel.

**Only track sites you own or have permission to track.**

**Cloudflare Tunnel** (no account needed for quick tunnels):

```bash
winget install --id Cloudflare.cloudflared      # macOS: brew install cloudflared
cloudflared tunnel --url http://localhost:4000  # prints https://<random>.trycloudflare.com
```

**ngrok** (needs a free account and authtoken):

```bash
winget install ngrok.ngrok                      # macOS: brew install ngrok
ngrok config add-authtoken <token>
ngrok http 4000                                 # prints https://<random>.ngrok-free.app
```

Then:

1. In `.env`, set `PUBLIC_API_URL=https://<tunnel-host>` and `TRUST_PROXY=true`, and restart the API. Snippets now point at the tunnel, and rate limits see the real client IP.
2. Create a site whose **domain is the real site's domain**. That's how internal referrers are recognised.
3. Paste the snippet into the real site. If the site has a Content-Security-Policy, allow the tunnel host in `script-src` and `connect-src`.
4. Keep the dashboard local. It talks to `localhost:4000` with your dev key, which never leaves your machine.

Quick tunnel URLs change every time you restart `cloudflared`. When that happens, update `PUBLIC_API_URL` and the snippet on the real site.

## Verify that events arrive

- **Dashboard:** open **Sites → Verify installation** (or the empty state on any report). It shows when the latest event was received. **Realtime** lists events within seconds. Other reports update once the worker has processed them, which takes a few seconds.
- **API:**

  ```bash
  curl -H "X-Dev-Key: $DEV_KEY" http://localhost:4000/v1/sites/<site-uuid>
  ```

  Check `last_event_received_at` in the response.
- **Database:**

  ```bash
  docker compose exec postgres psql -U growthos -c "select event_name, page_path, received_at from events order by received_at desc limit 20"
  ```

- **Browser:** add `data-debug="true"`. The console logs every queued event, and a `POST /v1/events/batch` appears in the network tab every 5 seconds, or as a beacon when the tab closes.

### If nothing arrives

| Symptom | Likely cause |
|---|---|
| 404 `unknown_site` | Wrong or rotated `data-site-id` |
| 403 `site_inactive` | **Sites →** turn **Accepting events** back on |
| 202 with `dropped_bots > 0` | The user agent looks automated. curl, headless Chrome and Playwright are all dropped on purpose. Test with a real browser |
| No request at all | Ad blocker, CSP, or an `http://` endpoint on an `https://` page |
| Events stored but reports empty | The worker isn't running. Check the `growthos_backlog` gauges on `/metrics` |

## API reference

Every route except `POST /v1/events/batch`, `GET /health` and `GET /sdk.js` requires `X-Dev-Key: <DEV_KEY>`.

| Method and path | Purpose |
|---|---|
| `POST /v1/events/batch` | Public ingestion. CORS open, max 50 events / 64 KB. Returns `202 {accepted, duplicates, rejected[], dropped_bots}` |
| `GET /health` | DB + Redis status (503 when degraded) |
| `GET /metrics` | Prometheus text: ingestion counters and latency, queue depth, dead-letter queue, backlog |
| `POST /v1/sites` · `GET /v1/sites` · `GET /v1/sites/:id` · `PATCH /v1/sites/:id` | Sites CRUD (the detail view includes the install snippet and the latest event time) |
| `POST /v1/sites/:id/rotate-public-id` | Issue a new public id |
| `DELETE /v1/sites/:id/data` | Delete all analytics data for a site |
| `GET /v1/analytics/overview` | KPIs, timeseries, `compare=previous` |
| `GET /v1/analytics/pages` · `sources` · `events` · `devices` | Reports (`events` accepts `event_name` for a property breakdown) |
| `GET /v1/analytics/realtime?site_id=` | Active visitors in the last 5 minutes plus the latest events (raw) |
| `GET /v1/analytics/export.csv?report=pages\|sources\|events` | CSV of the same range |

Analytics queries take `site_id`, `from` and `to` as **inclusive dates in the site timezone** (`YYYY-MM-DD`). The range is at most 400 days.

## Metric definitions

| Metric | Definition |
|---|---|
| Events | Accepted, non-duplicate, non-bot events |
| Page views | Accepted `page_view` events |
| Sessions | One visitor's events, split after 30 minutes of inactivity (`SESSION_TIMEOUT_MIN`) or at midnight in the site timezone |
| Visitors | Distinct consented `visitor_id`s, plus one per cookieless visit (shown as *estimated*) |
| Bounce | A session with exactly one page view and no other interaction event (custom events and outbound clicks count as interactions) |
| Attribution | Last non-direct touch in the session. Precedence: UTM > referrer > direct. Channels: direct, organic search, paid (from `utm_medium`), social, email, referral, AI assistants, unknown (tagged traffic that matches no rule) |

How the processing works:

- **Raw events are deduplicated** on `(site_id, event_id, event_time)` with `ON CONFLICT DO NOTHING`.
- **The worker rebuilds whole (visitor, local day) units from raw events.** Late events, retries and re-runs are therefore safe. The to-do list lives in Postgres, and Redis only carries wake-up signals; a sweep job every 30 seconds catches anything missed.
- **A visit is stitched when consent is granted part-way through a page.** The page's earlier cookieless events (same in-memory id) are re-keyed to the consented visitor, so the visit stays one session.
- **Rebuild a date range** with:

  ```bash
  pnpm --filter @growthos/worker backfill <site-uuid> <from> <to>
  ```

## Privacy

- **Data minimisation:**
  - Query strings are stripped except `utm_*`, and URL hashes are dropped.
  - Referrers keep only origin and path.
  - Form values and DOM text are never read.
  - Outbound clicks record only host and path.
- **IP addresses are never stored.** They're used only, hashed, as rate-limit keys, and they're never logged.
- **Without consent the SDK writes nothing identifying to storage.** That includes its retry queue.

Sample wording for a site's privacy notice:

> We use GrowthOS, a privacy-friendly analytics tool, to understand how our website is used. Without your consent it does not store cookies or other identifiers on your device. If you accept analytics, a random pseudonymous identifier is stored so we can recognise repeat visits. We never collect form contents, and IP addresses are not stored.

## Tests

`pnpm test` runs everything through Turborepo. It needs `pnpm infra:up`; the test database is `growthos_test` and tests use Redis DB 1.

| Suite | Command | Covers |
|---|---|---|
| shared-types | `pnpm --filter @growthos/shared-types test` | Schemas, URL sanitising, channel, bot and device classification |
| db | `pnpm --filter @growthos/db test` | Dedup, timezone `local_date`, late partition creation, consent stitching, idempotent processing |
| SDK | `pnpm --filter @growthos/sdk test` | Vitest + happy-dom: init, batching, beacon, consent, SPA navigation, outbound clicks, URL sanitising, failure isolation, retry queue, bundle size |
| API e2e | `pnpm --filter @growthos/api test` | Valid, invalid, duplicate, inactive and unknown site, rotate, rate limits, bots, 64 KB limit, dev key; analytics against a **hand-computed fixture** (sessions, bounce, channels, New York midnight boundary, CSV, tenant scoping) |
| worker | `pnpm --filter @growthos/worker test` | Processing job, midnight split, retries, dead-letter queue |
| dashboard | `pnpm --filter @growthos/dashboard test` | Playwright smoke test of every page against seeded data |

Notes on the dashboard smoke test:

- **It reseeds only the demo site.** Other sites aren't touched.
- **It starts the API and dashboard if they aren't already running.**
- **On the first run, install the browser:** `pnpm --filter @growthos/dashboard exec playwright install chromium`.

## Testing-phase rules (spec §3)

- **No user auth.** One `dev` organisation is seeded. Every tenant table still carries `organization_id` and `site_id`, and all org scoping happens in the service layer (`SitesService.getOwned`), so auth (M6) only replaces the dev-key guard.
- **Keep the dev key private.** `VITE_DEV_KEY` is baked into the dashboard bundle, so never deploy the dashboard publicly, and never commit `.env`.

## Not in this build yet

- **From the spec:**
  - Goals and funnels (M3)
  - SEO audit (M4)
  - AI suggestions (M5)
  - Auth (M6)
- **Report filters:** the spec's channel, campaign, device and page-path filters aren't built. Reports filter by site, date range and comparison period only.
- **Automatic retention:** only per-site deletion exists (`DELETE /v1/sites/:id/data`). Automatic retention (proposed: 13 months raw) is an open item in spec §16.
