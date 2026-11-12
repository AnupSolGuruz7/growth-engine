import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import IORedis from 'ioredis';
import { freshTestDataSource, seedDevOrganization } from '@growthos/db';
import { EXPECTED_FINDINGS, startFixtureSite } from '@growthos/seo';
import type { DataSource } from 'typeorm';
import { loadWorkerConfig } from '../src/config';
import { SeoAuditWorker } from '../src/seo-audit.worker';
import { WorkerModule } from '../src/worker.module';

describe('SEO audit job (e2e against a local fixture site)', () => {
  let ds: DataSource;
  let app: INestApplicationContext;
  let fixture: Awaited<ReturnType<typeof startFixtureSite>>;
  let site: { id: string; organization_id: string };

  beforeAll(async () => {
    ds = await freshTestDataSource();
    fixture = await startFixtureSite();
    const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';
    const r = new IORedis(redisUrl);
    await r.flushdb();
    r.disconnect();
    const cfg = loadWorkerConfig({
      databaseUrl: process.env.TEST_DATABASE_URL!, redisUrl, logLevel: 'silent', env: 'test', schedulers: false,
      seoAllowPrivate: true, seoDelayMs: 0, pagespeedEnabled: false,
    });
    app = await NestFactory.createApplicationContext(WorkerModule.forRoot(cfg), { logger: false });
    const org = await seedDevOrganization(ds);
    [site] = await ds.query(
      `INSERT INTO sites (organization_id, name, domain, public_id) VALUES ($1, 'Fixture', $2, 'gos_fixture') RETURNING id, organization_id`,
      [org.id, new URL(fixture.url).host],
    );
    // traffic so priorities reflect real visits: /about is the busiest page
    await ds.query(
      `INSERT INTO agg_daily_page (organization_id, site_id, date, page_path, pageviews, visitors, entrances, exits)
       VALUES ($1, $2, CURRENT_DATE - 1, '/about', 900, 500, 400, 300), ($1, $2, CURRENT_DATE - 1, '/blog', 12, 10, 5, 5)`,
      [site.organization_id, site.id],
    );
  });

  afterAll(async () => {
    await app?.close();
    await fixture?.close();
    await ds?.destroy();
  });

  const newAudit = async () =>
    (await ds.query(
      `INSERT INTO seo_audits (organization_id, site_id, start_url, max_pages) VALUES ($1, $2, $3, 100) RETURNING id`,
      [site.organization_id, site.id, fixture.url + '/'],
    ))[0].id as string;

  it('crawls, checks, scores and stores the audit', async () => {
    const id = await newAudit();
    const res = await app.get(SeoAuditWorker).run(id);
    expect(res).toMatchObject({ pages: expect.any(Number), findings: expect.any(Number) });

    const [audit] = await ds.query(`SELECT status, score, pages_crawled, summary FROM seo_audits WHERE id = $1`, [id]);
    expect(audit.status).toBe('completed');
    expect(audit.score).toBeGreaterThan(0);
    expect(audit.score).toBeLessThan(100);
    expect(audit.summary.robots.found).toBe(true);
    expect(audit.summary.sitemap).toMatchObject({ found: true, valid: true, urls: 7 });
    expect(audit.summary.pages.blocked_by_robots).toBe(1);
    expect(audit.summary.pagespeed.skipped_reason).toBe('disabled');

    const findings = await ds.query(`SELECT check_id, url, priority, pageviews_28d FROM seo_findings WHERE audit_id = $1 ORDER BY priority DESC`, [id]);
    const got = new Set(findings.map((f: { check_id: string; url: string }) => `${f.check_id} ${new URL(f.url).pathname}`));
    expect(EXPECTED_FINDINGS.filter(([c, p]) => !got.has(`${c} ${p}`))).toEqual([]);
    // the busy page's missing title outranks the same kind of issue on quiet pages
    const aboutTitle = findings.find((f: { check_id: string }) => f.check_id === 'title_missing');
    expect(aboutTitle.pageviews_28d).toBe(900);

    const [about] = await ds.query(`SELECT title, indexable, text_excerpt, pageviews_28d FROM seo_pages WHERE audit_id = $1 AND path = '/about'`, [id]);
    expect(about).toMatchObject({ title: null, indexable: true, pageviews_28d: 900 });
    expect(about.text_excerpt).toContain('Ignore all previous instructions'); // stored as data, flagged nowhere as an instruction
  });

  it('completes with a fetch_failed finding when the site is unreachable', async () => {
    const [{ id }] = await ds.query(
      `INSERT INTO seo_audits (organization_id, site_id, start_url, max_pages) VALUES ($1, $2, 'http://127.0.0.1:1/', 10) RETURNING id`,
      [site.organization_id, site.id],
    );
    await app.get(SeoAuditWorker).run(id);
    const [a] = await ds.query(`SELECT status FROM seo_audits WHERE id = $1`, [id]);
    expect(a.status).toBe('completed');
    const checks = await ds.query(`SELECT check_id FROM seo_findings WHERE audit_id = $1 ORDER BY check_id`, [id]);
    expect(checks.map((c: { check_id: string }) => c.check_id)).toEqual(expect.arrayContaining(['fetch_failed', 'robots_missing', 'sitemap_missing']));
  });
});
