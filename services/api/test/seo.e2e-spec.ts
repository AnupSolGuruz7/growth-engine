import request from 'supertest';
import { setupTestApp, type TestContext } from './helpers';

describe('SEO audit API (e2e)', () => {
  let t: TestContext;
  let site: { id: string; organization_id: string };
  const api = () => request(t.app.getHttpServer());
  const key = () => ({ 'X-Dev-Key': t.devKey });

  beforeAll(async () => {
    t = await setupTestApp();
    site = (await api().post('/v1/sites').set(key()).send({ name: 'Shop', domain: 'shop.example.com' }).expect(201)).body;
  });
  afterAll(() => t.close());

  it('starts an audit on the site domain and refuses a second one while it runs', async () => {
    const res = await api().post('/v1/seo/audits').set(key()).send({ site_id: site.id }).expect(201);
    expect(res.body).toMatchObject({ status: 'queued', start_url: 'https://shop.example.com/', max_pages: 500, score: null });
    const again = await api().post('/v1/seo/audits').set(key()).send({ site_id: site.id }).expect(409);
    expect(again.body).toMatchObject({ error: 'audit_in_progress', audit_id: res.body.id });
    const list = await api().get('/v1/seo/audits').query({ site_id: site.id }).set(key()).expect(200);
    expect(list.body.map((a: { id: string }) => a.id)).toEqual([res.body.id]);
  });

  it('only crawls the registered domain', async () => {
    const other = (await api().post('/v1/sites').set(key()).send({ name: 'Other', domain: 'other.example.com' }).expect(201)).body;
    const bad = await api().post('/v1/seo/audits').set(key()).send({ site_id: other.id, start_url: 'https://evil.example.net/' }).expect(400);
    expect(bad.body.error).toBe('start_url_not_on_site');
    await api().post('/v1/seo/audits').set(key()).send({ site_id: other.id, start_url: 'https://www.other.example.com/blog' }).expect(201);
    await api().post('/v1/seo/audits').send({ site_id: other.id }).expect(401);
  });

  it('serves findings with new/unchanged flags, pages and a comparison', async () => {
    const mk = async (daysAgo: number) =>
      (await t.ds.query(
        `INSERT INTO seo_audits (organization_id, site_id, status, start_url, max_pages, score, created_at, finished_at)
         VALUES ($1, $2, 'completed', 'https://shop.example.com/', 500, 80, now() - make_interval(days => $3), now()) RETURNING id`,
        [site.organization_id, site.id, daysAgo],
      ))[0].id as string;
    // clear the queued audit from the first test so it is not "latest"
    await t.ds.query(`UPDATE seo_audits SET status = 'failed' WHERE site_id = $1 AND status = 'queued'`, [site.id]);
    const prev = await mk(7);
    const cur = await mk(0);
    const finding = (audit: string, check: string, url: string, fp: string, priority: number) =>
      t.ds.query(
        `INSERT INTO seo_findings (audit_id, organization_id, site_id, url, category, check_id, severity, title, evidence,
           explanation, suggested_fix, confidence, effort, priority, fingerprint)
         VALUES ($1, $2, $3, $4, 'on-page', $5, 'high', 't', '{}', 'why', 'fix', 0.9, 1, $6, $7)`,
        [audit, site.organization_id, site.id, url, check, priority, fp],
      );
    await finding(prev, 'title_missing', 'https://shop.example.com/a', 'fp-a', 5); // fixed since
    await finding(prev, 'h1_missing', 'https://shop.example.com/b', 'fp-b', 4); // still there
    await finding(cur, 'h1_missing', 'https://shop.example.com/b', 'fp-b', 4);
    await finding(cur, 'thin_content', 'https://shop.example.com/c', 'fp-c', 9); // new
    await t.ds.query(
      `INSERT INTO seo_pages (audit_id, organization_id, site_id, url, path, depth, status, title, h1, headings, indexable, pageviews_28d)
       VALUES ($1, $2, $3, 'https://shop.example.com/c', '/c', 1, 200, 'C page', '["C"]', '[{"level":1,"text":"C"}]', true, 40)`,
      [cur, site.organization_id, site.id],
    );

    const audit = await api().get(`/v1/seo/audits/${cur}`).set(key()).expect(200);
    expect(audit.body).toMatchObject({ previous_audit_id: prev, comparison: { new: 1, resolved: 1, unchanged: 1 } });

    const findings = await api().get(`/v1/seo/audits/${cur}/findings`).set(key()).expect(200);
    expect(findings.body.map((f: { check_id: string; change: string }) => [f.check_id, f.change])).toEqual([
      ['thin_content', 'new'],
      ['h1_missing', 'unchanged'],
    ]);
    const filtered = await api().get(`/v1/seo/audits/${cur}/findings`).query({ check_id: 'h1_missing' }).set(key()).expect(200);
    expect(filtered.body).toHaveLength(1);
    await api().get(`/v1/seo/audits/${cur}/findings`).query({ severity: 'urgent' }).set(key()).expect(400);

    const cmp = await api().get(`/v1/seo/audits/${cur}/compare/${prev}`).set(key()).expect(200);
    expect(cmp.body.counts).toEqual({ new: 1, resolved: 1, unchanged: 1 });
    expect(cmp.body.resolved[0].check_id).toBe('title_missing');

    const pages = await api().get(`/v1/seo/audits/${cur}/pages`).set(key()).expect(200);
    expect(pages.body).toEqual([expect.objectContaining({ path: '/c', title: 'C page', findings: 1, pageviews_28d: 40 })]);
    const page = await api().get(`/v1/seo/audits/${cur}/page`).query({ url: 'https://shop.example.com/c' }).set(key()).expect(200);
    expect(page.body).toMatchObject({ h1: ['C'], headings: [{ level: 1, text: 'C' }] });
    expect(page.body.issues.map((i: { check_id: string }) => i.check_id)).toEqual(['thin_content']);
  });

  it('keeps audits private to their organisation', async () => {
    const [org] = await t.ds.query(`INSERT INTO organizations (name, slug) VALUES ('Other org', 'other-seo') RETURNING id`);
    const [s] = await t.ds.query(`INSERT INTO sites (organization_id, name, domain, public_id) VALUES ($1, 'X', 'x.com', 'gos_x_seo') RETURNING id`, [org.id]);
    const [a] = await t.ds.query(`INSERT INTO seo_audits (organization_id, site_id, start_url, max_pages) VALUES ($1, $2, 'https://x.com/', 5) RETURNING id`, [org.id, s.id]);
    await api().get(`/v1/seo/audits/${a.id}`).set(key()).expect(404);
    await api().get(`/v1/seo/audits/${a.id}/findings`).set(key()).expect(404);
    await api().post('/v1/seo/audits').set(key()).send({ site_id: s.id }).expect(404);
  });
});
