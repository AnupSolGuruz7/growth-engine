import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { previousPeriod, type AnalyticsQuery } from '@growthos/shared-types';
import type { DataSource } from 'typeorm';
import { AnalyticsService } from '../analytics/analytics.service';
import type { TenantContext } from '../common/tenant';
import { SitesService } from '../sites/sites.service';

/**
 * A single number (or label) the AI may cite. The ref is the only way a suggestion can point at
 * data: the server checks every cited ref + value against this table, so nothing invented survives.
 *
 * Ref grammar: `<scope>[:<key>].<metric>`, e.g. `overview.sessions`, `landing:/pricing.bounce_rate`,
 * `channel:organic_search.sessions`, `event:signup_click.count`, `seo:<finding-id>.severity`.
 */
export interface Fact {
  ref: string;
  value: number | string;
  label: string;
  link: string;
  /** True for values that come from visitors or crawled pages (paths, titles, event names). */
  untrustedText?: boolean;
}

export interface FactSet {
  site: { id: string; organization_id: string; name: string; domain: string; timezone: string };
  range: { from: string; to: string };
  previous: { from: string; to: string };
  facts: Fact[];
  seoAuditId: string | null;
}

/** Scopes whose numeric metrics can be re-computed for any date range (used for before/after). */
export const MEASURABLE_SCOPES = ['overview', 'landing', 'page', 'channel', 'event', 'device'] as const;

const LINK: Record<string, string> = {
  overview: '/', overview_prev: '/', landing: '/pages', page: '/pages', channel: '/sources', campaign: '/sources',
  referrer: '/sources', event: '/events', event_page: '/events', device: '/devices', seo: '/seo',
};

export function parseRef(ref: string): { scope: string; key: string | null; metric: string } | null {
  const m = ref.match(/^([a-z_]+)(?::(.+))?\.([a-z_0-9]+)$/);
  return m ? { scope: m[1]!, key: m[2] ?? null, metric: m[3]! } : null;
}

export function linkFor(ref: string): string {
  return LINK[parseRef(ref)?.scope ?? ''] ?? '/';
}

const todayIn = (tz: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (d: string, n: number) => {
  const x = new Date(d + 'T00:00:00Z');
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

@Injectable()
export class FactsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly analytics: AnalyticsService,
    private readonly sites: SitesService,
  ) {}

  /** Last 28 complete days + today in the site timezone, and the 28 days before. */
  static defaultRange(tz: string): { from: string; to: string } {
    const to = todayIn(tz);
    return { from: addDays(to, -27), to };
  }

  /** Builds the evidence pack for suggestion generation. All numbers come from the analytics APIs. */
  async build(t: TenantContext, siteId: string): Promise<FactSet> {
    const site = await this.sites.getOwned(t, siteId);
    const range = FactsService.defaultRange(site.timezone);
    const q: AnalyticsQuery = { site_id: site.id, ...range, compare: 'previous', limit: 15 };
    const [ov, pages, sources, events, devices] = await Promise.all([
      this.analytics.overview(t, q),
      this.analytics.pages(t, q),
      this.analytics.sources(t, q),
      this.analytics.events(t, q),
      this.analytics.devices(t, q),
    ]);
    const facts: Fact[] = [];
    const add = (ref: string, value: number | string, label: string, untrustedText = false) =>
      facts.push({ ref, value, label, link: linkFor(ref), untrustedText });

    const m = ov.metrics;
    const p = ov.previous!.metrics;
    for (const [k, label] of [
      ['visitors', 'Visitors'], ['sessions', 'Sessions'], ['pageviews', 'Page views'], ['events', 'Events'],
      ['bounce_rate', 'Bounce rate (0–1)'], ['avg_session_duration_s', 'Average session duration (s)'],
      ['pages_per_session', 'Pages per session'],
    ] as const) {
      add(`overview.${k}`, m[k], `${label}, ${range.from}…${range.to}`);
      add(`overview_prev.${k}`, p[k], `${label}, previous 28 days`);
    }
    add('overview.estimated_visitors', m.estimated_visitors, 'Visitors without consent (counted per session, estimated)');

    for (const r of pages.landing_pages) {
      add(`landing:${r.page_path}.sessions`, r.sessions, `Sessions landing on ${r.page_path}`, true);
      add(`landing:${r.page_path}.bounce_rate`, r.bounce_rate, `Bounce rate (0–1) of sessions landing on ${r.page_path}`, true);
    }
    for (const r of pages.top_pages) add(`page:${r.page_path}.pageviews`, r.pageviews, `Page views of ${r.page_path}`, true);
    for (const r of sources.channels) {
      add(`channel:${r.channel}.sessions`, r.sessions, `Sessions from channel ${r.channel}`);
      add(`channel:${r.channel}.bounce_rate`, r.bounce_rate, `Bounce rate (0–1) of channel ${r.channel}`);
    }
    for (const r of sources.campaigns.slice(0, 10)) {
      const key = `${r.source || '-'}/${r.medium || '-'}/${r.campaign || '-'}`;
      add(`campaign:${key}.sessions`, r.sessions, `Sessions from campaign ${key}`, true);
      add(`campaign:${key}.bounce_rate`, r.bounce_rate, `Bounce rate (0–1) of campaign ${key}`, true);
    }
    for (const r of sources.referrers.slice(0, 10)) add(`referrer:${r.referrer_host}.sessions`, r.sessions, `Sessions referred by ${r.referrer_host}`, true);
    for (const r of events.events) add(`event:${r.event_name}.count`, r.count, `Count of event ${r.event_name}`, true);
    for (const r of devices.devices) {
      add(`device:${r.device_category}.sessions`, r.sessions, `Sessions on ${r.device_category}`);
      add(`device:${r.device_category}.bounce_rate`, r.bounce_rate, `Bounce rate (0–1) on ${r.device_category}`);
    }

    // Custom (non-automatic) events by page — "pages with traffic but no enquiries" style evidence.
    const byPage: { event_name: string; page_path: string; n: number }[] = await this.ds.query(
      `SELECT event_name, COALESCE(page_path, '/') AS page_path, count(*)::int AS n
       FROM events
       WHERE site_id = $1 AND local_date BETWEEN $2 AND $3
         AND event_time >= ($2::date - 1)::timestamptz AND event_time < ($3::date + 2)::timestamptz
         AND event_name NOT IN ('page_view', 'outbound_click')
       GROUP BY 1, 2 ORDER BY n DESC LIMIT 20`,
      [site.id, range.from, range.to],
    );
    for (const r of byPage) add(`event_page:${r.event_name}@${r.page_path}.count`, r.n, `${r.event_name} events on ${r.page_path}`, true);

    // Latest completed SEO audit, highest-priority findings.
    const [audit] = await this.ds.query(
      `SELECT id, score FROM seo_audits WHERE site_id = $1 AND status = 'completed' ORDER BY created_at DESC LIMIT 1`,
      [site.id],
    );
    if (audit) {
      add('seo.score', audit.score, 'SEO health score of the latest audit (0–100)');
      const findings: { id: string; check_id: string; severity: string; url: string; title: string; pageviews_28d: number }[] =
        await this.ds.query(
          `SELECT id, check_id, severity, url, title, pageviews_28d FROM seo_findings WHERE audit_id = $1 ORDER BY priority DESC LIMIT 25`,
          [audit.id],
        );
      for (const f of findings) {
        add(`seo:${f.id}.severity`, f.severity, `SEO finding "${f.title}" (${f.check_id}) on ${f.url}, page views 28d: ${f.pageviews_28d}`, true);
      }
    }
    return {
      site: { id: site.id, organization_id: site.organization_id, name: site.name, domain: site.domain, timezone: site.timezone },
      range,
      previous: previousPeriod(range.from, range.to),
      facts,
      seoAuditId: audit?.id ?? null,
    };
  }

  /** Re-computes a measurable metric for any date range (suggestion before/after comparison). */
  async metricValue(t: TenantContext, siteId: string, ref: string, from: string, to: string): Promise<number | null> {
    const r = parseRef(ref);
    if (!r || !(MEASURABLE_SCOPES as readonly string[]).includes(r.scope)) return null;
    const q: AnalyticsQuery = { site_id: siteId, from, to, compare: 'none', limit: 500 };
    const num = (v: unknown) => (typeof v === 'number' ? v : null);
    switch (r.scope) {
      case 'overview':
        return num((await this.analytics.overview(t, q)).metrics[r.metric as keyof import('@growthos/shared-types').OverviewMetrics]);
      case 'landing': {
        const row = (await this.analytics.pages(t, q)).landing_pages.find((x) => x.page_path === r.key);
        return row ? num(row[r.metric as 'sessions' | 'bounce_rate']) : 0;
      }
      case 'page': {
        const row = (await this.analytics.pages(t, q)).top_pages.find((x) => x.page_path === r.key);
        return row ? num(row[r.metric as 'pageviews']) : 0;
      }
      case 'channel': {
        const row = (await this.analytics.sources(t, q)).channels.find((x) => x.channel === r.key);
        return row ? num(row[r.metric as 'sessions' | 'bounce_rate']) : 0;
      }
      case 'event': {
        const row = (await this.analytics.events(t, q)).events.find((x) => x.event_name === r.key);
        return row ? row.count : 0;
      }
      case 'device': {
        const row = (await this.analytics.devices(t, q)).devices.find((x) => x.device_category === r.key);
        return row ? num(row[r.metric as 'sessions' | 'bounce_rate']) : 0;
      }
    }
    return null;
  }
}

/**
 * Compares a value the model cited with the real fact. Accepts the same number written with
 * thousands separators or as a percentage of a 0–1 rate ("41.2%" for 0.412).
 */
export function valueMatches(cited: string | number, actual: number | string): boolean {
  if (typeof actual === 'string') return String(cited).trim().toLowerCase() === actual.toLowerCase();
  const s = String(cited).trim().replace(/,/g, '');
  const pct = s.endsWith('%');
  const n = Number(pct ? s.slice(0, -1) : s);
  if (!Number.isFinite(n)) return false;
  const candidates = pct ? [n / 100] : [n];
  return candidates.some((c) => Math.abs(c - actual) <= Math.max(0.0051, Math.abs(actual) * 0.005));
}
