# GrowthOS

Website activity tracking, analytics, SEO audits and AI growth suggestions. This is the **auth-free testing build**. It covers:

- the tracking SDK, event ingestion and the analytics dashboard (spec M1–M2)
- the SEO audit (M4)
- AI suggestions and Ask AI (M5)
- a per-site knowledge base: brand docs, content rules and Search Console exports from a local folder, used by the AI
- an MCP server so a coding agent (Claude Code) working in the website's repo can fix SEO issues itself

The full product spec is in [docs/spec.md](docs/spec.md).

```
website ──SDK──▶ POST /v1/events/batch ──▶ Postgres (raw events, monthly partitions)
                       (api)                  │
                                              ▼
                     BullMQ (Redis) ──▶ worker: sessions + daily rollups, SEO crawls
                                              │
                 dashboard ◀── /v1/analytics/*, /v1/seo/*, /v1/suggestions, /v1/ai/* (api, X-Dev-Key)
                                                                   │
                                                     Claude (read-only tools, evidence-checked)

local folder (docs, rules, GSC exports) ──worker: chunk + embed locally──▶ Postgres (pgvector) ──▶ AI context

Claude Code in the website repo ──stdio──▶ services/mcp ──HTTP (X-Dev-Key)──▶ api
```

| Package | What it is |
|---|---|
| [packages/sdk](packages/sdk) | Zero-dependency tracker. ESM + script-tag IIFE (about 3 KB gzipped) |
| [packages/shared-types](packages/shared-types) | zod schemas, API types, and URL/bot/device/channel helpers |
| [packages/db](packages/db) | TypeORM migrations, the dedup insert, sessionisation and rollups, seeds |
| [packages/seo](packages/seo) | SEO crawler (robots, sitemap, SSRF guard), HTML parsing, checks, scoring, PageSpeed client |
| [packages/knowledge](packages/knowledge) | Knowledge base: folder walking, Markdown chunking, local embeddings, content-rule and Search Console export parsing |
| [services/api](services/api) | NestJS: ingestion, sites, analytics, SEO audits, AI (suggestions, Ask AI, drafts), knowledge base, coding-agent activity, `/health`, `/metrics`, `/sdk.js` |
| [services/worker](services/worker) | NestJS standalone + BullMQ: processing, partitions, SEO audits, knowledge syncs, dead-letter queue |
| [services/mcp](services/mcp) | MCP server (stdio) that gives a coding agent GrowthOS's findings, drafts, suggestions and knowledge |
| [apps/dashboard](apps/dashboard) | React + Ant Design + Recharts dashboard |
| [apps/demo-site](apps/demo-site) | Multi-page site (script-tag install) plus an `/app` SPA (npm install) |

## Why GrowthOS

Most website-growth work is spread across separate tools. An analytics tool shows *what* happened, an SEO crawler lists *what's wrong*, and an AI chat writes copy that knows nothing about either. Someone still has to connect the dots, write the fix, get it into the code, and check whether it worked. GrowthOS joins those steps into one loop.

| Usually | In GrowthOS |
|---|---|
| Analytics, SEO audits and AI live in different products | One tool. Findings are ranked by **the page's real traffic** from your own analytics, so you fix the pages that matter first |
| AI suggestions are generic and can invent numbers | Every number a suggestion cites is **checked against your data on the server**. Anything that doesn't match is discarded, and you're shown why |
| AI copy ignores the brand's rules | Drafts and suggestions are grounded in the site's **own knowledge base**: brand facts, plans, demand research and compliance rules (banned words and claims) |
| The audit stops at a report, and a developer fixes issues by hand | Through the **MCP server**, a coding agent in the website's repo picks up the findings, writes the fix, checks the copy against the rules, and commits it |
| Nobody checks whether a change worked | **Re-audits** mark issues as new or resolved, and done suggestions show a **before/after** comparison of the chosen metric |
| Analytics needs cookies and a consent trade-off | Cookieless until consent is granted. IP addresses and form values are never stored |
| AI cost is open-ended | A monthly budget and a daily limit per site, every call logged, and local embeddings for the knowledge base at no cost |

### How it drives growth

```
 measure ──▶ find ──▶ prioritise ──▶ fix ──▶ verify ──┐
    ▲                                                 │
    └─────────────────────────────────────────────────┘
```

1. **Measure:** the SDK records real visits, sources and conversions (custom events).
2. **Find:** the SEO audit, Search Console exports and the AI turn that data into concrete issues and opportunities, such as queries sitting just outside page 1, landing pages that bounce, or missing titles on high-traffic pages.
3. **Prioritise:** issues are ranked by severity, confidence, traffic and effort, so effort goes where the return is largest.
4. **Fix:** this is where most tools stop and where the MCP server matters. A coding agent works through the findings in the repo, using drafts and the brand rules, so a fix that would wait in a backlog ships in the same session. More fixes shipped means more pages that rank and convert.
5. **Verify:** after the deploy, the agent (or you) starts a re-audit, and the dashboard shows what was resolved and how the metric moved. That feeds the next round.

The short version: GrowthOS doesn't only tell you what to improve. It gets the improvement into the code and shows whether it paid off.

## Local setup

**Prerequisites:** Node 20.19+, pnpm 9 (`corepack enable`), and Docker Desktop running.

```bash
cp .env.example .env          # then set DEV_KEY and VITE_DEV_KEY to the same long random value
pnpm install
pnpm infra:up                 # Postgres 16 + pgvector on :5433 (image built from docker/postgres), Redis on :6379
pnpm build                    # also builds the MCP server (services/mcp/dist/main.js)
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
| `POST /v1/seo/audits` · `GET /v1/seo/audits?site_id=` · `GET /v1/seo/audits/:id` | Start (409 while one runs) and list SEO audits; detail includes the score, summary and change since the previous audit |
| `GET /v1/seo/audits/:id/findings` · `/pages` · `/page?url=` · `/compare/:prevId` | Findings (with new/unchanged flags), crawled pages, one page's SEO content, and an audit-to-audit diff |
| `POST /v1/seo/findings/:id/draft` | AI-drafted, ready-to-paste copy for a finding (cached; `{"regenerate": true}` to redo) |
| `GET /v1/suggestions?site_id=` · `POST /v1/suggestions/generate` · `PATCH /v1/suggestions/:id` | AI growth suggestions: list, generate (runs in the background), and set status (`new`, `accepted`, `dismissed` or `done`) |
| `POST /v1/ai/ask` · `GET /v1/ai/conversations?site_id=` · `GET /v1/ai/conversations/:id` | Ask AI (pass `conversation_id` to continue a conversation) |
| `GET /v1/ai/status?site_id=` | Whether AI is configured, this month's spend against the budget, and Ask AI questions used today |
| `GET` · `PUT` · `DELETE /v1/sites/:siteId/knowledge` | The site's knowledge source: status and counts, connect a folder (`{name, root_path}`), disconnect |
| `POST /v1/sites/:siteId/knowledge/sync` | Re-read the folder in the background (only changed files are re-embedded) |
| `GET /v1/sites/:siteId/knowledge/search?q=&limit=` | Hybrid search (meaning + exact terms) over the knowledge base |
| `POST /v1/sites/:siteId/knowledge/check` | Content rules (banned words and claims) that `{text}` breaks |
| `GET /v1/sites/:siteId/knowledge/gsc` | Search Console snapshot: top queries, near-page-1 opportunities, top pages, monthly trend |
| `GET /v1/agent?site_id=` · `POST /v1/agent/activity` | Coding-agent setup command and recent activity; the MCP server reports each tool call |

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

## SEO audit

Open **SEO audit** in the dashboard and click **Run audit**. The worker crawls the site's own domain:

- **Scope:** it starts at `https://<domain>/` (or a start URL you give on that domain) and stays on that host. www and non-www count as the same site.
- **Rules it follows:** it obeys `robots.txt` and reads the sitemap. It sends GET requests only, never submits forms, and never changes the site.
- **Limits:** up to 500 pages, about 1.5 requests per second (`SEO_CONCURRENCY`, `SEO_CRAWL_DELAY_MS`).
- **Network safety:** it refuses localhost and private network addresses. The check runs on the address it actually connects to, so redirects and DNS tricks can't get around it. For local testing, `SEO_ALLOW_PRIVATE_HOSTS=true` (your local `.env` has it on, which is how the demo site at `localhost:5174` is audited).
- **What it checks:**
  - **Technical:** robots.txt and the sitemap, status codes and broken internal links, redirect chains, canonicals (including paginated pages), noindex conflicts, HTTPS and www/trailing-slash duplicates, orphan pages, the mobile viewport, and pages whose content is rendered by JavaScript.
  - **On-page:** titles and meta descriptions (missing, length, duplicates), H1s and heading structure (including bold text used as headings), image alt text, structured data (JSON-LD), thin content and test pages.
  - **Performance:** slow responses, render-blocking resources, very large HTML, and Core Web Vitals from Google PageSpeed Insights for the top pages. That last one only works for public sites; set `PAGESPEED_API_KEY` for a higher quota.
- **Each finding has** evidence, a severity, an explanation, a concrete fix, a confidence and limits. Findings are ranked by severity × confidence × **the page's real traffic from your analytics** ÷ effort. The 0–100 score caps how much any single check can cost, so one noisy check can't sink it.
- **Page explorer:** each crawled page's title, description, canonical, robots, heading outline, links, images and structured data, with a Google-style result preview.
- **Re-audit:** run the audit again after applying fixes. The dashboard marks findings as new or resolved.

Search Console (spec §7.2) has no live API connection yet. Exports placed in the site's knowledge base are imported instead; see [Knowledge base](#knowledge-base).

## AI insights

AI runs behind a provider-agnostic `LlmProvider` interface (spec §8.4). Set one key in `.env` and restart the API. Without one, the AI pages show setup steps and the endpoints answer `503 ai_not_configured`.

| `AI_PROVIDER` | Key | Default model | Notes |
|---|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-opus-5-5` | Native structured output, prompt caching, refusal fallbacks |
| `groq` | `GROQ_API_KEY` (`gsk_…`) | `openai/gpt-oss-120b` | OpenAI-compatible API. Free-tier keys are limited to about 8,000 tokens per minute, so a long Ask AI answer can take up to a minute while the server waits out the limit |
| `xai` | `XAI_API_KEY` (`xai-…`) | `grok-4` | OpenAI-compatible API (Grok) |

`AI_PROVIDER` defaults to the first provider that has a key. `AI_MODEL` overrides the model, and `AI_PRICE_INPUT_PER_MTOK` / `AI_PRICE_OUTPUT_PER_MTOK` set prices for the budget meter if your model or plan differs. Ask AI conversations remember which provider wrote them; after a switch they continue with a fresh model history, and the visible transcript is kept.

- **Growth suggestions:**
  - **What it reads:** the last 28 days against the 28 before (overview, landing pages, channels, campaigns, referrers, events, which pages custom events happen on, devices) plus the latest SEO audit's top findings. Every number is a fact with an ID (for example `landing:/pricing.bounce_rate`).
  - **What comes back:** prioritised SEO, content and marketing suggestions. Each one cites facts by ID and value.
  - **The safeguard:** the server checks every cited ID and value against the data, discards anything that doesn't match, and shows why. Links to reports are computed by the server, not taken from the model.
  - **Tracking:** mark suggestions `accepted`, `dismissed` or `done`. Once done, a before/after comparison of the chosen metric appears as data comes in.
- **Ask AI:**
  - **Tools:** the model answers through read-only tools (overview, top pages, landing pages, sources, events, devices, compare periods, SEO findings, and, when the site has a knowledge base, knowledge search and Search Console). These call the same services as the reports, so numbers match the dashboard.
  - **Site scoping:** the site is fixed by the server, and the model can't choose or change it.
  - **Answer format:** answers state the date range, separate facts from hypotheses, say plainly when data isn't available (goals, revenue, rankings), and link to the relevant report.
- **Draft fix with AI:** on title, meta description, heading, alt-text, structured-data and thin-content findings, Claude writes ready-to-paste copy from the page's crawled text (and the site's brand and compliance knowledge, when connected). You apply it yourself; GrowthOS never writes to your site.
- **Knowledge:** when a site has a knowledge base, suggestions get the most relevant passages (up to `KNOWLEDGE_CONTEXT_TOKENS`) and cite the ones they used. Passages are treated as reference material, never as instructions.
- **Guard rails:**
  - **Budget:** a monthly spend cap per site (`AI_MONTHLY_BUDGET_USD`, default $20) and a daily Ask AI limit (`AI_ASK_DAILY_LIMIT`, default 50), both computed from logged token usage.
  - **Audit log:** every model call and tool call is recorded (`ai_calls`, `ai_tool_calls`). The log is kept even when a site's data is deleted.
  - **Prompt injection:** website and visitor text (page content, titles, event names) is passed inside tagged data blocks that the instructions say never to obey.
  - **Refusals:** on Claude, a declined request can be retried on a fallback model (`server-side-fallback`, default routing).
  - **Rate limits:** on Groq and xAI, rate limits (429) are waited out using the reset time the provider sends. Output that doesn't match the expected format gets one corrective retry.

**Rough costs at Claude Opus 5.5 prices** (the dashboard shows actual spend). On Groq the same work costs well under a cent per call:

| Action | Cost |
|---|---|
| Generating suggestions | $0.20–0.60 per run |
| One Ask AI question | $0.02–0.20 |
| One draft | about $0.01 |

**Accuracy check (costs money):** `pnpm ai:eval [site-uuid]` asks about 30 questions whose answers come from the analytics API. It checks that the numbers appear in the answers, that missing data is admitted, and that a planted prompt injection is ignored. It prints the pass rate and the cost of the run.

## Knowledge base

Each site can be connected to one local folder, such as a growth or content-strategy repo. Open **Knowledge** in the dashboard, give the folder path, and click **Sync**.

- **Allowed folders:** a path is accepted only if it's inside `KNOWLEDGE_ALLOWED_ROOTS` (separate several with `;`). Empty means the feature is off.
- **What's read:**
  - `.md`, `.mdx` and `.txt` files are chunked by heading and embedded **locally** (`Xenova/bge-small-en-v1.5`, about 34 MB, downloaded on first use to `EMBEDDING_CACHE_DIR`). No API key, no cost.
  - `.mjs` rule files become content rules: banned words and claims, each with a pattern, severity and reason.
  - `.json` files that look like Search Console exports (recognised by shape, e.g. `"source": "gsc"` with `keywords` or `pages`, or a list of `{month, clicks, impressions}`) are imported as queries, pages and a monthly trend.
- **What's skipped:** `.git`, `node_modules`, build output, `secrets`, `state`, `src` and test folders, and files over 1.5 MB.
- **Re-syncs** only re-embed files that changed. Rules and Search Console exports are re-imported whole.
- **Search** is hybrid: pgvector similarity for meaning plus Postgres full text for exact terms, merged by rank.
- **Where it shows up:** the home dashboard's **Google search** card, the Knowledge page, suggestions, Ask AI, drafts, and the MCP server.

## Coding agent (MCP)

[services/mcp](services/mcp) lets Claude Code, opened in a site's **website repo**, use what GrowthOS knows to fix issues itself: it lists findings, fetches drafts, searches the knowledge base, checks new copy against the content rules, and re-runs the audit after a deploy. The agent edits, commits and opens merge requests with your own git login. GrowthOS never writes to the repo.

```bash
pnpm --filter @growthos/mcp build            # already done by pnpm build
cd <website repo>
claude mcp add growthos --scope local -- node <growthOs>/services/mcp/dist/main.js
```

Use `--scope local` (or `user`), not `project`, so nothing is written into the client's repo. The **Knowledge** page shows the exact command for your checkout, whether an agent has been active, and its last 15 actions. The activity log stores a short summary per tool call, never the copy itself, and keeps 30 days.

The server reads `DEV_KEY` and `API_PORT` from the root `.env`. `GROWTHOS_API_URL` and `GROWTHOS_SITE` (id, name or domain) override the API URL and default site. Tools and details are in [services/mcp/README.md](services/mcp/README.md).

**Confidentiality:** knowledge passages and Search Console figures are internal. The server tells the agent to use them for decisions but never to paste them into code, comments, commits or merge-request descriptions.

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
| seo | `pnpm --filter @growthos/seo test` | Crawler against a local fixture site with planted issues: robots respected, GET only, redirect chains, page limit, SSRF guard; every expected finding, no false positives (decorative alt, localhost HTTPS), JavaScript-rendered pages, scoring, PageSpeed parsing |
| API e2e (SEO, AI) | `pnpm --filter @growthos/api test` | SEO endpoints, 409 while an audit runs, domain-only start URLs, audit diff, tenant scoping. AI with a **scripted provider (no API cost)**: invented numbers and unknown facts dropped, cost logging, status and before/after, tools fixed to the site, untrusted text fenced, drafts cached, budget and daily limits, 503 without a key |
| worker | `pnpm --filter @growthos/worker test` | Processing job, midnight split, retries, dead-letter queue, a full SEO audit run against the fixture site |
| dashboard | `pnpm --filter @growthos/dashboard test` | Playwright smoke test of every page against seeded data |
| AI accuracy (opt-in, paid) | `pnpm ai:eval` | About 30 questions with known answers against real Claude |

Notes on the dashboard smoke test:

- **It reseeds only the demo site.** Other sites aren't touched.
- **It starts the API and dashboard if they aren't already running.**
- **On the first run, install the browser:** `pnpm --filter @growthos/dashboard exec playwright install chromium`.

## Testing-phase rules (spec §3)

- **No user auth.** One `dev` organisation is seeded. Every tenant table still carries `organization_id` and `site_id`, and all org scoping happens in the service layer (`SitesService.getOwned`), so auth (M6) only replaces the dev-key guard.
- **Keep the dev key private.** `VITE_DEV_KEY` is baked into the dashboard bundle, so never deploy the dashboard publicly, and never commit `.env`.

## Not in this build yet

- **From the spec:**
  - Goals and funnels (M3). AI suggestions use custom events as stand-ins for conversions until then.
  - A live Search Console connection (M4). Only exports placed in the knowledge base are imported.
  - Auth (M6)
- **SEO crawler:** it doesn't run JavaScript. Pages rendered by JavaScript are flagged, and their content checks are marked low-confidence; rendering them with Playwright is not built.
- **Report filters:** the spec's channel, campaign, device and page-path filters aren't built. Reports filter by site, date range and comparison period only.
- **Automatic retention:** only per-site deletion exists (`DELETE /v1/sites/:id/data`). Automatic retention (proposed: 13 months raw) is an open item in spec §16.
