import request from 'supertest';
import { processPending } from '@growthos/db';
import { CHROME_UA, event, setupTestApp, type TestContext } from './helpers';

describe('Ingestion + sites (e2e)', () => {
  let t: TestContext;
  let site: { id: string; public_id: string; organization_id: string };
  const api = () => request(t.app.getHttpServer());
  const post = (body: unknown, ua = CHROME_UA, ip = '203.0.113.10') =>
    api().post('/v1/events/batch').set('User-Agent', ua).set('X-Forwarded-For', ip).send(body as object);

  beforeAll(async () => {
    t = await setupTestApp();
    const res = await api()
      .post('/v1/sites')
      .set('X-Dev-Key', t.devKey)
      .send({ name: 'Shop', domain: 'https://www.shop.example.com', timezone: 'Europe/Berlin' })
      .expect(201);
    site = res.body;
  });
  afterAll(() => t.close());

  describe('dev key + sites', () => {
    it('rejects read APIs without X-Dev-Key', async () => {
      await api().get('/v1/sites').expect(401);
      await api().get('/v1/sites').set('X-Dev-Key', 'wrong-key-wrong-key-xx').expect(401);
    });

    it('creates sites under the dev org with an install snippet', async () => {
      const res = await api().get(`/v1/sites/${site.id}`).set('X-Dev-Key', t.devKey).expect(200);
      expect(res.body).toMatchObject({ domain: 'shop.example.com', timezone: 'Europe/Berlin', status: 'active' });
      expect(res.body.install.script_tag).toBe(
        `<script src="https://api.test/sdk.js" data-site-id="${site.public_id}" async></script>`,
      );
      const [org] = await t.ds.query(`SELECT slug FROM organizations WHERE id = $1`, [res.body.organization_id]);
      expect(org.slug).toBe('dev');
      const list = await api().get('/v1/sites').set('X-Dev-Key', t.devKey).expect(200);
      expect(list.body.map((s: { id: string }) => s.id)).toContain(site.id);
    });

    it('validates site input', async () => {
      const res = await api().post('/v1/sites').set('X-Dev-Key', t.devKey).send({ name: '', domain: 'x' }).expect(400);
      expect(res.body.error).toBe('validation_failed');
      await api().get('/v1/sites/not-a-uuid').set('X-Dev-Key', t.devKey).expect(400);
      await api().get('/v1/sites/00000000-0000-4000-8000-000000000000').set('X-Dev-Key', t.devKey).expect(404);
    });

    it('serves health without a key', async () => {
      const res = await api().get('/health').expect(200);
      expect(res.body).toMatchObject({ status: 'ok', db: 'ok', redis: 'ok' });
    });
  });

  describe('POST /v1/events/batch', () => {
    it('accepts a valid batch, normalises and attaches org + site server-side', async () => {
      const a = event({ visitor_id: 'should-be-dropped', referrer: 'https://www.google.com/search?q=private' });
      const b = event({ event_name: 'signup_click', properties: { plan: 'pro', seats: 3, trial: true } });
      const res = await post({ site_id: site.public_id, schema_version: 1, events: [a, b] }).expect(202);
      expect(res.body).toEqual({ accepted: 2, duplicates: 0, rejected: [], dropped_bots: 0 });
      expect(res.headers['access-control-allow-origin']).toBeUndefined(); // no Origin sent
      const [row] = await t.ds.query(`SELECT * FROM events WHERE event_id = $1`, [a.event_id]);
      expect(row).toMatchObject({
        organization_id: site.organization_id,
        site_id: site.id,
        page_url: 'https://shop.example.com/products/1?utm_source=nl',
        page_path: '/products/1',
        utm_source: 'nl',
        referrer: 'https://www.google.com/search',
        referrer_host: 'google.com',
        visitor_id: null,
        visitor_key: 'e:eph-1',
        device_category: 'desktop',
      });
      expect(row.received_at).toBeInstanceOf(Date);
    });

    it('answers CORS preflight for any origin', async () => {
      const res = await api()
        .options('/v1/events/batch')
        .set('Origin', 'https://any-customer-site.com')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type');
      expect(res.status).toBeLessThan(300);
      expect(res.headers['access-control-allow-origin']).toBe('https://any-customer-site.com');
    });

    it('accepts sendBeacon text/plain bodies', async () => {
      const res = await api()
        .post('/v1/events/batch')
        .set('User-Agent', CHROME_UA)
        .set('Content-Type', 'text/plain;charset=UTF-8')
        .send(JSON.stringify({ site_id: site.public_id, schema_version: 1, events: [event()] }))
        .expect(202);
      expect(res.body.accepted).toBe(1);
    });

    it('rejects invalid envelopes with a useful error', async () => {
      const bad = await post({ site_id: site.public_id, schema_version: 1, events: [] }).expect(400);
      expect(bad.body).toMatchObject({ error: 'invalid_batch' });
      expect(bad.body.message).toContain('events');
      await post({ site_id: site.public_id, schema_version: 9, events: [event()] }).expect(400);
      await post({ site_id: site.public_id, schema_version: 1, events: Array.from({ length: 51 }, () => event()) }).expect(400);
      await api().post('/v1/events/batch').set('Content-Type', 'application/json').send('{oops').expect(400);
    });

    it('rejects individual bad events and keeps the good ones', async () => {
      const good = event();
      const badName = event({ event_name: 'has spaces' });
      const old = event({ event_time: new Date(Date.now() - 8 * 86_400_000).toISOString() });
      const future = event({ event_time: new Date(Date.now() + 3_600_000).toISOString() });
      const res = await post({ site_id: site.public_id, schema_version: 1, events: [good, badName, old, future, { nope: 1 }] }).expect(202);
      expect(res.body.accepted).toBe(1);
      expect(res.body.rejected).toEqual([
        expect.objectContaining({ index: 1, event_id: badName.event_id, reason: 'invalid_schema' }),
        expect.objectContaining({ index: 2, event_id: old.event_id, reason: 'event_time_out_of_range' }),
        expect.objectContaining({ index: 3, event_id: future.event_id, reason: 'event_time_out_of_range' }),
        expect.objectContaining({ index: 4, event_id: null, reason: 'invalid_schema' }),
      ]);
      expect(res.body.rejected[0].detail).toContain('event_name');
    });

    it('never counts duplicates twice', async () => {
      const evs = [event({ ephemeral_id: 'dup' }), event({ ephemeral_id: 'dup', page_path: '/b' })];
      const batch = { site_id: site.public_id, schema_version: 1, events: evs };
      expect((await post(batch).expect(202)).body).toMatchObject({ accepted: 2, duplicates: 0 });
      expect((await post(batch).expect(202)).body).toMatchObject({ accepted: 0, duplicates: 2 });
      const inBatch = await post({ ...batch, events: [evs[0], evs[0]] }).expect(202);
      expect(inBatch.body).toMatchObject({ accepted: 0, duplicates: 2 });

      await processPending(t.ds);
      const [{ n }] = await t.ds.query(`SELECT count(*)::int n FROM events WHERE site_id = $1 AND visitor_key = 'e:dup'`, [site.id]);
      expect(n).toBe(2);
      const [s] = await t.ds.query(`SELECT pageviews FROM sessions WHERE site_id = $1 AND visitor_key = 'e:dup'`, [site.id]);
      expect(s.pageviews).toBe(2);
    });

    it('rejects unknown and inactive sites', async () => {
      const unknown = await post({ site_id: 'gos_doesnotexist', schema_version: 1, events: [event()] }).expect(404);
      expect(unknown.body.error).toBe('unknown_site');
      const other = await api().post('/v1/sites').set('X-Dev-Key', t.devKey).send({ name: 'Off', domain: 'off.example.com' }).expect(201);
      await api().patch(`/v1/sites/${other.body.id}`).set('X-Dev-Key', t.devKey).send({ status: 'inactive' }).expect(200);
      const res = await post({ site_id: other.body.public_id, schema_version: 1, events: [event()] }).expect(403);
      expect(res.body.error).toBe('site_inactive');
    });

    it('rotating the public id retires the old one', async () => {
      const other = await api().post('/v1/sites').set('X-Dev-Key', t.devKey).send({ name: 'Rot', domain: 'rot.example.com' }).expect(201);
      const rotated = await api().post(`/v1/sites/${other.body.id}/rotate-public-id`).set('X-Dev-Key', t.devKey).expect(201);
      expect(rotated.body.public_id).not.toBe(other.body.public_id);
      await post({ site_id: other.body.public_id, schema_version: 1, events: [event()] }).expect(404);
      await post({ site_id: rotated.body.public_id, schema_version: 1, events: [event()] }).expect(202);
    });

    it('drops and counts bots without storing them', async () => {
      const before = await t.ds.query(`SELECT count(*)::int n FROM events`);
      const bot = await post({ site_id: site.public_id, schema_version: 1, events: [event(), event()] }, 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)').expect(202);
      expect(bot.body).toEqual({ accepted: 0, duplicates: 0, rejected: [], dropped_bots: 2 });
      const headless = await post({ site_id: site.public_id, schema_version: 1, events: [event()] }, 'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0.0.0 Safari/537.36').expect(202);
      expect(headless.body.dropped_bots).toBe(1);
      const flagged = await post({ site_id: site.public_id, schema_version: 1, automation: true, events: [event()] }).expect(202);
      expect(flagged.body.dropped_bots).toBe(1);
      const after = await t.ds.query(`SELECT count(*)::int n FROM events`);
      expect(after[0].n).toBe(before[0].n);
      const drops = await t.ds.query(`SELECT reason, count FROM bot_drops WHERE site_id = $1 ORDER BY reason`, [site.id]);
      expect(drops).toEqual([
        { reason: 'automation_flag', count: 1 },
        { reason: 'bot_user_agent', count: 3 },
      ]);
    });

    it('enforces the 64 KB payload limit', async () => {
      const big = event({ page_title: 'x'.repeat(500) });
      const res = await post({ site_id: site.public_id, schema_version: 1, events: Array.from({ length: 50 }, () => ({ ...big, properties: { a: 'y'.repeat(500), b: 'z'.repeat(500) } })) });
      expect(res.status).toBe(413);
      expect(res.body.error).toBe('payload_too_large');
    });

    it('exposes ingestion metrics behind the dev key', async () => {
      await api().get('/metrics').expect(401);
      const res = await api().get('/metrics').set('X-Dev-Key', t.devKey).expect(200);
      expect(res.text).toContain('growthos_ingest_events_total{result="accepted"}');
      expect(res.text).toContain('growthos_ingest_latency_ms_count');
      expect(res.text).toContain('growthos_backlog{kind="visitor_days"}');
    });
  });
});

describe('Rate limiting (e2e)', () => {
  let t: TestContext;
  const api = () => request(t.app.getHttpServer());

  beforeAll(async () => {
    t = await setupTestApp({ rateLimitIpPerMin: 3, rateLimitSitePerMin: 5 });
  });
  afterAll(() => t.close());

  it('limits per IP and per site', async () => {
    const created = await api().post('/v1/sites').set('X-Dev-Key', t.devKey).send({ name: 'RL', domain: 'rl.example.com' }).expect(201);
    const send = (ip: string) =>
      api().post('/v1/events/batch').set('User-Agent', CHROME_UA).set('X-Forwarded-For', ip)
        .send({ site_id: created.body.public_id, schema_version: 1, events: [event()] });

    for (let i = 0; i < 3; i++) await send('198.51.100.1').expect(202);
    const limited = await send('198.51.100.1').expect(429);
    expect(limited.body).toMatchObject({ error: 'rate_limited', scope: 'ip' });

    // a different IP still gets through until the per-site budget (5) is used up
    await send('198.51.100.2').expect(202);
    await send('198.51.100.3').expect(202);
    const siteLimited = await send('198.51.100.4').expect(429);
    expect(siteLimited.body.scope).toBe('site');
  });
});
