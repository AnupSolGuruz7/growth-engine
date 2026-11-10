import { createHash } from 'node:crypto';
import { classifyChannel, isNonDirectTouch, type Channel } from '@growthos/shared-types';
import type { DataSource, EntityManager } from 'typeorm';

export interface ProcessingOptions {
  /** Inactivity gap that ends a session (spec §6.1, default 30 minutes). */
  sessionTimeoutMin?: number;
  /** Dirty keys handled per transaction. */
  batchSize?: number;
}

interface RawEvent {
  event_id: string;
  event_name: string;
  event_time: Date;
  page_path: string | null;
  referrer_host: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  device_category: string | null;
}

export interface DerivedSession {
  session_id: string;
  started_at: Date;
  ended_at: Date;
  duration_s: number;
  landing_path: string | null;
  exit_path: string | null;
  pageviews: number;
  events: number;
  interactions: number;
  is_bounce: boolean;
  channel: Channel;
  source: string;
  medium: string;
  campaign: string;
  referrer_host: string;
  device_category: string | null;
}

/**
 * Pure sessionisation of one visitor's events for one local day (already ordered by time).
 * Midnight splits are implied because the input never spans two local days.
 */
export function deriveSessions(
  siteId: string,
  visitorKey: string,
  events: RawEvent[],
  timeoutMin = 30,
): DerivedSession[] {
  const gapMs = timeoutMin * 60_000;
  const groups: RawEvent[][] = [];
  let current: RawEvent[] = [];
  let last = -Infinity;
  for (const e of events) {
    const t = e.event_time.getTime();
    if (current.length && t - last > gapMs) {
      groups.push(current);
      current = [];
    }
    current.push(e);
    last = t;
  }
  if (current.length) groups.push(current);

  return groups.map((g) => {
    const first = g[0]!;
    const lastEv = g[g.length - 1]!;
    const views = g.filter((e) => e.event_name === 'page_view');
    const interactions = g.length - views.length;
    // Attribution: last non-direct touch within the session (UTM > referrer > direct).
    let touch: RawEvent | undefined;
    for (const e of views.length ? views : g) {
      if (isNonDirectTouch(e)) touch = e;
    }
    const channel = touch ? classifyChannel(touch) : 'direct';
    return {
      session_id:
        's_' + createHash('sha256').update(`${siteId}|${visitorKey}|${first.event_id}`).digest('hex').slice(0, 32),
      started_at: first.event_time,
      ended_at: lastEv.event_time,
      duration_s: Math.round((lastEv.event_time.getTime() - first.event_time.getTime()) / 1000),
      landing_path: views[0]?.page_path ?? first.page_path ?? null,
      exit_path: views[views.length - 1]?.page_path ?? lastEv.page_path ?? null,
      pageviews: views.length,
      events: g.length,
      interactions,
      is_bounce: views.length === 1 && interactions === 0,
      channel,
      source: (touch?.utm_source || touch?.referrer_host || '').slice(0, 256),
      medium: (touch?.utm_medium || '').slice(0, 256),
      campaign: (touch?.utm_campaign || '').slice(0, 256),
      referrer_host: touch?.referrer_host || '',
      device_category: g.find((e) => e.device_category)?.device_category ?? null,
    };
  });
}

/** SQL fragment bounding event_time around a local date so partition pruning applies. */
const DAY_BOUNDS = (dateParam: string) =>
  `event_time >= (${dateParam}::date - 1)::timestamptz AND event_time < (${dateParam}::date + 2)::timestamptz`;

/**
 * Takes up to `batchSize` dirty (site, visitor, day) keys, rebuilds those visitors' sessions for that
 * day from raw events (delete + insert, so re-running is safe), clears the keys and marks the
 * affected site days for rollup. Returns how many keys were processed.
 */
export async function sessionizeBatch(ds: DataSource, opts: ProcessingOptions = {}): Promise<number> {
  const timeout = opts.sessionTimeoutMin ?? 30;
  return ds.transaction(async (m) => {
    const keys: { site_id: string; organization_id: string; visitor_key: string; local_date: string }[] =
      await m.query(
        `SELECT d.site_id, s.organization_id, d.visitor_key, d.local_date
         FROM dirty_visitor_days d JOIN sites s ON s.id = d.site_id
         ORDER BY d.marked_at
         LIMIT $1
         FOR UPDATE OF d SKIP LOCKED`,
        [opts.batchSize ?? 200],
      );
    for (const k of keys) {
      await rebuildVisitorDay(m, k, timeout);
    }
    return keys.length;
  });
}

async function rebuildVisitorDay(
  m: EntityManager,
  k: { site_id: string; organization_id: string; visitor_key: string; local_date: string },
  timeoutMin: number,
): Promise<void> {
  const events: RawEvent[] = await m.query(
    `SELECT event_id, event_name, event_time, page_path, referrer_host, utm_source, utm_medium,
            utm_campaign, device_category
     FROM events
     WHERE site_id = $1 AND visitor_key = $2 AND local_date = $3 AND ${DAY_BOUNDS('$3')}
     ORDER BY event_time, event_id`,
    [k.site_id, k.visitor_key, k.local_date],
  );
  const sessions = deriveSessions(k.site_id, k.visitor_key, events, timeoutMin);

  await m.query(`DELETE FROM sessions WHERE site_id = $1 AND visitor_key = $2 AND local_date = $3`, [
    k.site_id, k.visitor_key, k.local_date,
  ]);
  if (sessions.length) {
    await m.query(
      `INSERT INTO sessions (
         organization_id, site_id, session_id, visitor_key, is_identified, local_date, started_at,
         ended_at, duration_s, landing_path, exit_path, pageviews, events, interactions, is_bounce,
         channel, source, medium, campaign, referrer_host, device_category)
       SELECT $1, $2, s.session_id, $3, $4, $5::date, s.started_at, s.ended_at, s.duration_s,
              s.landing_path, s.exit_path, s.pageviews, s.events, s.interactions, s.is_bounce,
              s.channel, s.source, s.medium, s.campaign, s.referrer_host, s.device_category
       FROM jsonb_to_recordset($6::jsonb) AS s(
         session_id text, started_at timestamptz, ended_at timestamptz, duration_s int,
         landing_path text, exit_path text, pageviews int, events int, interactions int,
         is_bounce boolean, channel text, source text, medium text, campaign text,
         referrer_host text, device_category text)`,
      [
        k.organization_id, k.site_id, k.visitor_key, k.visitor_key.startsWith('v:'), k.local_date,
        JSON.stringify(sessions),
      ],
    );
  }
  await m.query(`DELETE FROM dirty_visitor_days WHERE site_id = $1 AND visitor_key = $2 AND local_date = $3`, [
    k.site_id, k.visitor_key, k.local_date,
  ]);
  await m.query(
    `INSERT INTO dirty_site_days (site_id, local_date) VALUES ($1, $2)
     ON CONFLICT (site_id, local_date) DO UPDATE SET marked_at = now()`,
    [k.site_id, k.local_date],
  );
}

/** Recomputes all four rollups for dirty site days. Idempotent: delete + insert per (site, day). */
export async function rollupBatch(ds: DataSource, opts: ProcessingOptions = {}): Promise<number> {
  return ds.transaction(async (m) => {
    const days: { site_id: string; organization_id: string; local_date: string }[] = await m.query(
      `SELECT d.site_id, s.organization_id, d.local_date
       FROM dirty_site_days d JOIN sites s ON s.id = d.site_id
       ORDER BY d.marked_at
       LIMIT $1
       FOR UPDATE OF d SKIP LOCKED`,
      [Math.min(opts.batchSize ?? 50, 50)],
    );
    for (const d of days) {
      await rollupSiteDay(m, d.organization_id, d.site_id, d.local_date);
      await m.query(`DELETE FROM dirty_site_days WHERE site_id = $1 AND local_date = $2`, [d.site_id, d.local_date]);
    }
    return days.length;
  });
}

export async function rollupSiteDay(m: EntityManager, orgId: string, siteId: string, date: string): Promise<void> {
  const p = [orgId, siteId, date];
  for (const t of ['agg_daily_site', 'agg_daily_page', 'agg_daily_source', 'agg_daily_event']) {
    await m.query(`DELETE FROM ${t} WHERE site_id = $1 AND date = $2`, [siteId, date]);
  }

  // Visitors = distinct consented visitor ids + one per cookieless session (estimated).
  await m.query(
    `INSERT INTO agg_daily_site (organization_id, site_id, date, visitors, identified_visitors,
       estimated_visitors, sessions, pageviews, events, bounces, total_duration_s)
     SELECT $1, $2, $3::date,
            s.identified + s.estimated, s.identified, s.estimated, s.sessions,
            e.pageviews, e.events, s.bounces, s.duration
     FROM (SELECT count(DISTINCT visitor_key) FILTER (WHERE is_identified) AS identified,
                  count(*) FILTER (WHERE NOT is_identified) AS estimated,
                  count(*) AS sessions,
                  count(*) FILTER (WHERE is_bounce) AS bounces,
                  COALESCE(sum(duration_s), 0) AS duration
           FROM sessions WHERE site_id = $2 AND local_date = $3) s,
          (SELECT count(*) FILTER (WHERE event_name = 'page_view') AS pageviews, count(*) AS events
           FROM events WHERE site_id = $2 AND local_date = $3 AND ${DAY_BOUNDS('$3')}) e
     WHERE s.sessions > 0 OR e.events > 0`,
    p,
  );

  await m.query(
    `INSERT INTO agg_daily_page (organization_id, site_id, date, page_path, pageviews, visitors, entrances, exits)
     SELECT $1, $2, $3::date, pv.page_path, pv.pageviews, pv.visitors,
            COALESCE(en.c, 0), COALESCE(ex.c, 0)
     FROM (SELECT COALESCE(page_path, '/') AS page_path, count(*) AS pageviews,
                  count(DISTINCT visitor_key) AS visitors
           FROM events
           WHERE site_id = $2 AND local_date = $3 AND event_name = 'page_view' AND ${DAY_BOUNDS('$3')}
           GROUP BY 1) pv
     LEFT JOIN (SELECT landing_path, count(*) AS c FROM sessions
                WHERE site_id = $2 AND local_date = $3 GROUP BY 1) en ON en.landing_path = pv.page_path
     LEFT JOIN (SELECT exit_path, count(*) AS c FROM sessions
                WHERE site_id = $2 AND local_date = $3 GROUP BY 1) ex ON ex.exit_path = pv.page_path`,
    p,
  );

  await m.query(
    `INSERT INTO agg_daily_source (organization_id, site_id, date, channel, source, medium, campaign,
       referrer_host, sessions, bounces, pageviews, total_duration_s)
     SELECT $1, $2, $3::date, channel, source, medium, campaign, referrer_host,
            count(*), count(*) FILTER (WHERE is_bounce), sum(pageviews), sum(duration_s)
     FROM sessions WHERE site_id = $2 AND local_date = $3
     GROUP BY channel, source, medium, campaign, referrer_host`,
    p,
  );

  await m.query(
    `INSERT INTO agg_daily_event (organization_id, site_id, date, event_name, events, visitors)
     SELECT $1, $2, $3::date, event_name, count(*), count(DISTINCT visitor_key)
     FROM events WHERE site_id = $2 AND local_date = $3 AND ${DAY_BOUNDS('$3')}
     GROUP BY event_name`,
    p,
  );
}

export interface ProcessResult {
  sessionized: number;
  rolledUp: number;
}

/** Drains both work queues. Safe to call concurrently from several workers (SKIP LOCKED). */
export async function processPending(ds: DataSource, opts: ProcessingOptions = {}): Promise<ProcessResult> {
  let sessionized = 0;
  let rolledUp = 0;
  for (let n = await sessionizeBatch(ds, opts); n > 0; n = await sessionizeBatch(ds, opts)) sessionized += n;
  for (let n = await rollupBatch(ds, opts); n > 0; n = await rollupBatch(ds, opts)) rolledUp += n;
  return { sessionized, rolledUp };
}

/** Marks every visitor-day of a site in [from, to] dirty so processPending rebuilds them (backfill). */
export async function markRangeDirty(ds: DataSource, siteId: string, from: string, to: string): Promise<number> {
  const rows: { n: number }[] = await ds.query(
    `WITH ins AS (
       INSERT INTO dirty_visitor_days (site_id, visitor_key, local_date)
       SELECT DISTINCT site_id, visitor_key, local_date FROM events
       WHERE site_id = $1 AND local_date BETWEEN $2 AND $3
         AND event_time >= ($2::date - 1)::timestamptz AND event_time < ($3::date + 2)::timestamptz
       ON CONFLICT (site_id, visitor_key, local_date) DO UPDATE SET marked_at = now()
       RETURNING 1)
     SELECT count(*)::int AS n FROM ins`,
    [siteId, from, to],
  );
  // Days with no events left (e.g. after deletion) still need their rollups cleared.
  await ds.query(
    `INSERT INTO dirty_site_days (site_id, local_date)
     SELECT $1, d::date FROM generate_series($2::date, $3::date, interval '1 day') d
     ON CONFLICT (site_id, local_date) DO UPDATE SET marked_at = now()`,
    [siteId, from, to],
  );
  return rows[0]?.n ?? 0;
}
