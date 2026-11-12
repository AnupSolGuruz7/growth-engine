import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Worker, type Job } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import {
  auditScore, crawlSite, isContentChecked, isIndexable, runChecks, runPageSpeed, scoreFindings,
  type CrawlResult, type PageSpeedResult, type ScoredFinding,
} from '@growthos/seo';
import { SEO_CATEGORIES, SEO_JOB, SEO_QUEUE, SEO_SEVERITIES, type SeoAuditSummary } from '@growthos/shared-types';
import type { DataSource, EntityManager } from 'typeorm';
import { WORKER_CONFIG, type WorkerConfig } from './config';

interface AuditRow {
  id: string;
  organization_id: string;
  site_id: string;
  status: string;
  start_url: string;
  max_pages: number;
  timezone: string;
}

const pathKey = (url: string) => {
  try {
    return new URL(url).pathname.replace(/\/+$/, '') || '/';
  } catch {
    return '/';
  }
};
const isPrivateHost = (host: string) => host === 'localhost' || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host.endsWith('.local');

/**
 * Runs SEO audits (spec §7) on their own queue, one at a time, so long crawls never delay event
 * processing. Not retried automatically: a failed crawl is marked failed and can be re-run.
 */
@Injectable()
export class SeoAuditWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private worker?: Worker;
  private conn?: Redis;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @Inject(WORKER_CONFIG) private readonly cfg: WorkerConfig,
    private readonly log: PinoLogger,
  ) {
    log.setContext(SeoAuditWorker.name);
  }

  onApplicationBootstrap(): void {
    this.conn = new IORedis(this.cfg.redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker(SEO_QUEUE, (job: Job<{ audit_id: string }>) => this.run(job.data.audit_id), {
      connection: this.conn,
      concurrency: 1,
      lockDuration: 120_000,
    });
    this.worker.on('error', (err) => this.log.error({ err: err.message }, 'seo worker error'));
    this.log.info({ queue: SEO_QUEUE, job: SEO_JOB }, 'seo audit worker started');
  }

  async run(auditId: string): Promise<{ score: number; findings: number; pages: number } | null> {
    const [a]: AuditRow[] = await this.ds.query(
      `SELECT a.id, a.organization_id, a.site_id, a.status, a.start_url, a.max_pages, s.timezone
       FROM seo_audits a JOIN sites s ON s.id = a.site_id WHERE a.id = $1`,
      [auditId],
    );
    if (!a || a.status !== 'queued') return null;
    await this.ds.query(`UPDATE seo_audits SET status = 'running', started_at = now() WHERE id = $1`, [a.id]);
    const started = Date.now();
    try {
      const traffic = await this.traffic(a.site_id, a.timezone);
      let lastWrite = 0;
      const crawl = await crawlSite({
        startUrl: a.start_url,
        maxPages: a.max_pages,
        concurrency: this.cfg.seoConcurrency,
        delayMs: this.cfg.seoDelayMs,
        allowPrivate: this.cfg.seoAllowPrivate,
        userAgent: this.cfg.seoUserAgent,
        onProgress: async (n) => {
          if (Date.now() - lastWrite < 1500) return;
          lastWrite = Date.now();
          await this.ds.query(`UPDATE seo_audits SET pages_crawled = $2 WHERE id = $1`, [a.id, n]);
        },
      });
      const { psi, skipped } = await this.pagespeed(crawl, traffic);
      const findings = scoreFindings(runChecks(crawl, psi), traffic);
      const score = auditScore(findings);
      await this.ds.transaction(async (m) => {
        await this.savePages(m, a, crawl, traffic);
        await this.saveFindings(m, a, findings);
        await m.query(
          `UPDATE seo_audits SET status = 'completed', finished_at = now(), pages_crawled = $2, score = $3, summary = $4
           WHERE id = $1`,
          [a.id, crawl.pages.length, score, JSON.stringify(this.summary(crawl, findings, psi.length, skipped))],
        );
      });
      this.log.info({ audit_id: a.id, pages: crawl.pages.length, findings: findings.length, score, ms: Date.now() - started }, 'seo audit completed');
      return { score, findings: findings.length, pages: crawl.pages.length };
    } catch (e) {
      const msg = (e as Error).message.slice(0, 500);
      await this.ds.query(`UPDATE seo_audits SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [a.id, msg]);
      this.log.error({ audit_id: a.id, err: msg }, 'seo audit failed');
      return null;
    }
  }

  /** Page views per path over the last 28 days (site timezone) — used to rank findings by impact. */
  private async traffic(siteId: string, tz: string): Promise<Map<string, number>> {
    const rows: { page_path: string; pv: number }[] = await this.ds.query(
      `SELECT page_path, sum(pageviews)::int AS pv FROM agg_daily_page
       WHERE site_id = $1 AND date > (now() AT TIME ZONE $2)::date - 28 GROUP BY page_path`,
      [siteId, tz],
    );
    return new Map(rows.map((r) => [r.page_path.replace(/\/+$/, '') || '/', r.pv]));
  }

  /** Core Web Vitals for the homepage + top-traffic pages (public sites only). */
  private async pagespeed(crawl: CrawlResult, traffic: Map<string, number>): Promise<{ psi: PageSpeedResult[]; skipped: string | null }> {
    if (!this.cfg.pagespeedEnabled) return { psi: [], skipped: 'disabled' };
    if (isPrivateHost(crawl.host)) return { psi: [], skipped: 'private_host' };
    const candidates = crawl.pages
      .filter(isContentChecked)
      .sort((x, y) => (traffic.get(pathKey(y.url)) ?? 0) - (traffic.get(pathKey(x.url)) ?? 0))
      .slice(0, this.cfg.pagespeedPages)
      .map((p) => p.url);
    const results: PageSpeedResult[] = [];
    for (const url of candidates) {
      const r = await runPageSpeed(url, this.cfg.pagespeedApiKey);
      if (r) results.push(r);
    }
    return { psi: results, skipped: candidates.length && !results.length ? 'pagespeed_unavailable' : null };
  }

  private summary(crawl: CrawlResult, findings: ScoredFinding[], psiTested: number, psiSkipped: string | null): SeoAuditSummary {
    const by_severity = Object.fromEntries(SEO_SEVERITIES.map((s) => [s, 0])) as SeoAuditSummary['by_severity'];
    const by_category = Object.fromEntries(SEO_CATEGORIES.map((c) => [c, 0])) as SeoAuditSummary['by_category'];
    for (const f of findings) {
      by_severity[f.severity]++;
      by_category[f.category]++;
    }
    return {
      by_severity,
      by_category,
      pages: {
        crawled: crawl.pages.length,
        indexable: crawl.pages.filter(isIndexable).length,
        errors: crawl.pages.filter((p) => (p.status ?? 0) >= 400 || (p.fetchError && !p.blockedByRobots)).length,
        blocked_by_robots: crawl.pages.filter((p) => p.blockedByRobots).length,
        redirects: crawl.pages.filter((p) => p.finalUrl).length,
      },
      robots: { found: crawl.robots.found, status: crawl.robots.status, sitemaps: crawl.robots.sitemaps },
      sitemap: { url: crawl.sitemap.url, found: crawl.sitemap.found, valid: crawl.sitemap.valid, urls: crawl.sitemap.urls.length },
      pagespeed: { tested: psiTested, skipped_reason: psiSkipped },
    };
  }

  private async savePages(m: EntityManager, a: AuditRow, crawl: CrawlResult, traffic: Map<string, number>): Promise<void> {
    const rows = crawl.pages.map((p) => ({
      url: p.url,
      path: p.path,
      depth: p.depth,
      status: p.status,
      final_url: p.finalUrl,
      redirect_chain: p.redirectChain,
      response_ms: p.responseMs,
      content_type: p.contentType,
      bytes: p.bytes,
      fetch_error: p.fetchError,
      blocked_by_robots: p.blockedByRobots,
      in_sitemap: p.inSitemap,
      inlinks: p.inlinks,
      indexable: isIndexable(p),
      title: p.html?.title ?? null,
      meta_description: p.html?.metaDescription ?? null,
      canonical: p.html?.canonical ?? null,
      robots_meta: p.html?.robotsMeta ?? null,
      x_robots_tag: p.xRobotsTag,
      lang: p.html?.lang ?? null,
      h1: p.html?.h1 ?? [],
      headings: p.html?.headings ?? [],
      word_count: p.html?.wordCount ?? null,
      internal_links: p.html?.links.filter((l) => new URL(l.url).hostname.replace(/^www\./, '') === crawl.host.replace(/^www\./, '')).length ?? 0,
      external_links: p.html?.links.filter((l) => new URL(l.url).hostname.replace(/^www\./, '') !== crawl.host.replace(/^www\./, '')).length ?? 0,
      images: p.html?.images ?? 0,
      images_missing_alt: p.html?.imagesMissingAlt.length ?? 0,
      structured_data: p.html?.structuredData ?? [],
      render_blocking: (p.html?.renderBlocking.scripts.length ?? 0) + (p.html?.renderBlocking.stylesheets ?? 0),
      text_excerpt: p.html?.textExcerpt ?? null,
      pageviews_28d: traffic.get(pathKey(p.url)) ?? 0,
    }));
    for (let i = 0; i < rows.length; i += 200) {
      await m.query(
        `INSERT INTO seo_pages (audit_id, organization_id, site_id, url, path, depth, status, final_url, redirect_chain,
           response_ms, content_type, bytes, fetch_error, blocked_by_robots, in_sitemap, inlinks, indexable, title,
           meta_description, canonical, robots_meta, x_robots_tag, lang, h1, headings, word_count, internal_links,
           external_links, images, images_missing_alt, structured_data, render_blocking, text_excerpt, pageviews_28d)
         SELECT $1, $2, $3, r.url, r.path, r.depth, r.status, r.final_url, r.redirect_chain, r.response_ms, r.content_type,
           r.bytes, r.fetch_error, r.blocked_by_robots, r.in_sitemap, r.inlinks, r.indexable, r.title, r.meta_description,
           r.canonical, r.robots_meta, r.x_robots_tag, r.lang, r.h1, r.headings, r.word_count, r.internal_links,
           r.external_links, r.images, r.images_missing_alt, r.structured_data, r.render_blocking, r.text_excerpt, r.pageviews_28d
         FROM jsonb_to_recordset($4::jsonb) AS r(url text, path text, depth int, status int, final_url text,
           redirect_chain jsonb, response_ms int, content_type text, bytes int, fetch_error text, blocked_by_robots boolean,
           in_sitemap boolean, inlinks int, indexable boolean, title text, meta_description text, canonical text,
           robots_meta text, x_robots_tag text, lang text, h1 jsonb, headings jsonb, word_count int, internal_links int,
           external_links int, images int, images_missing_alt int, structured_data jsonb, render_blocking int,
           text_excerpt text, pageviews_28d int)
         ON CONFLICT (audit_id, url) DO NOTHING`,
        [a.id, a.organization_id, a.site_id, JSON.stringify(rows.slice(i, i + 200))],
      );
    }
  }

  private async saveFindings(m: EntityManager, a: AuditRow, findings: ScoredFinding[]): Promise<void> {
    for (let i = 0; i < findings.length; i += 200) {
      await m.query(
        `INSERT INTO seo_findings (audit_id, organization_id, site_id, url, category, check_id, severity, title, evidence,
           explanation, suggested_fix, confidence, effort, limits, pageviews_28d, priority, fingerprint)
         SELECT $1, $2, $3, f.url, f.category, f.check_id, f.severity, f.title, f.evidence, f.explanation, f.suggested_fix,
           f.confidence, f.effort, f.limits, f.pageviews_28d, f.priority, f.fingerprint
         FROM jsonb_to_recordset($4::jsonb) AS f(url text, category text, check_id text, severity text, title text,
           evidence jsonb, explanation text, suggested_fix text, confidence real, effort smallint, limits text,
           pageviews_28d int, priority real, fingerprint text)`,
        [a.id, a.organization_id, a.site_id, JSON.stringify(findings.slice(i, i + 200))],
      );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    this.conn?.disconnect();
  }
}
