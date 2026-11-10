# GrowthOS AI — Product & Technical Specification (v2)

**Status:** Approved build scope · **Version:** 2.0 · **Updated:** 2026-11-10
**Supersedes:** "GrowthOS AI — Six Module Product & Technical Specification" (v1)

---

## 0. What changed from v1

| Area | v1 | v2 (this document) |
|---|---|---|
| Positioning | Six-module SaaS | Same product, built in a **separate standalone repo**, usable on any website |
| Backend | Python / FastAPI | **NestJS + TypeORM + PostgreSQL** |
| Dashboard | Next.js | **React + Vite + Ant Design** (auth-gated SPA, no SSR needed) |
| Queue | "Add when needed" | **Redis + BullMQ from day one** |
| AI provider | OpenAI | **Provider-agnostic `LlmProvider` interface** |
| Auth | Full auth + RBAC from the start | **Auth-free testing phase** (dev key guard); auth added in the last phase |
| SEO changes | AI drafts, approval, then apply | **Suggestions only.** The client applies changes themselves. No writes to customer sites |
| Marketing actions | Approval + execution layer | **Suggestions only**, with status tracking. No execution integrations |
| Delivery | Phase by phase | **Module by module, each tested on a real website** before the next starts |

---

## 1. Product Overview

GrowthOS AI helps a business understand and improve its website. A lightweight SDK tracks visitor
activity. The platform turns that activity into analytics, audits the site's SEO, and uses AI to
give evidence-based suggestions for SEO and marketing.

**Positioning:** an AI-powered website growth platform that turns website data into actionable
decisions.

It is industry-agnostic. Example customers include e-commerce, real estate, SaaS, education,
healthcare, travel and professional services.

### 1.1 Scope (this release)

1. **Tracking SDK:** collects page views, sessions, attribution and custom events.
2. **Event ingestion and processing:** validates, deduplicates, stores and aggregates events.
3. **Analytics dashboard:** reports on traffic, pages, sources, events, goals and funnels.
4. **SEO audit:** crawls the site, runs technical and on-page checks, and reads Search Console data (optional).
5. **AI insights and suggestions:** prioritised SEO and marketing suggestions, plus an "Ask AI" assistant, all grounded in real data.
6. **Auth and multi-tenancy:** added after modules 1–5 are proven.

### 1.2 Goals

- One SDK that works on any website (static, WordPress, SPA, Next.js and so on).
- Privacy-conscious, consistent, deduplicated event data.
- Accurate analytics with documented metric definitions.
- Repeatable SEO findings, each tied to evidence on a specific URL.
- AI suggestions that cite evidence and never invent numbers.
- Each module usable and verified on a real website before the next is built.

### 1.3 Non-goals (this release)

- Writing changes to customer websites, whether through CMS integrations, plugins or auto-publishing.
- Launching ads, sending emails or messaging the customer's own customers.
- Replacing a CRM, ad platform, marketing automation suite or backlink tool.
- Collecting form contents, passwords, payment data, health data or government IDs.
- Claiming causation from correlation.
- Fingerprinting.

---

## 2. Delivery Plan

| # | Module | Done when (tested on a real website) |
|---|---|---|
| **M1** | SDK + ingestion | Events from a real site land in Postgres; duplicates, invalid payloads and bots are handled |
| **M2** | Analytics dashboard | Overview, pages, sources, events, devices and realtime show correct numbers against fixtures and real traffic |
| **M3** | Goals and funnels | The client defines goals and funnels from their own event names; counts and drop-off are correct |
| **M4** | SEO audit | A URL is crawled, and findings with evidence and severity appear in the dashboard; GSC data appears once connected |
| **M5** | AI insights and suggestions | Prioritised SEO and marketing suggestions with evidence; Ask AI answers match the analytics APIs |
| **M6** | Auth, RBAC, multi-tenant hardening | Logins, organisations, roles, RLS and cross-tenant tests pass; dev-key guard removed |

M1 and M2 are built together as the first build.

---

## 3. Testing Phase Rules (M1–M5)

- **No user auth, RBAC or RLS yet.**
- Every tenant table still carries `organization_id` and `site_id`. One `dev` organisation is seeded.
- All org and site scoping lives in **service-layer methods**, never in ad-hoc controller queries, so M6 only changes how the org is resolved.
- **All read and admin APIs require the `X-Dev-Key` header** (env `DEV_KEY`). The dashboard sends it from env.
- `POST /v1/events/batch` is public (CORS open) and validated by site `public_id`.
- **Real-site testing:** only on sites we own or have permission to track. Expose the API through a VM, Cloudflare Tunnel or ngrok over HTTPS.
- Real visitor data is involved, so the dev key is never committed and never shared outside the team.

---

## 4. Module 1 — Tracking SDK

### 4.1 Installation

Script tag:

```html
<script src="https://<cdn-or-api-host>/sdk.js" data-site-id="YOUR_PUBLIC_SITE_ID" async></script>
```

Programmatic:

```ts
import GrowthOS from "@growthos/sdk";

GrowthOS.init({ siteId: "YOUR_PUBLIC_SITE_ID", endpoint: "https://api.example.com", consent: "pending" });
GrowthOS.track("enquiry_submitted", { form: "contact" });
```

The public site ID is **not a secret** and grants no access to dashboard or admin APIs.

### 4.2 Interface

```ts
type ConsentState = "granted" | "denied" | "pending";

type GrowthOSConfig = {
  siteId: string;
  endpoint?: string;
  autoPageviews?: boolean;   // default true
  spa?: boolean;             // default true
  consent?: ConsentState;    // default "pending" (cookieless)
  debug?: boolean;
};

type EventProperties = Record<string, string | number | boolean | null>;

interface GrowthOSClient {
  init(config: GrowthOSConfig): void;
  track(eventName: string, properties?: EventProperties): void;
  page(): void;
  setConsent(state: ConsentState): void;
  optOut(): void;
  optIn(): void;
  flush(): Promise<void>;
  version: string;
}
```

### 4.3 Capabilities

- Automatic `page_view`, including SPA route changes (History API patch plus `popstate`).
- Automatic `outbound_click`, recording host and path only (covers app-store links, partner links and similar).
- Referrer and UTM capture (`utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`).
- Coarse device category (desktop, mobile or tablet).
- `visitor_id` and `session_id` **only when consent is granted**; otherwise cookieless mode with no persistent identifiers.
- Batching: flush every 5 seconds or 10 events, `sendBeacon` on `pagehide`, `fetch` with `keepalive` as fallback.
- Bounded localStorage retry queue with backoff and a size cap.
- `event_id = crypto.randomUUID()` for deduplication.
- Debug mode and SDK version reporting.

### 4.4 Privacy and reliability

- Never collect form values, passwords, payment data or arbitrary DOM text.
- Strip all query parameters except the `utm_*` allowlist, and drop URL hashes.
- No fingerprinting.
- Every public method is wrapped in try/catch, so the SDK **never breaks the host page**.
- Non-blocking: async load, no render-blocking work.
- Target size **under 5 KB gzipped**.
- HTTPS only.

### 4.5 Acceptance criteria

- Script-tag and programmatic installs both work.
- Page views fire on initial load and on SPA navigation.
- Custom events are sent with validated properties.
- When consent is not granted, no persistent identifiers are written.
- Network failure or a thrown error never affects the host page.
- Duplicate `event_id`s are safe end to end.

---

## 5. Module 2 — Event Ingestion and Processing

### 5.1 Pipeline

1. The SDK sends a batch over HTTPS.
2. The API validates payload size, schema, site status and rate limits.
3. Site and organisation are resolved from **server-side records**. A browser-supplied org ID is never trusted.
4. Events are normalised, bots are filtered out, and duplicates are removed.
5. The raw events are bulk-inserted.
6. A processing job is enqueued.
7. The worker runs sessionisation and updates the rollups.
8. Analytics APIs read the rollups.

### 5.2 Event schema

| Field | Description |
|---|---|
| `event_id` | Unique ID used for deduplication |
| `site_id` | Registered site (resolved from `public_id`) |
| `event_name` | e.g. `page_view`, `outbound_click`, custom |
| `event_time` | Client event time |
| `received_at` | Server receipt time (set by server) |
| `visitor_id` | Pseudonymous ID, only if consent granted |
| `session_id` | Session ID, only if consent granted |
| `page_url` | Sanitised URL |
| `page_path` | Normalised path |
| `referrer` | Sanitised referrer |
| `utm_source` / `utm_medium` / `utm_campaign` / `utm_term` / `utm_content` | Campaign attribution |
| `device_category` | desktop, mobile or tablet |
| `properties` | Validated custom properties (jsonb) |
| `consent_state` | granted, denied or pending |
| `schema_version` | Event schema version |

### 5.3 API

`POST /v1/events/batch`

```json
{
  "site_id": "site_public_123",
  "schema_version": 1,
  "events": [
    {
      "event_id": "0b6c…",
      "event_name": "page_view",
      "event_time": "2026-11-10T10:30:00Z",
      "page_path": "/products/example",
      "properties": { "page_type": "product" }
    }
  ]
}
```

The response is `202 { accepted, duplicates, rejected: [{ event_id, reason }] }`.

### 5.4 Rules

- Maximum batch size is 50 events or 64 KB.
- Schema validation uses zod, with schemas shared through `packages/shared-types`.
- Inactive or unknown sites are rejected.
- Rate limits apply per site and per IP.
- **Bot filtering:** a known user-agent list plus headless-browser markers. Dropped bots are counted and reported, not stored as events.
- Deduplication uses a unique `(site_id, event_id, event_time)` key with `ON CONFLICT DO NOTHING`.
- Origin checks are only an abuse signal, not authentication.
- Failed jobs retry with backoff and then go to a dead-letter queue.
- Retention and deletion are supported per site.
- Structured logs (pino), a `/health` endpoint, and metrics for ingestion latency, error rate and queue backlog.

### 5.5 Storage

- `events` is partitioned monthly by `event_time`, with a BRIN index on `event_time` and a b-tree index on `(site_id, event_time)`.
- A worker job creates the next month's partition ahead of time.
- TypeORM migrations only; `synchronize` is never used.
- ClickHouse is evaluated only at measured scale.

### 5.6 Acceptance criteria

- Valid batches are accepted and invalid ones are rejected with useful errors.
- Duplicates are never counted twice.
- Events are attached to the correct organisation and site.
- Rate limits and payload limits are enforced.
- Bots are dropped and counted.
- Temporary failures retry safely.
- Ingestion latency, errors and backlog are observable.

---

## 6. Module 3 — Analytics Dashboard

### 6.1 Processing

- **Sessionisation:** a session ends after 30 minutes of inactivity (configurable) or at midnight in the **site's timezone**.
- **Channel classification:** direct, organic search, paid (from `utm_medium`), social, email, referral, AI assistants (chatgpt.com, perplexity.ai, gemini and similar) and unknown.
- **Rollups:** `agg_daily_site`, `agg_daily_page`, `agg_daily_source` and `agg_daily_event`, bucketed in the site's timezone. They are recomputed incrementally and are idempotent.

### 6.2 Dashboard pages

- **Overview:** visitors, sessions, page views, conversions and conversion rate, engagement metrics, a timeseries chart, and a comparison with the previous period.
- **Realtime:** active visitors in the last 5 minutes and the latest events.
- **Pages:** top pages, landing pages and exit pages.
- **Sources:** channels, referrers and UTM campaigns.
- **Events:** custom event breakdowns.
- **Devices:** device category breakdown.
- **Goals and funnels (M3):** see §6.4.
- **Sites:** add a site, view the install snippet, and verify the install (shows when the latest event was received).

**Filters** are date range (with presets), comparison period, site, channel, campaign, device and page path.
Every report can be exported as CSV.

### 6.3 Metric definitions

| Metric | Definition |
|---|---|
| Events | Accepted, non-duplicate, non-bot events |
| Page views | Accepted `page_view` events |
| Sessions | Per the sessionisation rule in §6.1 |
| Visitors | Distinct pseudonymous `visitor_id`s. Cookieless traffic is counted per session, and the dashboard labels it as estimated |
| Landing page | First page view in a session |
| Bounce | A session with exactly one page view and no other interaction event. Always labelled with this definition |
| Conversion | An event matching a configured goal |
| Conversion rate | Always shown with its denominator (sessions, visitors or funnel entrants) |
| Attribution | Last non-direct touch within the session, with a documented precedence: UTM > referrer > direct |

### 6.4 Goals and funnels (M3)

Clients define goals and funnels from their own event names, and the platform makes no business-model
assumptions. Templates are provided, for example:

| Industry | Example funnel |
|---|---|
| E-commerce | `product_viewed` → `add_to_cart` → `checkout_started` → `purchase_completed` |
| Real estate | `property_viewed` → `enquiry_submitted` → `site_visit_booked` |
| SaaS / app | `pricing_viewed` → `signup_started` → `signup_completed` (or `outbound_click` to an app store) |
| Education | `course_viewed` → `application_started` → `application_submitted` |

Funnels show counts, step-to-step conversion and drop-off.

### 6.5 Analytics API

All endpoints take `site_id`, `from`, `to` and an optional `compare` and filters. The date range is limited to 400 days.

- `GET /v1/analytics/overview`
- `GET /v1/analytics/pages`
- `GET /v1/analytics/sources`
- `GET /v1/analytics/events`
- `GET /v1/analytics/devices`
- `GET /v1/analytics/realtime`
- `GET /v1/analytics/funnels/:id`
- `GET /v1/analytics/export.csv?report=…`

### 6.6 Acceptance criteria

- Values reconcile with a deterministic fixture dataset whose expected metrics were computed by hand.
- Timezone day boundaries are correct.
- Filters and comparison periods are correct.
- Exports match the on-screen filters.
- Funnel counts and drop-off are correct.

---

## 7. Module 4 — SEO Audit

### 7.1 Crawler

- Starts from the site's registered domain and stays on that host.
- Respects `robots.txt`.
- Reads the XML sitemap and follows internal links.
- Default limits are 500 pages per audit, a configurable depth, concurrency of 2, and 1–2 requests per second.
- Records status, timing and the redirect chain for every URL.
- Never submits forms or takes any action on the site.
- Can be triggered by the user or run on a schedule.
- Static HTML parsing (Cheerio) by default, with Playwright rendering only when a page needs JavaScript to show its content.
- Runs as BullMQ jobs.

### 7.2 Checks

**Technical**
- HTTP status codes and broken internal links.
- Redirect chains.
- Canonical tags.
- Robots meta and `X-Robots-Tag` headers.
- Sitemap availability and validity.
- Indexability.
- HTTPS and URL consistency (trailing slash, www).
- Orphan pages (in the sitemap but not linked from anywhere).
- Paginated pages that canonicalise away from themselves.
- Thin pages and test pages that return 200.

**On-page**
- Title present, with length guidance.
- Meta description present, with length guidance.
- H1 present and heading structure valid (for example, subheads written as bold text instead of H2s).
- Duplicate titles and descriptions.
- Image alt attributes.
- Internal-link opportunities.
- Structured data detected and valid.

**Performance**
- Core Web Vitals via the PageSpeed Insights API for key pages.
- Page weight, including render-blocking fonts and scripts.

**Search performance** (optional, after the client connects Google Search Console through OAuth)
- Clicks, impressions, CTR and position, by query and by page.
- Trends over time.
- Always labelled as **external search data**, never mixed with SDK numbers.

### 7.3 Finding format

| Field | Content |
|---|---|
| URL | The affected page |
| Category | technical, on-page, performance or search |
| Check | The ID of the check that produced it |
| Evidence | What was observed (the actual title, status, header, etc.) |
| Severity | critical, high, medium or low |
| Explanation | Why it matters |
| Suggested fix | A concrete correction. For text fixes, ready-to-paste copy |
| Confidence / limits | Caveats |
| Audit time | Timestamp |

Findings are prioritised by impact, confidence and effort. **Ranking improvements are never promised.**

### 7.4 Suggestions only (no writes)

The AI may draft titles, meta descriptions, heading changes, alt text, internal-link suggestions and
structured-data snippets. These are **copyable suggestions** that the client applies themselves.
The platform never writes to a customer's site.

### 7.5 Re-audit and comparison

Running an audit again shows which findings were resolved, which are new and which are unchanged. This
is how the client sees whether the fixes they applied actually landed.

### 7.6 Acceptance criteria

- The crawler stays in scope and respects robots and rate limits.
- Results are repeatable on known test sites.
- Every finding links to a URL with its evidence.
- GSC data appears only after explicit authorisation.
- The re-audit comparison is correct.

---

## 8. Module 5 — AI Insights and Suggestions

### 8.1 Suggestion feed

The AI produces a prioritised list of suggestions from three sources: analytics trends, SEO
findings and GSC data. Each suggestion falls into one of these areas:

- **SEO:** for example, rewriting duplicate titles, fixing broken links on high-traffic pages, or targeting queries that get impressions but a low CTR.
- **Content:** for example, improving pages that get traffic but no conversions, covering topic gaps, or adding internal links.
- **Marketing:** for example, a campaign that brings visits but no conversions, a channel mix that relies too heavily on one source, a funnel step with unusually high drop-off, or a landing page to test.

### 8.2 Suggestion format

| Field | Purpose |
|---|---|
| Title | A short description of the opportunity |
| Area | SEO, content or marketing |
| Evidence | The metrics or findings behind it, with links to the dashboard report or finding |
| Suggested action | What the client could do, including copy where useful |
| Expected outcome | Qualified and never guaranteed |
| Priority / effort / confidence | Used for ranking |
| Measurement plan | Which metric to watch, and over what period |
| Status | new, accepted, dismissed or done (set by the client) |

When the client marks a suggestion as **done**, the platform records the date and shows a
before/after comparison of the measurement metric once enough data exists.

### 8.3 Ask AI (assistant)

The client asks a question in plain language, for example "Which landing pages get traffic but no
enquiries?". The answer is built as follows:

1. The backend resolves the organisation and site from the request context. **The model never chooses tenant or site IDs.**
2. The model picks from read-only tools: `get_overview`, `get_traffic_sources`, `get_top_pages`, `get_landing_pages`, `get_event_breakdown`, `get_funnel`, `compare_periods`, `get_seo_findings` and `get_gsc_performance`.
3. Each tool has a strict input schema and a bounded date range. Every result includes `{ data, siteId, dateRange, metricDefinitions }`.
4. The answer states the site and date range, separates measured facts from hypotheses, and links to the relevant report.

### 8.4 Trust and safety

- The AI never invents metrics or implies it has data it did not retrieve.
- It makes no causal claims based on correlation alone.
- Page content, crawled HTML and event properties are treated as **untrusted input**, which guards against prompt injection.
- Tools are allowlisted, every AI call is audit-logged, and there are per-site request limits and a cost budget.
- Providers are swappable behind `LlmProvider`.

### 8.5 Acceptance criteria

- Numbers in answers match the analytics APIs.
- Date ranges and timezones are correct.
- Missing data is stated clearly.
- Every suggestion cites real evidence.
- Prompt-injection test pages do not change the AI's behaviour.

---

## 9. Module 6 — Auth and Multi-Tenancy (last)

- **Entities:** Organization, User, OrganizationMembership and Site.
- **Roles:** Owner, Admin, Analyst, Developer and Viewer, all enforced in the backend.
- **Auth:** JWT access tokens plus refresh tokens, or Better Auth.
- The organisation is resolved from the session, which **replaces** the `X-Dev-Key` guard.
- PostgreSQL row-level security as defence in depth, using `SET LOCAL app.org_id` per request or job.
- Automated cross-tenant tests on every API and every worker job.
- GSC OAuth tokens are encrypted at rest.
- Audit log for integrations, AI calls and suggestion status changes.

---

## 10. Architecture

```
Client website ──SDK──▶ Ingestion API ──▶ Postgres (raw events) ──▶ Worker (sessions, rollups)
                                                                         │
Site URL ──▶ SEO crawler (BullMQ) ──▶ Findings ◀── GSC (OAuth, optional) │
                                          │                              ▼
                                          └──────────▶ AI layer ◀── Analytics API
                                                          │
                                                          ▼
                                     Dashboard: Analytics · SEO · Suggestions · Ask AI
```

### 10.1 Stack

| Layer | Technology |
|---|---|
| SDK | TypeScript, zero dependencies, Vite library mode (ESM + IIFE) |
| Shared types | zod schemas in `packages/shared-types` |
| API | NestJS, TypeORM, PostgreSQL 16 |
| Worker | NestJS standalone, BullMQ, Redis |
| Dashboard | React, Vite, TypeScript, Ant Design, Recharts, TanStack Query, Zustand |
| Crawler | Cheerio, with Playwright when rendering is needed |
| AI | `LlmProvider` interface with tool calling |
| Infrastructure | Docker Compose locally; a single VM or PaaS for beta |
| Observability | pino logs, metrics, error monitoring |

### 10.2 Repository structure

```
growthos/
  apps/
    dashboard/
    demo-site/
  services/
    api/          # ingestion, analytics, sites, seo, ai endpoints
    worker/       # sessionisation, rollups, crawler, ai jobs
  packages/
    sdk/
    shared-types/
  docs/
    spec.md
  docker-compose.yml
  .env.example
  README.md
```

---

## 11. Data Model

| Table | Purpose |
|---|---|
| `organizations` | One `dev` organisation is seeded during testing |
| `sites` | `id, organization_id, name, domain, public_id, status, timezone` |
| `events` | Raw events, partitioned monthly |
| `sessions` | Derived by the worker |
| `agg_daily_*` | Rollups for site, page, source and event |
| `goals`, `funnels` | Client-defined (M3) |
| `seo_audits`, `seo_pages`, `seo_findings` | Audit runs and their results (M4) |
| `integration_connections` | GSC OAuth connections, encrypted (M4) |
| `suggestions` | AI suggestions with status and measurement plan (M5) |
| `ai_conversations`, `ai_tool_calls` | Ask AI history and audit trail (M5) |
| `users`, `memberships`, `audit_log` | Added in M6 |

Every customer-owned row carries `organization_id`, and `site_id` where relevant.

---

## 12. API Surface

| Area | Endpoints |
|---|---|
| Sites | `POST /v1/sites`, `GET /v1/sites`, `GET /v1/sites/:id`, `POST /v1/sites/:id/rotate-public-id` |
| Events | `POST /v1/events/batch` (public) |
| Analytics | `/v1/analytics/overview`, `pages`, `sources`, `events`, `devices`, `realtime`, `funnels/:id`, `export.csv` |
| Goals and funnels | `GET/POST/PATCH/DELETE /v1/goals`, `/v1/funnels` |
| SEO | `POST /v1/seo/audits`, `GET /v1/seo/audits/:id`, `GET /v1/seo/audits/:id/findings`, `GET /v1/seo/audits/:id/compare/:prevId`, `POST /v1/integrations/gsc/connect` |
| AI | `GET /v1/suggestions`, `PATCH /v1/suggestions/:id` (status), `POST /v1/suggestions/generate`, `POST /v1/ai/ask` |

During testing, everything except `/v1/events/batch` requires `X-Dev-Key`.

---

## 13. Security and Privacy

- HTTPS everywhere, with strict input validation and rate and size limits.
- Data minimisation: no PII by default, cookieless unless consent is granted, query strings stripped.
- Consent-aware SDK that is compatible with consent managers (for example, held back until consent is given).
- Clients are responsible for disclosing the tracking in their own privacy notice. The docs provide sample wording.
- IP addresses are used only transiently for rate limiting and bot detection, and are never stored in raw form.
- Secrets live in environment variables or a secrets manager. OAuth tokens are encrypted at rest.
- Retention and deletion per site, with data export.
- Backups with tested restores before any client goes live.

---

## 14. Testing Strategy

| Area | Tests |
|---|---|
| SDK | Vitest + happy-dom: init, batching, consent, SPA navigation, URL sanitising, failure isolation, bundle size |
| Ingestion | e2e: valid, invalid, duplicate, inactive site, rate limit, bot filtering |
| Analytics | A deterministic fixture dataset with hand-computed expected values for sessions, bounce, channels, timezone boundaries and funnels |
| SEO | Known test sites with expected findings; robots and scope rules; re-audit comparison |
| AI | An evaluation set of about 30 questions with known answers; numerical accuracy; missing-data handling; prompt-injection pages |
| Dashboard | Playwright smoke tests per page |
| Multi-tenant (M6) | Cross-tenant access tests on every endpoint and job |

---

## 15. Decisions (finalised)

| Decision | Choice |
|---|---|
| Repo | Separate, standalone; not part of any internal growth engine |
| Hosting | Docker Compose locally; VM or PaaS for beta |
| Auth | Deferred to M6; dev-key guard until then |
| Consent default | Cookieless; persistent IDs only after consent |
| Sessionisation | 30-minute inactivity or midnight in the site's timezone |
| Attribution | Last non-direct touch; UTM > referrer > direct |
| Timezone | Per site, used for all daily buckets |
| SEO and marketing changes | Suggestions only; the client applies them |
| Search Console | Optional OAuth connection in M4 |
| Crawl limits | 500 pages, same host, robots respected, 1–2 requests per second |
| AI | Provider-agnostic, read-only tools, cost-capped |

## 16. Open Items

- Final hosting provider and domain for the SDK, CDN and API.
- Which LLM provider and model to use first, and the monthly AI budget per site.
- Data retention period for raw events (proposed: 13 months raw, rollups kept indefinitely).
- Whether to start Google OAuth app verification for the GSC scope now. Verification takes weeks.

---

## 17. First Build (M1 + M2) — Acceptance

1. The local environment starts from the README.
2. A site is created and its install snippet is shown in the dashboard.
3. The SDK is installed on the demo site and on one real site.
4. Page views, SPA navigation, outbound clicks and custom events arrive.
5. Invalid events are rejected, duplicates are ignored and bots are dropped.
6. The dashboard Overview, Realtime, Pages, Sources, Events and Devices pages show correct numbers.
7. Fixture-based analytics tests pass.
8. An SDK failure does not break the host site.
