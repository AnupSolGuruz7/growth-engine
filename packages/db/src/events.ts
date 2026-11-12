import type { EntityManager, DataSource } from 'typeorm';

type Db = EntityManager | DataSource;

/** A fully normalised event ready for storage (the API and seed scripts build these). */
export interface NormalizedEvent {
  event_id: string;
  event_name: string;
  event_time: string;
  visitor_id: string | null;
  session_id: string | null;
  ephemeral_id: string | null;
  page_url: string | null;
  page_path: string | null;
  page_title: string | null;
  referrer: string | null;
  referrer_host: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  device_category: string | null;
  consent_state: string;
  schema_version: number;
  sdk_version: string | null;
  properties: Record<string, unknown>;
}

export interface SiteRef {
  id: string;
  organization_id: string;
  timezone: string;
}

/**
 * Bulk-inserts events with ON CONFLICT DO NOTHING on (site_id, event_id, event_time) and, in the
 * same statement, marks the affected (visitor, local day) pairs for re-sessionisation. Returns the
 * number of rows actually inserted; the rest were duplicates.
 *
 * visitor_key: consented visitor_id > in-memory ephemeral id > the event itself.
 */
export async function insertEvents(db: Db, site: SiteRef, events: NormalizedEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  return db.transaction(async (m) => {
    const inserted = await insertRows(m, site, events);
    await stitchConsentedVisits(m, site, events);
    return inserted;
  });
}

/**
 * When consent is granted part-way through a page visit, the events sent before it carry only the
 * in-memory ephemeral id. Re-key those events (same ephemeral id = same page lifetime) to the
 * consented visitor so the visit is one session, and mark both keys for re-sessionisation.
 */
async function stitchConsentedVisits(m: EntityManager, site: SiteRef, events: NormalizedEvent[]): Promise<void> {
  const pairs = new Map<string, string>();
  for (const e of events) {
    if (e.consent_state === 'granted' && e.visitor_id && e.ephemeral_id) pairs.set(e.ephemeral_id, e.visitor_id);
  }
  if (pairs.size === 0) return;
  await m.query(
    `WITH s AS (
       SELECT * FROM jsonb_to_recordset($2::jsonb) AS s(eph text, vid text)
     ),
     upd AS (
       UPDATE events e SET visitor_key = 'v:' || s.vid
       FROM s
       WHERE e.site_id = $1 AND e.visitor_key = 'e:' || s.eph AND e.event_time > now() - interval '8 days'
       RETURNING e.site_id, e.local_date, e.visitor_key AS new_key, 'e:' || s.eph AS old_key
     )
     INSERT INTO dirty_visitor_days (site_id, visitor_key, local_date)
     SELECT site_id, new_key, local_date FROM upd
     UNION
     SELECT site_id, old_key, local_date FROM upd
     ON CONFLICT (site_id, visitor_key, local_date) DO UPDATE SET marked_at = now()`,
    [site.id, JSON.stringify([...pairs].map(([eph, vid]) => ({ eph, vid })))],
  );
}

async function insertRows(db: EntityManager, site: SiteRef, events: NormalizedEvent[]): Promise<number> {
  const rows: { inserted: number }[] = await db.query(
    `
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset($4::jsonb) AS r(
        event_id uuid, event_name text, event_time timestamptz, visitor_id text, session_id text,
        ephemeral_id text, page_url text, page_path text, page_title text, referrer text,
        referrer_host text, utm_source text, utm_medium text, utm_campaign text, utm_term text,
        utm_content text, device_category text, consent_state text, schema_version smallint,
        sdk_version text, properties jsonb)
    ),
    ins AS (
      INSERT INTO events (
        organization_id, site_id, event_id, event_name, event_time, received_at, local_date,
        visitor_key, visitor_id, session_id, ephemeral_id, page_url, page_path, page_title,
        referrer, referrer_host, utm_source, utm_medium, utm_campaign, utm_term, utm_content,
        device_category, consent_state, schema_version, sdk_version, properties)
      SELECT
        $1, $2, i.event_id, i.event_name, i.event_time, now(),
        (i.event_time AT TIME ZONE $3)::date,
        COALESCE('v:' || CASE WHEN i.consent_state = 'granted' THEN i.visitor_id END,
                 'e:' || i.ephemeral_id,
                 'x:' || i.event_id::text),
        CASE WHEN i.consent_state = 'granted' THEN i.visitor_id END,
        CASE WHEN i.consent_state = 'granted' THEN i.session_id END,
        i.ephemeral_id, i.page_url, i.page_path, i.page_title, i.referrer, i.referrer_host,
        i.utm_source, i.utm_medium, i.utm_campaign, i.utm_term, i.utm_content, i.device_category,
        i.consent_state, i.schema_version, i.sdk_version, COALESCE(i.properties, '{}'::jsonb)
      FROM input i
      ON CONFLICT (site_id, event_id, event_time) DO NOTHING
      RETURNING site_id, visitor_key, local_date
    ),
    dirty AS (
      INSERT INTO dirty_visitor_days (site_id, visitor_key, local_date)
      SELECT DISTINCT site_id, visitor_key, local_date FROM ins
      ON CONFLICT (site_id, visitor_key, local_date) DO UPDATE SET marked_at = now()
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM ins)::int AS inserted, (SELECT count(*) FROM dirty)::int AS dirty
    `,
    [site.organization_id, site.id, site.timezone, JSON.stringify(events)],
  );
  return rows[0]?.inserted ?? 0;
}

/** Increments the per-day bot counter. */
export async function recordBotDrops(db: Db, site: SiteRef, reason: string, count: number): Promise<void> {
  if (count <= 0) return;
  await db.query(
    `INSERT INTO bot_drops (organization_id, site_id, date, reason, count)
     VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date, $3, $4)
     ON CONFLICT (site_id, date, reason) DO UPDATE SET count = bot_drops.count + EXCLUDED.count`,
    [site.organization_id, site.id, reason, count],
  );
}

/** Removes all analytics data of a site (raw events, sessions, rollups, queues). */
const ANALYTICS_TABLES = [
  'events', 'sessions', 'dirty_visitor_days', 'dirty_site_days', 'agg_daily_site', 'agg_daily_page',
  'agg_daily_source', 'agg_daily_event', 'bot_drops',
];

/**
 * Deletes a site's data. `analyticsOnly` resets traffic data but keeps SEO audits and AI
 * suggestions/conversations (used by the demo reseed). ai_calls / ai_tool_calls are the audit
 * log and are always kept.
 */
export async function deleteSiteData(db: Db, siteId: string, opts: { analyticsOnly?: boolean } = {}): Promise<void> {
  for (const t of [...ANALYTICS_TABLES, ...(opts.analyticsOnly ? [] : ['seo_audits', 'suggestion_runs', 'ai_conversations'])]) {
    await db.query(`DELETE FROM ${t} WHERE site_id = $1`, [siteId]);
  }
}

/** Ensures monthly partitions exist from `monthsBack` before to `monthsAhead` after the current UTC month. */
export async function ensurePartitions(db: Db, monthsBack = 1, monthsAhead = 2): Promise<string[]> {
  const rows: { p: string }[] = await db.query(
    `SELECT growthos_ensure_events_partition(
       (date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => m))::date) AS p
     FROM generate_series($1::int, $2::int) AS m`,
    [-monthsBack, monthsAhead],
  );
  return rows.map((r) => r.p);
}
