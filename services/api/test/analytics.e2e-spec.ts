import request from 'supertest';
import { insertEvents, processPending, type NormalizedEvent } from '@growthos/db';
import { setupTestApp, type TestContext } from './helpers';

/**
 * Deterministic fixture. Site timezone America/New_York (EST, UTC-5 in November 2026).
 * Every expected value below was computed by hand from this table — not by the code under test.
 *
 *  id   visitor          UTC time              local (EST)       event           path      touch
 *  e1   v1 (granted)     2026-11-03 14:00      11-03 09:00       page_view       /         ref google.com
 *  e2   v1               2026-11-03 14:10      11-03 09:10       page_view       /pricing
 *  e3   v1               2026-11-03 14:11      11-03 09:11       signup_click    /pricing  {plan: pro}
 *  e4   v1               2026-11-03 15:00      11-03 10:00       page_view       /blog     (49 min gap -> new session)
 *  e5   v2 (granted)     2026-11-04 04:50      11-03 23:50 (!)   page_view       /         utm newsletter/email/nov
 *  e6   v2               2026-11-04 05:10      11-04 00:10       page_view       /pricing  (local midnight -> new session)
 *  e7   c1 (pending)     2026-11-04 15:00      11-04 10:00       page_view       /blog     ref t.co
 *  e8   c1               2026-11-04 15:01      11-04 10:01       outbound_click  /blog     {host: apps.apple.com}
 *  e9   c2 (denied)      2026-11-04 16:00      11-04 11:00       page_view       /         utm google/cpc/brand + ref google.com
 *  e10  v1               2026-11-04 13:00      11-04 08:00       page_view       /         ref chatgpt.com
 *
 * Sessions:
 *  S1 v1 11-03 e1-e3  pv2 int1  no bounce  organic_search  660s  / -> /pricing   desktop
 *  S2 v1 11-03 e4     pv1       bounce     direct          0s    /blog           desktop
 *  S3 v2 11-03 e5     pv1       bounce     email (nov)     0s    /               mobile
 *  S4 v2 11-04 e6     pv1       bounce     direct          0s    /pricing        mobile
 *  S5 c1 11-04 e7-e8  pv1 int1  no bounce  social          60s   /blog           tablet   (cookieless)
 *  S6 c2 11-04 e9     pv1       bounce     paid (brand)    0s    /               desktop  (cookieless)
 *  S7 v1 11-04 e10    pv1       bounce     ai_assistant    0s    /               desktop
 */
const T = (n: number, time: string, over: Partial<NormalizedEvent>): NormalizedEvent => ({
  event_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  event_name: 'page_view', event_time: time, visitor_id: null, session_id: null, ephemeral_id: null,
  page_url: null, page_path: '/', page_title: null, referrer: null, referrer_host: null, utm_source: null,
  utm_medium: null, utm_campaign: null, utm_term: null, utm_content: null, device_category: 'desktop',
  consent_state: 'granted', schema_version: 1, sdk_version: 'fixture', properties: {}, ...over,
});
const v1 = { visitor_id: 'v1', device_category: 'desktop' };
const v2 = { visitor_id: 'v2', device_category: 'mobile' };
const c1 = { ephemeral_id: 'c1', consent_state: 'pending', device_category: 'tablet' };
const c2 = { ephemeral_id: 'c2', consent_state: 'denied', device_category: 'desktop' };

const FIXTURE: NormalizedEvent[] = [
  T(1, '2026-11-03T14:00:00Z', { ...v1, referrer_host: 'google.com', referrer: 'https://www.google.com/' }),
  T(2, '2026-11-03T14:10:00Z', { ...v1, page_path: '/pricing' }),
  T(3, '2026-11-03T14:11:00Z', { ...v1, event_name: 'signup_click', page_path: '/pricing', properties: { plan: 'pro' } }),
  T(4, '2026-11-03T15:00:00Z', { ...v1, page_path: '/blog' }),
  T(5, '2026-11-04T04:50:00Z', { ...v2, utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'nov' }),
  T(6, '2026-11-04T05:10:00Z', { ...v2, page_path: '/pricing' }),
  T(7, '2026-11-04T15:00:00Z', { ...c1, page_path: '/blog', referrer_host: 't.co', referrer: 'https://t.co/' }),
  T(8, '2026-11-04T15:01:00Z', { ...c1, event_name: 'outbound_click', page_path: '/blog', properties: { host: 'apps.apple.com' } }),
  T(9, '2026-11-04T16:00:00Z', { ...c2, utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'brand', referrer_host: 'google.com' }),
  T(10, '2026-11-04T13:00:00Z', { ...v1, referrer_host: 'chatgpt.com' }),
];

describe('Analytics against a hand-computed fixture (e2e)', () => {
  let t: TestContext;
  let siteId: string;
  const get = (path: string, q: Record<string, string>) =>
    request(t.app.getHttpServer()).get(path).query(q).set('X-Dev-Key', t.devKey);
  const range = () => ({ site_id: siteId, from: '2026-11-03', to: '2026-11-04' });

  beforeAll(async () => {
    t = await setupTestApp();
    const res = await request(t.app.getHttpServer())
      .post('/v1/sites')
      .set('X-Dev-Key', t.devKey)
      .send({ name: 'Fixture', domain: 'fixture.example.com', timezone: 'America/New_York' })
      .expect(201);
    siteId = res.body.id;
    // insert in shuffled order: results must not depend on arrival order
    const shuffled = [FIXTURE[9], FIXTURE[4], FIXTURE[0], FIXTURE[7], FIXTURE[2], FIXTURE[5], FIXTURE[1], FIXTURE[8], FIXTURE[3], FIXTURE[6]];
    await insertEvents(t.ds, res.body, shuffled as NormalizedEvent[]);
    await processPending(t.ds);
  });
  afterAll(() => t.close());

  it('buckets by local day and splits sessions on 30 min inactivity and local midnight', async () => {
    const rows = await t.ds.query(
      `SELECT local_date, visitor_key, landing_path, exit_path, pageviews, interactions, is_bounce, channel, duration_s
       FROM sessions WHERE site_id = $1 ORDER BY started_at`,
      [siteId],
    );
    expect(rows).toEqual([
      { local_date: '2026-11-03', visitor_key: 'v:v1', landing_path: '/', exit_path: '/pricing', pageviews: 2, interactions: 1, is_bounce: false, channel: 'organic_search', duration_s: 660 },
      { local_date: '2026-11-03', visitor_key: 'v:v1', landing_path: '/blog', exit_path: '/blog', pageviews: 1, interactions: 0, is_bounce: true, channel: 'direct', duration_s: 0 },
      { local_date: '2026-11-03', visitor_key: 'v:v2', landing_path: '/', exit_path: '/', pageviews: 1, interactions: 0, is_bounce: true, channel: 'email', duration_s: 0 },
      { local_date: '2026-11-04', visitor_key: 'v:v2', landing_path: '/pricing', exit_path: '/pricing', pageviews: 1, interactions: 0, is_bounce: true, channel: 'direct', duration_s: 0 },
      { local_date: '2026-11-04', visitor_key: 'v:v1', landing_path: '/', exit_path: '/', pageviews: 1, interactions: 0, is_bounce: true, channel: 'ai_assistant', duration_s: 0 },
      { local_date: '2026-11-04', visitor_key: 'e:c1', landing_path: '/blog', exit_path: '/blog', pageviews: 1, interactions: 1, is_bounce: false, channel: 'social', duration_s: 60 },
      { local_date: '2026-11-04', visitor_key: 'e:c2', landing_path: '/', exit_path: '/', pageviews: 1, interactions: 0, is_bounce: true, channel: 'paid', duration_s: 0 },
    ]);
  });

  it('overview: KPIs, timeseries and previous period', async () => {
    const res = await get('/v1/analytics/overview', { ...range(), compare: 'previous' }).expect(200);
    expect(res.body.range).toEqual({ from: '2026-11-03', to: '2026-11-04', timezone: 'America/New_York' });
    expect(res.body.metrics).toEqual({
      visitors: 4, // v1, v2 + two cookieless sessions (estimated)
      estimated_visitors: 2,
      sessions: 7,
      pageviews: 8,
      events: 10,
      bounces: 5,
      bounce_rate: 0.7143, // 5/7
      avg_session_duration_s: 102.9, // 720/7
      pages_per_session: 1.14, // 8/7
    });
    expect(res.body.timeseries).toEqual([
      { date: '2026-11-03', visitors: 2, sessions: 3, pageviews: 4, bounce_rate: 0.6667 },
      { date: '2026-11-04', visitors: 4, sessions: 4, pageviews: 4, bounce_rate: 0.75 },
    ]);
    expect(res.body.previous.range).toMatchObject({ from: '2026-11-01', to: '2026-11-02' });
    expect(res.body.previous.metrics).toMatchObject({ sessions: 0, visitors: 0, bounce_rate: 0 });
    expect(res.body.previous.timeseries).toHaveLength(2);
    expect(res.body.definitions.bounce).toMatch(/exactly one page view/);
  });

  it('a single local day is bounded in the site timezone (e5 at 04:50 UTC belongs to Nov 3)', async () => {
    const res = await get('/v1/analytics/overview', { site_id: siteId, from: '2026-11-03', to: '2026-11-03' }).expect(200);
    expect(res.body.metrics).toMatchObject({ sessions: 3, pageviews: 4, events: 5, visitors: 2, bounces: 2 });
    expect(res.body.previous).toBeNull();
  });

  it('pages: top, landing and exit pages', async () => {
    const res = await get('/v1/analytics/pages', range()).expect(200);
    expect(res.body.top_pages).toEqual([
      { page_path: '/', pageviews: 4, entrances: 4, exits: 3 },
      { page_path: '/blog', pageviews: 2, entrances: 2, exits: 2 },
      { page_path: '/pricing', pageviews: 2, entrances: 1, exits: 2 },
    ]);
    expect(res.body.landing_pages).toEqual([
      { page_path: '/', sessions: 4, bounce_rate: 0.75, avg_session_duration_s: 165 },
      { page_path: '/blog', sessions: 2, bounce_rate: 0.5, avg_session_duration_s: 30 },
      { page_path: '/pricing', sessions: 1, bounce_rate: 1, avg_session_duration_s: 0 },
    ]);
    expect(res.body.exit_pages.map((r: { page_path: string; sessions: number }) => [r.page_path, r.sessions])).toEqual([
      ['/', 3], ['/blog', 2], ['/pricing', 2],
    ]);
  });

  it('sources: channels, referrers and campaigns', async () => {
    const res = await get('/v1/analytics/sources', range()).expect(200);
    expect(res.body.channels).toEqual([
      { channel: 'direct', sessions: 2, visitors: 2, bounce_rate: 1, pageviews: 2 },
      { channel: 'ai_assistant', sessions: 1, visitors: 1, bounce_rate: 1, pageviews: 1 },
      { channel: 'email', sessions: 1, visitors: 1, bounce_rate: 1, pageviews: 1 },
      { channel: 'organic_search', sessions: 1, visitors: 1, bounce_rate: 0, pageviews: 2 },
      { channel: 'paid', sessions: 1, visitors: 1, bounce_rate: 1, pageviews: 1 },
      { channel: 'social', sessions: 1, visitors: 1, bounce_rate: 0, pageviews: 1 },
    ]);
    expect(res.body.referrers).toEqual([
      { referrer_host: 'chatgpt.com', channel: 'ai_assistant', sessions: 1, bounce_rate: 1 },
      { referrer_host: 'google.com', channel: 'organic_search', sessions: 1, bounce_rate: 0 },
      { referrer_host: 'google.com', channel: 'paid', sessions: 1, bounce_rate: 1 },
      { referrer_host: 't.co', channel: 'social', sessions: 1, bounce_rate: 0 },
    ]);
    expect(res.body.campaigns).toEqual([
      { source: 'google', medium: 'cpc', campaign: 'brand', sessions: 1, bounce_rate: 1 },
      { source: 'newsletter', medium: 'email', campaign: 'nov', sessions: 1, bounce_rate: 1 },
    ]);
  });

  it('events: breakdown and property values', async () => {
    const res = await get('/v1/analytics/events', { ...range(), event_name: 'signup_click' }).expect(200);
    expect(res.body.events).toEqual([
      { event_name: 'page_view', count: 8, share: 0.8 },
      { event_name: 'outbound_click', count: 1, share: 0.1 },
      { event_name: 'signup_click', count: 1, share: 0.1 },
    ]);
    expect(res.body.properties).toEqual([{ key: 'plan', value: 'pro', count: 1 }]);
  });

  it('devices', async () => {
    const res = await get('/v1/analytics/devices', range()).expect(200);
    expect(res.body.devices).toEqual([
      { device_category: 'desktop', sessions: 4, visitors: 2, bounce_rate: 0.75, share: 0.5714 },
      { device_category: 'mobile', sessions: 2, visitors: 1, bounce_rate: 1, share: 0.2857 },
      { device_category: 'tablet', sessions: 1, visitors: 1, bounce_rate: 0, share: 0.1429 },
    ]);
  });

  it('CSV exports match the reports', async () => {
    const pages = await get('/v1/analytics/export.csv', { ...range(), report: 'pages' }).expect(200);
    expect(pages.headers['content-type']).toContain('text/csv');
    expect(pages.headers['content-disposition']).toContain('growthos-pages-2026-11-03_2026-11-04.csv');
    expect(pages.text).toBe(
      'page_path,pageviews,entrances,exits,landing_bounce_rate\r\n/,4,4,3,0.75\r\n/blog,2,2,2,0.5\r\n/pricing,2,1,2,1\r\n',
    );
    const events = await get('/v1/analytics/export.csv', { ...range(), report: 'events' }).expect(200);
    expect(events.text.split('\r\n')[1]).toBe('page_view,8,0.8');
    const sources = await get('/v1/analytics/export.csv', { ...range(), report: 'sources' }).expect(200);
    expect(sources.text.split('\r\n')).toHaveLength(8); // header + 6 rows (S2 and S4 share the direct row) + trailing newline
    await get('/v1/analytics/export.csv', { ...range(), report: 'nope' }).expect(400);
  });

  it('re-processing the same days changes nothing (idempotent rollups)', async () => {
    const before = (await get('/v1/analytics/overview', range())).body.metrics;
    await t.ds.query(`INSERT INTO dirty_site_days (site_id, local_date) VALUES ($1, '2026-11-03'), ($1, '2026-11-04')`, [siteId]);
    await t.ds.query(`INSERT INTO dirty_visitor_days (site_id, visitor_key, local_date) SELECT DISTINCT site_id, visitor_key, local_date FROM events WHERE site_id = $1`, [siteId]);
    await processPending(t.ds);
    expect((await get('/v1/analytics/overview', range())).body.metrics).toEqual(before);
  });

  it('validates ranges and scopes sites to the tenant', async () => {
    await get('/v1/analytics/overview', { site_id: siteId, from: '2025-01-01', to: '2026-03-01' }).expect(400);
    await get('/v1/analytics/overview', { site_id: siteId, from: '2026-11-04', to: '2026-11-03' }).expect(400);
    await get('/v1/analytics/overview', { site_id: 'nope', from: '2026-11-03', to: '2026-11-04' }).expect(400);
    await request(t.app.getHttpServer()).get('/v1/analytics/overview').query(range()).expect(401);
    // a site owned by another organisation is invisible to the dev org
    const [org] = await t.ds.query(`INSERT INTO organizations (name, slug) VALUES ('Other', 'other') RETURNING id`);
    const [other] = await t.ds.query(
      `INSERT INTO sites (organization_id, name, domain, public_id) VALUES ($1, 'Other', 'other.com', 'gos_other') RETURNING id`,
      [org.id],
    );
    await get('/v1/analytics/overview', { site_id: other.id, from: '2026-11-03', to: '2026-11-04' }).expect(404);
    await request(t.app.getHttpServer()).get(`/v1/sites/${other.id}`).set('X-Dev-Key', t.devKey).expect(404);
  });

  it('realtime reads raw events of the last minutes', async () => {
    const now = Date.now();
    await insertEvents(t.ds, { id: siteId, organization_id: (await t.ds.query(`SELECT organization_id FROM sites WHERE id = $1`, [siteId]))[0].organization_id, timezone: 'America/New_York' }, [
      T(100, new Date(now - 60_000).toISOString(), { ...c1, ephemeral_id: 'rt1', page_path: '/live' }),
      T(101, new Date(now - 30_000).toISOString(), { ...v1, page_path: '/live' }),
      T(102, new Date(now - 20 * 60_000).toISOString(), { ...v2, page_path: '/old' }),
    ]);
    const res = await get('/v1/analytics/realtime', { site_id: siteId }).expect(200);
    expect(res.body).toMatchObject({
      active_visitors: 2,
      window_minutes: 5,
      pageviews_last_window: 2,
      top_active_pages: [{ page_path: '/live', visitors: 2 }],
    });
    expect(res.body.latest_events.length).toBeGreaterThanOrEqual(3);
    expect(res.body.last_event_received_at).toEqual(expect.any(String));
  });
});
