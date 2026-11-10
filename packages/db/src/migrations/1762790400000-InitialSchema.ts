import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Initial schema for M1 (SDK + ingestion) and M2 (analytics).
 * Every tenant table carries organization_id and site_id (spec §3, §11).
 */
export class InitialSchema1762790400000 implements MigrationInterface {
  name = 'InitialSchema1762790400000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE organizations (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name        text NOT NULL,
        slug        text NOT NULL UNIQUE,
        created_at  timestamptz NOT NULL DEFAULT now()
      )`);

    await q.query(`
      CREATE TABLE sites (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name            text NOT NULL,
        domain          text NOT NULL,
        public_id       text NOT NULL UNIQUE,
        status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
        timezone        text NOT NULL DEFAULT 'UTC',
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX sites_org_idx ON sites (organization_id)`);

    // ---- raw events, partitioned monthly (UTC month boundaries) ----
    await q.query(`
      CREATE TABLE events (
        organization_id uuid NOT NULL,
        site_id         uuid NOT NULL,
        event_id        uuid NOT NULL,
        event_name      text NOT NULL,
        event_time      timestamptz NOT NULL,
        received_at     timestamptz NOT NULL DEFAULT now(),
        local_date      date NOT NULL,           -- event_time's day in the site timezone
        visitor_key     text NOT NULL,           -- v:<visitor_id> | e:<ephemeral_id> | x:<event_id>
        visitor_id      text,
        session_id      text,
        ephemeral_id    text,
        page_url        text,
        page_path       text,
        page_title      text,
        referrer        text,
        referrer_host   text,                    -- external referrers only
        utm_source      text,
        utm_medium      text,
        utm_campaign    text,
        utm_term        text,
        utm_content     text,
        device_category text,
        consent_state   text NOT NULL,
        schema_version  smallint NOT NULL,
        sdk_version     text,
        properties      jsonb NOT NULL DEFAULT '{}'::jsonb,
        CONSTRAINT events_dedup_key UNIQUE (site_id, event_id, event_time)
      ) PARTITION BY RANGE (event_time)`);
    await q.query(`CREATE TABLE events_default PARTITION OF events DEFAULT`);
    await q.query(`CREATE INDEX events_site_time_idx ON events (site_id, event_time)`);
    await q.query(`CREATE INDEX events_time_brin ON events USING brin (event_time)`);
    await q.query(`CREATE INDEX events_site_visitor_day_idx ON events (site_id, visitor_key, local_date)`);
    await q.query(`CREATE INDEX events_site_received_idx ON events (site_id, received_at)`);

    // Creates the monthly partition containing p_month. If the DEFAULT partition already holds
    // rows for that month (late creation), they are moved into the new partition.
    await q.query(`
      CREATE OR REPLACE FUNCTION growthos_ensure_events_partition(p_month date) RETURNS text
      LANGUAGE plpgsql AS $$
      DECLARE
        start_ts timestamptz := (date_trunc('month', p_month)::date::text || ' 00:00:00+00')::timestamptz;
        end_ts   timestamptz := ((date_trunc('month', p_month) + interval '1 month')::date::text || ' 00:00:00+00')::timestamptz;
        part     text := format('events_y%sm%s', to_char(p_month, 'YYYY'), to_char(p_month, 'MM'));
      BEGIN
        IF to_regclass(part) IS NOT NULL THEN
          RETURN part;
        END IF;
        IF EXISTS (SELECT 1 FROM events_default WHERE event_time >= start_ts AND event_time < end_ts) THEN
          CREATE TEMP TABLE _growthos_moved ON COMMIT DROP AS
            SELECT * FROM events_default WHERE event_time >= start_ts AND event_time < end_ts;
          DELETE FROM events_default WHERE event_time >= start_ts AND event_time < end_ts;
          EXECUTE format('CREATE TABLE %I PARTITION OF events FOR VALUES FROM (%L) TO (%L)', part, start_ts, end_ts);
          INSERT INTO events SELECT * FROM _growthos_moved;
          DROP TABLE _growthos_moved;
        ELSE
          EXECUTE format('CREATE TABLE %I PARTITION OF events FOR VALUES FROM (%L) TO (%L)', part, start_ts, end_ts);
        END IF;
        RETURN part;
      END $$`);
    await q.query(`
      SELECT growthos_ensure_events_partition((date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => m))::date)
      FROM generate_series(-1, 2) AS m`);

    // ---- derived sessions ----
    await q.query(`
      CREATE TABLE sessions (
        organization_id uuid NOT NULL,
        site_id         uuid NOT NULL,
        session_id      text NOT NULL,
        visitor_key     text NOT NULL,
        is_identified   boolean NOT NULL,        -- true when backed by a consented visitor_id
        local_date      date NOT NULL,
        started_at      timestamptz NOT NULL,
        ended_at        timestamptz NOT NULL,
        duration_s      integer NOT NULL,
        landing_path    text,
        exit_path       text,
        pageviews       integer NOT NULL,
        events          integer NOT NULL,
        interactions    integer NOT NULL,        -- non-page_view events
        is_bounce       boolean NOT NULL,
        channel         text NOT NULL,
        source          text NOT NULL DEFAULT '',
        medium          text NOT NULL DEFAULT '',
        campaign        text NOT NULL DEFAULT '',
        referrer_host   text NOT NULL DEFAULT '',
        device_category text,
        PRIMARY KEY (site_id, session_id)
      )`);
    await q.query(`CREATE INDEX sessions_site_date_idx ON sessions (site_id, local_date)`);
    await q.query(`CREATE INDEX sessions_site_visitor_day_idx ON sessions (site_id, visitor_key, local_date)`);

    // ---- durable work queues (Redis only carries wake-up signals) ----
    await q.query(`
      CREATE TABLE dirty_visitor_days (
        site_id     uuid NOT NULL,
        visitor_key text NOT NULL,
        local_date  date NOT NULL,
        marked_at   timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (site_id, visitor_key, local_date)
      )`);
    await q.query(`
      CREATE TABLE dirty_site_days (
        site_id    uuid NOT NULL,
        local_date date NOT NULL,
        marked_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (site_id, local_date)
      )`);

    // ---- daily rollups (bucketed in the site timezone) ----
    await q.query(`
      CREATE TABLE agg_daily_site (
        organization_id     uuid NOT NULL,
        site_id             uuid NOT NULL,
        date                date NOT NULL,
        visitors            integer NOT NULL,
        identified_visitors integer NOT NULL,
        estimated_visitors  integer NOT NULL,
        sessions            integer NOT NULL,
        pageviews           integer NOT NULL,
        events              integer NOT NULL,
        bounces             integer NOT NULL,
        total_duration_s    bigint NOT NULL,
        updated_at          timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (site_id, date)
      )`);
    await q.query(`
      CREATE TABLE agg_daily_page (
        organization_id uuid NOT NULL,
        site_id         uuid NOT NULL,
        date            date NOT NULL,
        page_path       text NOT NULL,
        pageviews       integer NOT NULL,
        visitors        integer NOT NULL,
        entrances       integer NOT NULL,
        exits           integer NOT NULL,
        PRIMARY KEY (site_id, date, page_path)
      )`);
    await q.query(`
      CREATE TABLE agg_daily_source (
        organization_id  uuid NOT NULL,
        site_id          uuid NOT NULL,
        date             date NOT NULL,
        channel          text NOT NULL,
        source           text NOT NULL,
        medium           text NOT NULL,
        campaign         text NOT NULL,
        referrer_host    text NOT NULL,
        sessions         integer NOT NULL,
        bounces          integer NOT NULL,
        pageviews        integer NOT NULL,
        total_duration_s bigint NOT NULL,
        PRIMARY KEY (site_id, date, channel, source, medium, campaign, referrer_host)
      )`);
    await q.query(`
      CREATE TABLE agg_daily_event (
        organization_id uuid NOT NULL,
        site_id         uuid NOT NULL,
        date            date NOT NULL,
        event_name      text NOT NULL,
        events          integer NOT NULL,
        visitors        integer NOT NULL,
        PRIMARY KEY (site_id, date, event_name)
      )`);

    // ---- bot drops (counted, never stored as events) ----
    await q.query(`
      CREATE TABLE bot_drops (
        organization_id uuid NOT NULL,
        site_id         uuid NOT NULL,
        date            date NOT NULL,           -- UTC day of receipt
        reason          text NOT NULL,
        count           integer NOT NULL,
        PRIMARY KEY (site_id, date, reason)
      )`);
  }

  async down(q: QueryRunner): Promise<void> {
    for (const t of [
      'bot_drops', 'agg_daily_event', 'agg_daily_source', 'agg_daily_page', 'agg_daily_site',
      'dirty_site_days', 'dirty_visitor_days', 'sessions', 'events', 'sites', 'organizations',
    ]) {
      await q.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
    }
    await q.query(`DROP FUNCTION IF EXISTS growthos_ensure_events_partition(date)`);
  }
}
