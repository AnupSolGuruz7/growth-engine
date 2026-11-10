import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  METRIC_DEFINITIONS,
  previousPeriod,
  type AnalyticsQuery,
  type CampaignRow,
  type ChannelRow,
  type DeviceRow,
  type DevicesResponse,
  type EntryExitRow,
  type EventsResponse,
  type ExportReport,
  type OverviewMetrics,
  type OverviewResponse,
  type PageRow,
  type PagesResponse,
  type RangeInfo,
  type RealtimeResponse,
  type ReferrerRow,
  type SourcesResponse,
  type TimeseriesPoint,
} from '@growthos/shared-types';
import type { DataSource } from 'typeorm';
import type { TenantContext } from '../common/tenant';
import { SitesService } from '../sites/sites.service';

const ratio = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10_000) / 10_000 : 0);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Bounds event_time around an inclusive local-date range so partitions are pruned. */
const EVENT_BOUNDS = `event_time >= ($2::date - 1)::timestamptz AND event_time < ($3::date + 2)::timestamptz`;

/**
 * Reports for one site and an inclusive [from, to] range of dates in the site timezone.
 * Additive metrics come from the daily rollups; distinct visitors are counted from sessions
 * (daily uniques cannot be summed across days). Every method starts with getOwned(), which is
 * where tenant scoping happens.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly sites: SitesService,
  ) {}

  private async site(t: TenantContext, q: AnalyticsQuery) {
    const site = await this.sites.getOwned(t, q.site_id);
    const range: RangeInfo = { from: q.from, to: q.to, timezone: site.timezone };
    const p: [string, string, string] = [site.id, q.from, q.to];
    return { site, range, p };
  }

  // ------------------------------------------------------------------ overview

  async overview(t: TenantContext, q: AnalyticsQuery): Promise<OverviewResponse> {
    const { site, range } = await this.site(t, q);
    const [metrics, timeseries] = await Promise.all([
      this.metrics(site.id, q.from, q.to),
      this.timeseries(site.id, q.from, q.to),
    ]);
    let previous: OverviewResponse['previous'] = null;
    if (q.compare === 'previous') {
      const pr = previousPeriod(q.from, q.to);
      const [pm, pt] = await Promise.all([this.metrics(site.id, pr.from, pr.to), this.timeseries(site.id, pr.from, pr.to)]);
      previous = { range: { ...pr, timezone: site.timezone }, metrics: pm, timeseries: pt };
    }
    return { range, metrics, timeseries, previous, definitions: METRIC_DEFINITIONS };
  }

  private async metrics(siteId: string, from: string, to: string): Promise<OverviewMetrics> {
    const [[agg], [vis]] = await Promise.all([
      this.ds.query(
        `SELECT COALESCE(sum(sessions), 0) AS sessions, COALESCE(sum(pageviews), 0) AS pageviews,
                COALESCE(sum(events), 0) AS events, COALESCE(sum(bounces), 0) AS bounces,
                COALESCE(sum(total_duration_s), 0) AS duration
         FROM agg_daily_site WHERE site_id = $1 AND date BETWEEN $2 AND $3`,
        [siteId, from, to],
      ),
      this.ds.query(
        `SELECT count(DISTINCT visitor_key) FILTER (WHERE is_identified) AS identified,
                count(*) FILTER (WHERE NOT is_identified) AS estimated
         FROM sessions WHERE site_id = $1 AND local_date BETWEEN $2 AND $3`,
        [siteId, from, to],
      ),
    ]);
    const sessions = Number(agg.sessions);
    return {
      visitors: Number(vis.identified) + Number(vis.estimated),
      estimated_visitors: Number(vis.estimated),
      sessions,
      pageviews: Number(agg.pageviews),
      events: Number(agg.events),
      bounces: Number(agg.bounces),
      bounce_rate: ratio(Number(agg.bounces), sessions),
      avg_session_duration_s: sessions ? round1(Number(agg.duration) / sessions) : 0,
      pages_per_session: sessions ? Math.round((Number(agg.pageviews) / sessions) * 100) / 100 : 0,
    };
  }

  private async timeseries(siteId: string, from: string, to: string): Promise<TimeseriesPoint[]> {
    const rows: { date: string; visitors: number; sessions: number; pageviews: number; bounces: number }[] =
      await this.ds.query(
        `SELECT d::date::text AS date, COALESCE(a.visitors, 0) AS visitors, COALESCE(a.sessions, 0) AS sessions,
                COALESCE(a.pageviews, 0) AS pageviews, COALESCE(a.bounces, 0) AS bounces
         FROM generate_series($2::date, $3::date, interval '1 day') d
         LEFT JOIN agg_daily_site a ON a.site_id = $1 AND a.date = d::date
         ORDER BY d`,
        [siteId, from, to],
      );
    return rows.map((r) => ({
      date: r.date,
      visitors: r.visitors,
      sessions: r.sessions,
      pageviews: r.pageviews,
      bounce_rate: ratio(r.bounces, r.sessions),
    }));
  }

  // ------------------------------------------------------------------ pages

  async pages(t: TenantContext, q: AnalyticsQuery): Promise<PagesResponse> {
    const { range, p } = await this.site(t, q);
    const top: PageRow[] = await this.ds.query(
      `SELECT page_path, sum(pageviews)::int AS pageviews, sum(entrances)::int AS entrances, sum(exits)::int AS exits
       FROM agg_daily_page WHERE site_id = $1 AND date BETWEEN $2 AND $3
       GROUP BY page_path ORDER BY pageviews DESC, page_path LIMIT $4`,
      [...p, q.limit],
    );
    const entryExit = async (col: 'landing_path' | 'exit_path'): Promise<EntryExitRow[]> => {
      const rows: { page_path: string; sessions: number; bounces: number; duration: number }[] = await this.ds.query(
        `SELECT ${col} AS page_path, count(*)::int AS sessions, count(*) FILTER (WHERE is_bounce)::int AS bounces,
                sum(duration_s)::int AS duration
         FROM sessions WHERE site_id = $1 AND local_date BETWEEN $2 AND $3 AND ${col} IS NOT NULL
         GROUP BY 1 ORDER BY sessions DESC, page_path LIMIT $4`,
        [...p, q.limit],
      );
      return rows.map((r) => ({
        page_path: r.page_path,
        sessions: r.sessions,
        bounce_rate: ratio(r.bounces, r.sessions),
        avg_session_duration_s: round1(r.duration / r.sessions),
      }));
    };
    const [landing_pages, exit_pages] = await Promise.all([entryExit('landing_path'), entryExit('exit_path')]);
    return { range, top_pages: top, landing_pages, exit_pages };
  }

  // ------------------------------------------------------------------ sources

  async sources(t: TenantContext, q: AnalyticsQuery): Promise<SourcesResponse> {
    const { range, p } = await this.site(t, q);
    const [channelRows, visitorRows, referrerRows, campaignRows] = await Promise.all([
      this.ds.query(
        `SELECT channel, sum(sessions)::int AS sessions, sum(bounces)::int AS bounces, sum(pageviews)::int AS pageviews
         FROM agg_daily_source WHERE site_id = $1 AND date BETWEEN $2 AND $3
         GROUP BY channel ORDER BY sessions DESC, channel`,
        p,
      ),
      this.ds.query(
        `SELECT channel, (count(DISTINCT visitor_key) FILTER (WHERE is_identified)
                          + count(*) FILTER (WHERE NOT is_identified))::int AS visitors
         FROM sessions WHERE site_id = $1 AND local_date BETWEEN $2 AND $3 GROUP BY channel`,
        p,
      ),
      this.ds.query(
        `SELECT referrer_host, channel, sum(sessions)::int AS sessions, sum(bounces)::int AS bounces
         FROM agg_daily_source WHERE site_id = $1 AND date BETWEEN $2 AND $3 AND referrer_host <> ''
         GROUP BY referrer_host, channel ORDER BY sessions DESC, referrer_host, channel LIMIT $4`,
        [...p, q.limit],
      ),
      this.ds.query(
        `SELECT source, medium, campaign, sum(sessions)::int AS sessions, sum(bounces)::int AS bounces
         FROM agg_daily_source WHERE site_id = $1 AND date BETWEEN $2 AND $3 AND (campaign <> '' OR medium <> '')
         GROUP BY source, medium, campaign ORDER BY sessions DESC, source, medium, campaign LIMIT $4`,
        [...p, q.limit],
      ),
    ]);
    const visitors = new Map<string, number>(visitorRows.map((r: { channel: string; visitors: number }) => [r.channel, r.visitors]));
    const channels: ChannelRow[] = channelRows.map((r: { channel: ChannelRow['channel']; sessions: number; bounces: number; pageviews: number }) => ({
      channel: r.channel,
      sessions: r.sessions,
      visitors: visitors.get(r.channel) ?? 0,
      bounce_rate: ratio(r.bounces, r.sessions),
      pageviews: r.pageviews,
    }));
    const referrers: ReferrerRow[] = referrerRows.map((r: ReferrerRow & { bounces: number }) => ({
      referrer_host: r.referrer_host,
      channel: r.channel,
      sessions: r.sessions,
      bounce_rate: ratio(r.bounces, r.sessions),
    }));
    const campaigns: CampaignRow[] = campaignRows.map((r: CampaignRow & { bounces: number }) => ({
      source: r.source,
      medium: r.medium,
      campaign: r.campaign,
      sessions: r.sessions,
      bounce_rate: ratio(r.bounces, r.sessions),
    }));
    return { range, channels, referrers, campaigns };
  }

  // ------------------------------------------------------------------ events

  async events(t: TenantContext, q: AnalyticsQuery, eventName?: string): Promise<EventsResponse> {
    const { range, p } = await this.site(t, q);
    const rows: { event_name: string; count: number }[] = await this.ds.query(
      `SELECT event_name, sum(events)::int AS count
       FROM agg_daily_event WHERE site_id = $1 AND date BETWEEN $2 AND $3
       GROUP BY event_name ORDER BY count DESC, event_name LIMIT $4`,
      [...p, q.limit],
    );
    const total = rows.reduce((s, r) => s + r.count, 0);
    const res: EventsResponse = { range, events: rows.map((r) => ({ ...r, share: ratio(r.count, total) })) };
    if (eventName) {
      res.properties = await this.ds.query(
        `SELECT kv.key, kv.value, count(*)::int AS count
         FROM events, jsonb_each_text(properties) AS kv(key, value)
         WHERE site_id = $1 AND local_date BETWEEN $2 AND $3 AND ${EVENT_BOUNDS} AND event_name = $4
         GROUP BY kv.key, kv.value ORDER BY count DESC, kv.key, kv.value LIMIT $5`,
        [...p, eventName, q.limit],
      );
    }
    return res;
  }

  // ------------------------------------------------------------------ devices

  async devices(t: TenantContext, q: AnalyticsQuery): Promise<DevicesResponse> {
    const { range, p } = await this.site(t, q);
    const rows: { device_category: string; sessions: number; bounces: number; visitors: number }[] = await this.ds.query(
      `SELECT COALESCE(device_category, 'unknown') AS device_category, count(*)::int AS sessions,
              count(*) FILTER (WHERE is_bounce)::int AS bounces,
              (count(DISTINCT visitor_key) FILTER (WHERE is_identified) + count(*) FILTER (WHERE NOT is_identified))::int AS visitors
       FROM sessions WHERE site_id = $1 AND local_date BETWEEN $2 AND $3
       GROUP BY 1 ORDER BY sessions DESC, 1`,
      p,
    );
    const total = rows.reduce((s, r) => s + r.sessions, 0);
    const devices: DeviceRow[] = rows.map((r) => ({
      device_category: r.device_category as DeviceRow['device_category'],
      sessions: r.sessions,
      visitors: r.visitors,
      bounce_rate: ratio(r.bounces, r.sessions),
      share: ratio(r.sessions, total),
    }));
    return { range, devices };
  }

  // ------------------------------------------------------------------ realtime (raw events)

  async realtime(t: TenantContext, siteId: string, windowMinutes = 5): Promise<RealtimeResponse> {
    const site = await this.sites.getOwned(t, siteId);
    const w = `event_time >= now() - make_interval(mins => $2) AND event_time <= now() + interval '10 minutes'`;
    const [[agg], top, latest, [last]] = await Promise.all([
      this.ds.query(
        `SELECT count(DISTINCT visitor_key)::int AS active, count(*) FILTER (WHERE event_name = 'page_view')::int AS pageviews
         FROM events WHERE site_id = $1 AND ${w}`,
        [site.id, windowMinutes],
      ),
      this.ds.query(
        `SELECT page_path, count(DISTINCT visitor_key)::int AS visitors
         FROM events WHERE site_id = $1 AND ${w} AND page_path IS NOT NULL
         GROUP BY page_path ORDER BY visitors DESC, page_path LIMIT 10`,
        [site.id, windowMinutes],
      ),
      this.ds.query(
        `SELECT event_id, event_name, event_time, received_at, page_path, device_category, consent_state
         FROM events WHERE site_id = $1 AND received_at >= now() - interval '1 day'
         ORDER BY received_at DESC, event_time DESC LIMIT 25`,
        [site.id],
      ),
      this.ds.query(`SELECT max(received_at) AS at FROM events WHERE site_id = $1`, [site.id]),
    ]);
    return {
      active_visitors: agg.active,
      window_minutes: windowMinutes,
      pageviews_last_window: agg.pageviews,
      top_active_pages: top,
      latest_events: latest.map((e: Record<string, unknown>) => ({
        ...e,
        event_time: new Date(e.event_time as string).toISOString(),
        received_at: new Date(e.received_at as string).toISOString(),
      })),
      last_event_received_at: last?.at ? new Date(last.at).toISOString() : null,
    };
  }

  // ------------------------------------------------------------------ CSV export

  async exportCsv(t: TenantContext, q: AnalyticsQuery, report: ExportReport): Promise<string> {
    if (report === 'pages') {
      const r = await this.pages(t, { ...q, limit: 500 });
      const landing = new Map(r.landing_pages.map((l) => [l.page_path, l]));
      return toCsv(
        ['page_path', 'pageviews', 'entrances', 'exits', 'landing_bounce_rate'],
        r.top_pages.map((p) => [p.page_path, p.pageviews, p.entrances, p.exits, landing.get(p.page_path)?.bounce_rate ?? '']),
      );
    }
    if (report === 'sources') {
      const { p } = await this.site(t, q);
      const rows: Record<string, string | number>[] = await this.ds.query(
        `SELECT channel, source, medium, campaign, referrer_host, sum(sessions)::int AS sessions,
                sum(bounces)::int AS bounces, sum(pageviews)::int AS pageviews
         FROM agg_daily_source WHERE site_id = $1 AND date BETWEEN $2 AND $3
         GROUP BY 1, 2, 3, 4, 5 ORDER BY sessions DESC, 1, 2, 3, 4, 5`,
        p,
      );
      const cols = ['channel', 'source', 'medium', 'campaign', 'referrer_host', 'sessions', 'bounces', 'pageviews'];
      return toCsv(cols, rows.map((r) => cols.map((c) => r[c]!)));
    }
    const r = await this.events(t, { ...q, limit: 500 });
    return toCsv(['event_name', 'count', 'share'], r.events.map((e) => [e.event_name, e.count, e.share]));
  }
}

/** RFC 4180 CSV; cells starting with = + - @ are prefixed with ' to defuse spreadsheet formulas. */
export function toCsv(header: string[], rows: (string | number)[][]): string {
  const cell = (v: string | number) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
