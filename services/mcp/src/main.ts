#!/usr/bin/env node
/**
 * GrowthOS MCP server (stdio). Lets a coding agent — e.g. Claude Code opened in a site's website
 * repo — read what GrowthOS knows about that site (SEO findings, AI drafts, growth suggestions,
 * the knowledge base, Search Console) and check copy against the site's content rules, so the
 * agent can make the actual code changes in the repo itself.
 *
 * It only talks to the GrowthOS HTTP API (with the dev key); it never touches the database or
 * any repo. stdout carries the MCP protocol, so diagnostics go to stderr.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// ---------------------------------------------------------------------------------------------
// Configuration. The agent runs with its cwd in some other repo, so the GrowthOS .env is found
// from this file's location, not from process.cwd(). Real environment variables win.

function readGrowthOsEnv(): Record<string, string> {
  let dir = __dirname;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      const file = join(dir, '.env');
      if (!existsSync(file)) return {};
      const out: Record<string, string> = {};
      for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
      }
      return out;
    }
    const parent = dirname(dir);
    if (parent === dir) return {};
    dir = parent;
  }
}

const fileEnv = readGrowthOsEnv();
const env = (k: string) => process.env[k] || fileEnv[k] || '';
const API = (env('GROWTHOS_API_URL') || `http://localhost:${env('API_PORT') || '4000'}`).replace(/\/$/, '');
const DEV_KEY = env('GROWTHOS_DEV_KEY') || env('DEV_KEY');
/** Default site (id, name or domain) when a tool call doesn't name one. */
const DEFAULT_SITE = env('GROWTHOS_SITE');

// ---------------------------------------------------------------------------------------------
// API client

class ApiError extends Error {}

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  if (!DEV_KEY) throw new ApiError('GrowthOS dev key not found. Set GROWTHOS_DEV_KEY, or DEV_KEY in the GrowthOS .env.');
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'x-dev-key': DEV_KEY, ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    throw new ApiError(`GrowthOS API not reachable at ${API} (${(e as Error).message}). Is the API running?`);
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const msg = (data as { message?: string } | null)?.message ?? res.statusText;
    throw new ApiError(`GrowthOS API ${res.status}: ${Array.isArray(msg) ? msg.join('; ') : msg}`);
  }
  return data as T;
}

interface Site { id: string; name: string; domain: string }
interface Audit { id: string; status: string; score: number | null; pages_crawled: number; created_at: string; finished_at: string | null; start_url: string; error: string | null }
interface Finding {
  id: string; url: string; category: string; check_id: string; severity: string; title: string;
  evidence: Record<string, unknown>; explanation: string; suggested_fix: string; priority: number;
  pageviews_28d: number; limits: string | null; change?: string;
}

async function resolveSite(site?: string): Promise<Site> {
  const sites = await api<Site[]>('/v1/sites');
  if (!sites.length) throw new ApiError('No sites in GrowthOS.');
  const want = (site || DEFAULT_SITE).trim().toLowerCase();
  if (!want) return sites[0]; // the API lists the site with a knowledge base first
  const hit = sites.find((s) => s.id === want || s.name.toLowerCase() === want || s.domain.toLowerCase() === want.replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
  if (!hit) throw new ApiError(`Unknown site "${site}". Known: ${sites.map((s) => `${s.name} (${s.domain})`).join(', ')}`);
  return hit;
}

async function latestAudit(siteId: string): Promise<{ latest: Audit | null; completed: Audit | null }> {
  const audits = await api<Audit[]>(`/v1/seo/audits?site_id=${siteId}`);
  return { latest: audits[0] ?? null, completed: audits.find((a) => a.status === 'completed') ?? null };
}

const pathOf = (url: string) => { try { const u = new URL(url); return u.pathname + u.search; } catch { return url; } };
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
/** Mirrors DRAFTABLE_CHECKS in shared-types. */
const DRAFTABLE = new Set([
  'title_missing', 'title_length', 'title_duplicate', 'meta_description_missing', 'meta_description_length',
  'meta_description_duplicate', 'h1_missing', 'h1_multiple', 'images_missing_alt', 'bold_as_heading',
  'structured_data_missing', 'thin_content',
]);

// ---------------------------------------------------------------------------------------------
// Tool plumbing

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const ok = (value: unknown): ToolResult => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }] });
const run = (fn: () => Promise<unknown>) => async (): Promise<ToolResult> => {
  try {
    return ok(await fn());
  } catch (e) {
    return { content: [{ type: 'text', text: e instanceof ApiError ? e.message : `Error: ${(e as Error).message}` }], isError: true };
  }
};
const siteArg = z.string().optional().describe('Site id, name or domain. Defaults to GROWTHOS_SITE, else the first site (the one with a knowledge base).');
const READ = { readOnlyHint: true, openWorldHint: false } as const;

const INSTRUCTIONS = `GrowthOS is SolGuruz's internal website-growth tool. It crawls the site for SEO issues, holds AI growth suggestions, a knowledge base built from the site's internal growth repo, and a Search Console snapshot. Use it to decide WHAT to change; make the changes yourself in the repo you are working in.

Typical flow for fixing SEO issues:
1. seo_overview → see the latest audit and which checks have the most issues.
2. list_findings (filter by check_id / severity / url) → pick findings.
3. Locate the page's source in the repo (map the URL path to its route; grep for the current title/description from the finding's evidence). If the copy is not in the repo (e.g. blog posts served from a CMS such as WordPress), say so and skip it — do not hardcode CMS content into the code.
4. For copy fixes, draft_fix gives AI-written alternatives grounded in the page and brand knowledge (costs one AI call). Adapt to the repo's conventions.
5. check_copy on every piece of user-facing copy you add or change, before committing. Treat "block" flags as must-fix.
6. Follow the repo's own rules (CLAUDE.md / AGENTS.md / check scripts). Changes only reach the audit after they are deployed; start_audit then re-crawls.

Confidentiality: knowledge-base passages and Search Console figures are internal. Use them to inform decisions, but never paste them, cite their file paths, or describe the internal growth repo in code, comments, commit messages or merge-request descriptions that the client could see.`;

const server = new McpServer({ name: 'growthos', version: '0.1.0' }, { instructions: INSTRUCTIONS });

server.registerTool('list_sites', {
  title: 'List sites',
  description: 'Sites tracked in GrowthOS (id, name, domain). The first one is the default.',
  annotations: READ,
}, run(async () => (await api<Site[]>('/v1/sites')).map((s) => ({ id: s.id, name: s.name, domain: s.domain }))));

server.registerTool('seo_overview', {
  title: 'SEO audit overview',
  description: 'Latest SEO audit of a site: score, pages crawled, and issue counts per check (worst first). Use check_id values with list_findings.',
  inputSchema: { site: siteArg },
  annotations: READ,
}, async ({ site }) => run(async () => {
  const s = await resolveSite(site);
  const { latest, completed } = await latestAudit(s.id);
  if (!completed) return { site: s.name, latest_audit: latest ? { id: latest.id, status: latest.status } : null, note: 'No completed audit yet. Use start_audit.' };
  const findings = await api<Finding[]>(`/v1/seo/audits/${completed.id}/findings`);
  const by = new Map<string, { check_id: string; title: string; severity: string; count: number; draftable: boolean; example: string }>();
  for (const f of findings) {
    const e = by.get(f.check_id) ?? { check_id: f.check_id, title: f.title, severity: f.severity, count: 0, draftable: DRAFTABLE.has(f.check_id), example: pathOf(f.url) };
    e.count++;
    by.set(f.check_id, e);
  }
  return {
    site: `${s.name} (${s.domain})`,
    audit: { id: completed.id, score: completed.score, pages_crawled: completed.pages_crawled, finished_at: completed.finished_at },
    ...(latest && latest.id !== completed.id ? { newer_audit: { id: latest.id, status: latest.status } } : {}),
    total_findings: findings.length,
    checks: [...by.values()].sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || b.count - a.count),
  };
})());

server.registerTool('list_findings', {
  title: 'List SEO findings',
  description: 'SEO issues from the latest completed audit, highest priority first, with evidence (current title/description etc.) and the suggested fix. Filter by check_id, severity or URL.',
  inputSchema: {
    site: siteArg,
    check_id: z.string().optional().describe('e.g. title_length, meta_description_length, h1_missing (see seo_overview)'),
    severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    url: z.string().optional().describe('Full URL or path; matches findings whose URL contains it'),
    limit: z.number().int().min(1).max(100).default(20),
  },
  annotations: READ,
}, async ({ site, check_id, severity, url, limit }) => run(async () => {
  const s = await resolveSite(site);
  const { completed } = await latestAudit(s.id);
  if (!completed) throw new ApiError('No completed audit yet. Use start_audit.');
  const qs = new URLSearchParams();
  if (check_id) qs.set('check_id', check_id);
  if (severity) qs.set('severity', severity);
  let findings = await api<Finding[]>(`/v1/seo/audits/${completed.id}/findings?${qs}`);
  if (url) findings = findings.filter((f) => f.url.includes(url) || pathOf(f.url) === url);
  findings.sort((a, b) => b.priority - a.priority);
  return {
    audit_id: completed.id,
    total: findings.length,
    findings: findings.slice(0, limit).map((f) => ({
      id: f.id, path: pathOf(f.url), url: f.url, check_id: f.check_id, severity: f.severity, title: f.title,
      evidence: f.evidence, suggested_fix: f.suggested_fix, pageviews_28d: f.pageviews_28d,
      ...(f.limits ? { limits: f.limits } : {}), draftable: DRAFTABLE.has(f.check_id),
    })),
  };
})());

server.registerTool('get_page', {
  title: 'Get crawled page',
  description: "What the latest audit saw on one page: title, meta description, H1s, headings, canonical, robots, word count, plus that page's findings.",
  inputSchema: { url: z.string().describe('Full URL or a path like /investors/'), site: siteArg },
  annotations: READ,
}, async ({ url, site }) => run(async () => {
  const s = await resolveSite(site);
  const { completed } = await latestAudit(s.id);
  if (!completed) throw new ApiError('No completed audit yet. Use start_audit.');
  const full = /^https?:\/\//.test(url) ? url : `https://${s.domain}${url.startsWith('/') ? '' : '/'}${url}`;
  const page = await api<Record<string, unknown>>(`/v1/seo/audits/${completed.id}/page?url=${encodeURIComponent(full)}`);
  const pick = ['url', 'status', 'title', 'meta_description', 'h1', 'canonical', 'robots_meta', 'lang', 'word_count', 'indexable', 'in_sitemap', 'inlinks', 'response_ms'];
  const out: Record<string, unknown> = Object.fromEntries(pick.filter((k) => k in page).map((k) => [k, page[k]]));
  if (Array.isArray(page.headings)) out.headings = (page.headings as unknown[]).slice(0, 40);
  if (Array.isArray(page.issues)) out.findings = (page.issues as Finding[]).map((f) => ({ id: f.id, check_id: f.check_id, severity: f.severity, title: f.title, evidence: f.evidence, suggested_fix: f.suggested_fix }));
  return out;
})());

server.registerTool('draft_fix', {
  title: 'Draft SEO copy fix',
  description: 'AI-written replacement copy for one finding (titles, meta descriptions, H1s, alt text, JSON-LD, content outline), grounded in the page content and brand knowledge, with rule-check flags. Cached per finding; regenerate=true writes new alternatives. Uses one AI call.',
  inputSchema: { finding_id: z.string().uuid(), regenerate: z.boolean().default(false) },
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ finding_id, regenerate }) => run(async () => {
  const d = await api<{ drafts: { field: string; value: string; note: string; length: number }[]; caution: string | null; rule_flags?: { index: number; flags: unknown[] }[] }>(
    `/v1/seo/findings/${finding_id}/draft`, { method: 'POST', body: { regenerate } },
  );
  return {
    alternatives: d.drafts.map((x, i) => ({ ...x, rule_flags: d.rule_flags?.find((r) => r.index === i)?.flags ?? [] })),
    caution: d.caution,
  };
})());

server.registerTool('list_suggestions', {
  title: 'List growth suggestions',
  description: "GrowthOS's AI growth suggestions for the site (what to build or fix next, why, suggested copy, and how success is measured). Sources are internal knowledge-base references.",
  inputSchema: {
    site: siteArg,
    status: z.enum(['new', 'accepted', 'dismissed', 'done', 'open']).default('open').describe('open = new + accepted'),
  },
  annotations: READ,
}, async ({ site, status }) => run(async () => {
  const s = await resolveSite(site);
  const res = await api<{ suggestions: Array<Record<string, unknown> & { status: string }> }>(`/v1/suggestions?site_id=${s.id}`);
  const keep = (x: { status: string }) => (status === 'open' ? x.status === 'new' || x.status === 'accepted' : x.status === status);
  return res.suggestions.filter(keep).map((x) => ({
    id: x.id, title: x.title, area: x.area, status: x.status, priority: x.priority, effort: x.effort, confidence: x.confidence,
    action: x.action, copy: x.copy, expected_outcome: x.expected_outcome, measurement: x.measurement,
    evidence: (x.evidence as { label: string; value: unknown }[]).map((e) => `${e.label}: ${e.value}`),
    sources: (x.sources as { cite: string }[]).map((r) => r.cite),
    rule_flags: x.rule_flags,
  }));
})());

server.registerTool('update_suggestion', {
  title: 'Update suggestion status',
  description: 'Mark a growth suggestion accepted (being worked on), done (shipped — GrowthOS then measures its effect) or dismissed.',
  inputSchema: { suggestion_id: z.string().uuid(), status: z.enum(['new', 'accepted', 'dismissed', 'done']) },
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
}, async ({ suggestion_id, status }) => run(async () => {
  const x = await api<{ id: string; title: string; status: string }>(`/v1/suggestions/${suggestion_id}`, { method: 'PATCH', body: { status } });
  return { id: x.id, title: x.title, status: x.status };
})());

server.registerTool('search_knowledge', {
  title: 'Search the knowledge base',
  description: "Search the site's knowledge base (its internal growth repo: brand, product facts, compliance rules, demand map, page plans). Hybrid semantic + keyword search. Internal: inform decisions, never copy into client-visible code or comments.",
  inputSchema: {
    query: z.string().min(2).describe('Natural-language question or exact terms'),
    site: siteArg,
    limit: z.number().int().min(1).max(10).default(5),
  },
  annotations: READ,
}, async ({ query, site, limit }) => run(async () => {
  const s = await resolveSite(site);
  const hits = await api<{ cite: string; content: string; match: string }[]>(`/v1/sites/${s.id}/knowledge/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  if (!hits.length) return 'No results (or no knowledge base connected for this site).';
  return hits.map((h) => `### ${h.cite} (${h.match})\n${h.content}`).join('\n\n');
})());

server.registerTool('search_console', {
  title: 'Search Console snapshot',
  description: 'Google Search Console data imported from the knowledge base (a snapshot, not live): totals, top queries, queries near page 1 (best quick wins), top pages and monthly trend. Optionally filter rows by text.',
  inputSchema: {
    site: siteArg,
    section: z.enum(['all', 'opportunities', 'top_queries', 'top_pages', 'monthly']).default('all'),
    contains: z.string().optional().describe('Only rows whose query/page contains this text'),
  },
  annotations: READ,
}, async ({ site, section, contains }) => run(async () => {
  const s = await resolveSite(site);
  const g = await api<Record<string, unknown> & { totals: { queries: number } }>(`/v1/sites/${s.id}/knowledge/gsc`);
  if (!g.totals?.queries) return 'No Search Console data imported for this site.';
  const filt = <T extends { query?: string; page?: string }>(rows: T[]) =>
    contains ? rows.filter((r) => (r.query ?? r.page ?? '').toLowerCase().includes(contains.toLowerCase())) : rows;
  const sections = ['opportunities', 'top_queries', 'top_pages', 'monthly'] as const;
  const out: Record<string, unknown> = { property: g.property, query_days: g.query_days, page_days: g.page_days, totals: g.totals, note: 'Snapshot exported into the knowledge base, not live data.' };
  for (const k of sections) if (section === 'all' || section === k) out[k] = k === 'monthly' ? g[k] : filt(g[k] as { query?: string; page?: string }[]);
  return out;
})());

server.registerTool('check_copy', {
  title: 'Check copy against content rules',
  description: "Check user-facing copy (titles, descriptions, headings, body text) against the site's banned words and banned claims from its knowledge base. Run before committing any copy change; fix every 'block' flag.",
  inputSchema: { text: z.string().min(1).max(50000), site: siteArg },
  annotations: READ,
}, async ({ text, site }) => run(async () => {
  const s = await resolveSite(site);
  const r = await api<{ rules: number; flags: { rule_id: string; kind: string; severity: string; quoted: string; why: string }[] }>(
    `/v1/sites/${s.id}/knowledge/check`, { method: 'POST', body: { text } },
  );
  if (!r.rules) return { ok: true, note: 'No content rules imported for this site, so nothing was checked.' };
  return { ok: !r.flags.some((f) => f.severity === 'block'), rules_checked: r.rules, flags: r.flags };
})());

server.registerTool('start_audit', {
  title: 'Start SEO audit',
  description: "Re-crawl the site's live domain to refresh findings (e.g. after a fix is deployed). Runs in the background for a few minutes; check progress with seo_overview.",
  inputSchema: { site: siteArg, max_pages: z.number().int().min(1).max(500).optional() },
  annotations: { readOnlyHint: false, openWorldHint: true },
}, async ({ site, max_pages }) => run(async () => {
  const s = await resolveSite(site);
  const a = await api<Audit>('/v1/seo/audits', { method: 'POST', body: { site_id: s.id, ...(max_pages ? { max_pages } : {}) } });
  return { audit_id: a.id, status: a.status, start_url: a.start_url, note: 'Crawl started; use seo_overview to see when it completes.' };
})());

async function main() {
  await server.connect(new StdioServerTransport());
  process.stderr.write(`growthos-mcp connected (API ${API})\n`);
}
main().catch((e) => {
  process.stderr.write(`growthos-mcp failed: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
