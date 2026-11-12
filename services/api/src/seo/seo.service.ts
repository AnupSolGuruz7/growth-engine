import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import type { OnApplicationShutdown } from '@nestjs/common';
import {
  SEO_JOB,
  SEO_QUEUE,
  type CreateAuditInput,
  type SeoAuditDto,
  type SeoComparisonDto,
  type SeoFindingDto,
  type SeoPageDetail,
  type SeoPageRow,
} from '@growthos/shared-types';
import type { DataSource } from 'typeorm';
import type { TenantContext } from '../common/tenant';
import { APP_CONFIG, type AppConfig } from '../config';
import { SitesService } from '../sites/sites.service';

/** An audit stuck in queued/running longer than this no longer blocks a new one. */
const STALE_AFTER_MIN = 120;

const FINDING_COLS = `id, url, category, check_id, severity, title, evidence, explanation, suggested_fix, confidence,
  effort, limits, pageviews_28d, priority, fingerprint`;

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

export interface FindingFilters {
  severity?: string;
  category?: string;
  check_id?: string;
  url?: string;
}

/** SEO audits (spec §7). Every method resolves the site through SitesService.getOwned (tenant scope). */
@Injectable()
export class SeoService implements OnApplicationShutdown {
  private readonly queue: Queue;
  private readonly conn: IORedis;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly sites: SitesService,
    @Inject(APP_CONFIG) cfg: AppConfig,
  ) {
    this.conn = new IORedis(cfg.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    this.conn.on('error', () => undefined);
    this.queue = new Queue(SEO_QUEUE, { connection: this.conn });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close().catch(() => undefined);
    this.conn.disconnect();
  }

  /** Default start URL: https://<domain>/ (http for localhost / IPs used in development). */
  static defaultStartUrl(domain: string): string {
    const host = domain.replace(/:\d+$/, '');
    const local = host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host);
    return `${local ? 'http' : 'https'}://${domain}/`;
  }

  async create(t: TenantContext, input: CreateAuditInput): Promise<SeoAuditDto> {
    const site = await this.sites.getOwned(t, input.site_id);
    const startUrl = input.start_url ?? SeoService.defaultStartUrl(site.domain);
    const u = new URL(startUrl);
    const strip = (h: string) => h.toLowerCase().replace(/^www\./, '');
    if (!/^https?:$/.test(u.protocol) || strip(u.hostname) !== strip(site.domain.replace(/:\d+$/, ''))) {
      throw new BadRequestException({
        error: 'start_url_not_on_site',
        message: `start_url must be on the site's domain (${site.domain})`,
      });
    }
    await this.ds.query(
      `UPDATE seo_audits SET status = 'failed', error = 'stale: no progress', finished_at = now()
       WHERE site_id = $1 AND status IN ('queued', 'running') AND created_at < now() - make_interval(mins => $2)`,
      [site.id, STALE_AFTER_MIN],
    );
    const [busy] = await this.ds.query(`SELECT id FROM seo_audits WHERE site_id = $1 AND status IN ('queued', 'running') LIMIT 1`, [site.id]);
    if (busy) throw new ConflictException({ error: 'audit_in_progress', message: 'An audit is already running for this site', audit_id: busy.id });

    const [row] = await this.ds.query(
      `INSERT INTO seo_audits (organization_id, site_id, start_url, max_pages) VALUES ($1, $2, $3, $4) RETURNING id`,
      [site.organization_id, site.id, u.toString(), input.max_pages ?? 500],
    );
    try {
      await this.queue.add(SEO_JOB, { audit_id: row.id }, { jobId: `audit-${row.id}`, removeOnComplete: 100, removeOnFail: 100 });
    } catch (e) {
      await this.ds.query(`UPDATE seo_audits SET status = 'failed', error = $2 WHERE id = $1`, [row.id, 'queue unavailable']);
      throw e;
    }
    return this.get(t, row.id);
  }

  async list(t: TenantContext, siteId: string): Promise<SeoAuditDto[]> {
    const site = await this.sites.getOwned(t, siteId);
    const rows: { id: string }[] = await this.ds.query(
      `SELECT id FROM seo_audits WHERE site_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [site.id],
    );
    return Promise.all(rows.map((r) => this.get(t, r.id)));
  }

  /** Loads an audit and checks it belongs to the tenant. */
  private async owned(t: TenantContext, auditId: string) {
    const [a] = await this.ds.query(`SELECT * FROM seo_audits WHERE id = $1 AND organization_id = $2`, [auditId, t.organizationId]);
    if (!a) throw new NotFoundException({ error: 'audit_not_found', message: 'Audit not found' });
    return a as {
      id: string; site_id: string; status: SeoAuditDto['status']; start_url: string; max_pages: number; pages_crawled: number;
      score: number | null; summary: SeoAuditDto['summary']; error: string | null; created_at: Date; started_at: Date | null; finished_at: Date | null;
    };
  }

  async get(t: TenantContext, auditId: string): Promise<SeoAuditDto> {
    const a = await this.owned(t, auditId);
    const [prev] = await this.ds.query(
      `SELECT id FROM seo_audits WHERE site_id = $1 AND status = 'completed' AND created_at < $2 ORDER BY created_at DESC LIMIT 1`,
      [a.site_id, a.created_at],
    );
    let comparison: SeoAuditDto['comparison'] = null;
    if (prev && a.status === 'completed') {
      const [c] = await this.ds.query(
        `WITH cur AS (SELECT DISTINCT fingerprint FROM seo_findings WHERE audit_id = $1),
              old AS (SELECT DISTINCT fingerprint FROM seo_findings WHERE audit_id = $2)
         SELECT (SELECT count(*) FROM cur WHERE fingerprint NOT IN (SELECT fingerprint FROM old))::int AS new,
                (SELECT count(*) FROM old WHERE fingerprint NOT IN (SELECT fingerprint FROM cur))::int AS resolved,
                (SELECT count(*) FROM cur WHERE fingerprint IN (SELECT fingerprint FROM old))::int AS unchanged`,
        [a.id, prev.id],
      );
      comparison = c;
    }
    return {
      id: a.id,
      site_id: a.site_id,
      status: a.status,
      start_url: a.start_url,
      max_pages: a.max_pages,
      pages_crawled: a.pages_crawled,
      score: a.score,
      summary: a.summary,
      error: a.error,
      created_at: iso(a.created_at)!,
      started_at: iso(a.started_at),
      finished_at: iso(a.finished_at),
      previous_audit_id: prev?.id ?? null,
      comparison,
    };
  }

  async findings(t: TenantContext, auditId: string, f: FindingFilters = {}): Promise<SeoFindingDto[]> {
    const a = await this.get(t, auditId);
    const rows: SeoFindingDto[] = await this.ds.query(
      `SELECT ${FINDING_COLS},
              CASE WHEN $6::uuid IS NULL THEN NULL
                   WHEN EXISTS (SELECT 1 FROM seo_findings o WHERE o.audit_id = $6 AND o.fingerprint = f.fingerprint) THEN 'unchanged'
                   ELSE 'new' END AS change
       FROM seo_findings f
       WHERE audit_id = $1
         AND ($2::text IS NULL OR severity = $2) AND ($3::text IS NULL OR category = $3)
         AND ($4::text IS NULL OR check_id = $4) AND ($5::text IS NULL OR url = $5)
       ORDER BY priority DESC, url
       LIMIT 2000`,
      [a.id, f.severity ?? null, f.category ?? null, f.check_id ?? null, f.url ?? null, a.previous_audit_id],
    );
    return rows.map((r) => (r.change ? r : { ...r, change: undefined }));
  }

  async pages(t: TenantContext, auditId: string): Promise<SeoPageRow[]> {
    const a = await this.owned(t, auditId);
    return this.ds.query(
      `SELECT p.url, p.path, p.status, p.title, p.meta_description, p.h1, p.word_count, p.inlinks, p.indexable,
              p.in_sitemap, p.response_ms, p.pageviews_28d,
              (SELECT count(*)::int FROM seo_findings f WHERE f.audit_id = p.audit_id AND f.url = p.url) AS findings
       FROM seo_pages p WHERE p.audit_id = $1
       ORDER BY p.pageviews_28d DESC, p.depth, p.url LIMIT 1000`,
      [a.id],
    );
  }

  async page(t: TenantContext, auditId: string, url: string): Promise<SeoPageDetail> {
    const a = await this.owned(t, auditId);
    const [p] = await this.ds.query(
      `SELECT url, path, depth, status, final_url, redirect_chain, response_ms, content_type, bytes, fetch_error,
              blocked_by_robots, in_sitemap, inlinks, indexable, title, meta_description, canonical, robots_meta,
              x_robots_tag, lang, h1, headings, word_count, internal_links, external_links, images, images_missing_alt,
              structured_data, render_blocking, pageviews_28d
       FROM seo_pages WHERE audit_id = $1 AND url = $2`,
      [a.id, url],
    );
    if (!p) throw new NotFoundException({ error: 'page_not_found', message: 'Page not in this audit' });
    const issues = await this.findings(t, auditId, { url });
    return { ...p, findings: issues.length, issues };
  }

  async compare(t: TenantContext, auditId: string, prevId: string): Promise<SeoComparisonDto> {
    const cur = await this.owned(t, auditId);
    const prev = await this.owned(t, prevId);
    if (cur.site_id !== prev.site_id) throw new BadRequestException({ error: 'different_sites', message: 'Audits belong to different sites' });
    const diff = (a: string, b: string): Promise<SeoFindingDto[]> =>
      this.ds.query(
        `SELECT ${FINDING_COLS} FROM seo_findings f
         WHERE audit_id = $1 AND NOT EXISTS (SELECT 1 FROM seo_findings o WHERE o.audit_id = $2 AND o.fingerprint = f.fingerprint)
         ORDER BY priority DESC, url`,
        [a, b],
      );
    const [added, resolved, [{ n }]] = await Promise.all([
      diff(cur.id, prev.id),
      diff(prev.id, cur.id),
      this.ds.query(
        `SELECT count(DISTINCT fingerprint)::int AS n FROM seo_findings f WHERE audit_id = $1
           AND EXISTS (SELECT 1 FROM seo_findings o WHERE o.audit_id = $2 AND o.fingerprint = f.fingerprint)`,
        [cur.id, prev.id],
      ),
    ]);
    return {
      audit_id: cur.id,
      previous_audit_id: prev.id,
      counts: { new: new Set(added.map((x) => x.fingerprint)).size, resolved: new Set(resolved.map((x) => x.fingerprint)).size, unchanged: n },
      new: added,
      resolved,
    };
  }
}
