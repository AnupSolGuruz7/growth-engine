import { z } from 'zod';
import type { Channel } from './classify';
import type { DeviceCategory } from './events';

// ---------------------------------------------------------------- sites

export const SITE_STATUSES = ['active', 'inactive'] as const;
export type SiteStatus = (typeof SITE_STATUSES)[number];

const timezoneSchema = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: 'unknown IANA timezone' },
);

const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .transform((d) => d.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, ''))
  .pipe(z.string().min(1).max(253).regex(/^[a-z0-9.-]+(:\d+)?$/, 'invalid domain'));

export const createSiteSchema = z.object({
  name: z.string().trim().min(1).max(120),
  domain: domainSchema,
  timezone: timezoneSchema.optional().default('UTC'),
});
export type CreateSiteInput = z.input<typeof createSiteSchema>;

export const updateSiteSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    domain: domainSchema.optional(),
    timezone: timezoneSchema.optional(),
    status: z.enum(SITE_STATUSES).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });
export type UpdateSiteInput = z.input<typeof updateSiteSchema>;

export interface SiteDto {
  id: string;
  organization_id: string;
  name: string;
  domain: string;
  public_id: string;
  status: SiteStatus;
  timezone: string;
  created_at: string;
}

export interface SiteDetailDto extends SiteDto {
  install: { script_tag: string; npm: string; sdk_url: string; endpoint: string };
  last_event_received_at: string | null;
}

// ---------------------------------------------------------------- analytics query

export const MAX_RANGE_DAYS = 400;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const analyticsQuerySchema = z
  .object({
    site_id: z.string().uuid(),
    /** Inclusive start date in the site's timezone. */
    from: isoDate,
    /** Inclusive end date in the site's timezone. */
    to: isoDate,
    compare: z.enum(['previous', 'none']).optional().default('none'),
    limit: z.coerce.number().int().min(1).max(500).optional().default(50),
  })
  .superRefine((q, ctx) => {
    const days = rangeDays(q.from, q.to);
    if (Number.isNaN(days)) ctx.addIssue({ code: 'custom', message: 'invalid date' });
    else if (days < 1) ctx.addIssue({ code: 'custom', path: ['to'], message: '`to` must be on or after `from`' });
    else if (days > MAX_RANGE_DAYS)
      ctx.addIssue({ code: 'custom', path: ['to'], message: `range must be at most ${MAX_RANGE_DAYS} days` });
  });
export type AnalyticsQuery = z.output<typeof analyticsQuerySchema>;

/** Number of days in an inclusive [from, to] date range. */
export function rangeDays(from: string, to: string): number {
  const a = Date.parse(from + 'T00:00:00Z');
  const b = Date.parse(to + 'T00:00:00Z');
  return Math.round((b - a) / 86_400_000) + 1;
}

/** The equally long period that ends the day before `from`. */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const days = rangeDays(from, to);
  const start = Date.parse(from + 'T00:00:00Z');
  const prevTo = new Date(start - 86_400_000);
  const prevFrom = new Date(start - days * 86_400_000);
  return { from: prevFrom.toISOString().slice(0, 10), to: prevTo.toISOString().slice(0, 10) };
}

export interface RangeInfo {
  from: string;
  to: string;
  timezone: string;
}

// ---------------------------------------------------------------- analytics responses

export interface OverviewMetrics {
  visitors: number;
  /** Visitors counted per session because they browsed without consent (no persistent id). */
  estimated_visitors: number;
  sessions: number;
  pageviews: number;
  events: number;
  bounces: number;
  /** 0..1 — sessions with exactly one page view and no other interaction event / sessions. */
  bounce_rate: number;
  avg_session_duration_s: number;
  pages_per_session: number;
}

export interface TimeseriesPoint {
  date: string;
  visitors: number;
  sessions: number;
  pageviews: number;
  bounce_rate: number;
}

export interface OverviewResponse {
  range: RangeInfo;
  metrics: OverviewMetrics;
  timeseries: TimeseriesPoint[];
  previous: { range: RangeInfo; metrics: OverviewMetrics; timeseries: TimeseriesPoint[] } | null;
  definitions: Record<string, string>;
}

export interface PageRow {
  page_path: string;
  pageviews: number;
  entrances: number;
  exits: number;
}
export interface EntryExitRow {
  page_path: string;
  sessions: number;
  bounce_rate: number;
  avg_session_duration_s: number;
}
export interface PagesResponse {
  range: RangeInfo;
  top_pages: PageRow[];
  landing_pages: EntryExitRow[];
  exit_pages: EntryExitRow[];
}

export interface ChannelRow {
  channel: Channel;
  sessions: number;
  visitors: number;
  bounce_rate: number;
  pageviews: number;
}
export interface ReferrerRow {
  referrer_host: string;
  channel: Channel;
  sessions: number;
  bounce_rate: number;
}
export interface CampaignRow {
  source: string;
  medium: string;
  campaign: string;
  sessions: number;
  bounce_rate: number;
}
export interface SourcesResponse {
  range: RangeInfo;
  channels: ChannelRow[];
  referrers: ReferrerRow[];
  campaigns: CampaignRow[];
}

export interface EventRow {
  event_name: string;
  count: number;
  share: number;
}
export interface PropertyBreakdownRow {
  key: string;
  value: string;
  count: number;
}
export interface EventsResponse {
  range: RangeInfo;
  events: EventRow[];
  /** Only present when `event_name` is passed. */
  properties?: PropertyBreakdownRow[];
}

export interface DeviceRow {
  device_category: DeviceCategory | 'unknown';
  sessions: number;
  visitors: number;
  bounce_rate: number;
  share: number;
}
export interface DevicesResponse {
  range: RangeInfo;
  devices: DeviceRow[];
}

export interface RealtimeEvent {
  event_id: string;
  event_name: string;
  event_time: string;
  received_at: string;
  page_path: string | null;
  device_category: string | null;
  consent_state: string;
}
export interface RealtimeResponse {
  active_visitors: number;
  window_minutes: number;
  pageviews_last_window: number;
  top_active_pages: { page_path: string; visitors: number }[];
  latest_events: RealtimeEvent[];
  last_event_received_at: string | null;
}

export const EXPORT_REPORTS = ['pages', 'sources', 'events'] as const;
export type ExportReport = (typeof EXPORT_REPORTS)[number];

export const METRIC_DEFINITIONS: Record<string, string> = {
  events: 'Accepted, non-duplicate, non-bot events.',
  pageviews: 'Accepted page_view events.',
  sessions:
    'Events from one visitor, split after 30 minutes of inactivity or at midnight in the site timezone.',
  visitors:
    'Distinct pseudonymous visitor ids. Traffic without consent has no persistent id and is counted once per session (estimated).',
  bounce: 'A session with exactly one page view and no other interaction event.',
  landing_page: 'First page view in a session.',
  attribution: 'Last non-direct touch within the session; precedence UTM > referrer > direct.',
};
