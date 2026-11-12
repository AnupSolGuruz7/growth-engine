import type { MigrationInterface, QueryRunner } from 'typeorm';

/** M4: SEO audit runs, crawled pages and findings (spec §7, §11). */
export class SeoAudit1762963200000 implements MigrationInterface {
  name = 'SeoAudit1762963200000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE seo_audits (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        site_id         uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        start_url       text NOT NULL,
        max_pages       integer NOT NULL,
        pages_crawled   integer NOT NULL DEFAULT 0,
        score           integer,
        summary         jsonb,                    -- counts by severity/category, robots + sitemap info
        error           text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        started_at      timestamptz,
        finished_at     timestamptz
      )`);
    await q.query(`CREATE INDEX seo_audits_site_idx ON seo_audits (site_id, created_at DESC)`);

    await q.query(`
      CREATE TABLE seo_pages (
        audit_id         uuid NOT NULL REFERENCES seo_audits(id) ON DELETE CASCADE,
        organization_id  uuid NOT NULL,
        site_id          uuid NOT NULL,
        url              text NOT NULL,
        path             text NOT NULL,
        depth            integer NOT NULL,
        status           integer,                 -- null when the fetch failed or robots blocked it
        final_url        text,
        redirect_chain   jsonb NOT NULL DEFAULT '[]',
        response_ms      integer,
        content_type     text,
        bytes            integer,
        fetch_error      text,
        blocked_by_robots boolean NOT NULL DEFAULT false,
        in_sitemap       boolean NOT NULL DEFAULT false,
        inlinks          integer NOT NULL DEFAULT 0,
        indexable        boolean NOT NULL DEFAULT false,
        title            text,
        meta_description text,
        canonical        text,
        robots_meta      text,
        x_robots_tag     text,
        lang             text,
        h1               jsonb NOT NULL DEFAULT '[]',
        headings         jsonb NOT NULL DEFAULT '[]',
        word_count       integer,
        internal_links   integer NOT NULL DEFAULT 0,
        external_links   integer NOT NULL DEFAULT 0,
        images           integer NOT NULL DEFAULT 0,
        images_missing_alt integer NOT NULL DEFAULT 0,
        structured_data  jsonb NOT NULL DEFAULT '[]',
        render_blocking  integer NOT NULL DEFAULT 0,
        text_excerpt     text,                    -- visible text, used for AI copy drafts (untrusted)
        pageviews_28d    integer NOT NULL DEFAULT 0,
        PRIMARY KEY (audit_id, url)
      )`);

    await q.query(`
      CREATE TABLE seo_findings (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        audit_id        uuid NOT NULL REFERENCES seo_audits(id) ON DELETE CASCADE,
        organization_id uuid NOT NULL,
        site_id         uuid NOT NULL,
        url             text NOT NULL,
        category        text NOT NULL CHECK (category IN ('technical', 'on-page', 'performance', 'search')),
        check_id        text NOT NULL,
        severity        text NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
        title           text NOT NULL,
        evidence        jsonb NOT NULL,
        explanation     text NOT NULL,
        suggested_fix   text NOT NULL,
        confidence      real NOT NULL,
        effort          smallint NOT NULL,
        limits          text,
        pageviews_28d   integer NOT NULL DEFAULT 0,
        priority        real NOT NULL,
        fingerprint     text NOT NULL,            -- check_id + url (+ group key); compares audits
        created_at      timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX seo_findings_audit_idx ON seo_findings (audit_id, priority DESC)`);
    await q.query(`CREATE INDEX seo_findings_fp_idx ON seo_findings (site_id, fingerprint)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE IF EXISTS seo_findings, seo_pages, seo_audits CASCADE`);
  }
}
