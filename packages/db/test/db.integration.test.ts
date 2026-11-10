import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { insertEvents, processPending, seedDemoSite, freshTestDataSource, type NormalizedEvent } from '../src';

let ds: DataSource;
let site: { id: string; organization_id: string; timezone: string };

const ev = (id: number, time: string, over: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  event_id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, event_name: 'page_view', event_time: time,
  visitor_id: 'vis1', session_id: 'ses1', ephemeral_id: 'eph1', page_url: null, page_path: '/', page_title: null,
  referrer: null, referrer_host: null, utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null,
  utm_content: null, device_category: 'desktop', consent_state: 'granted', schema_version: 1, sdk_version: 't',
  properties: {}, ...over,
});

beforeAll(async () => {
  ds = await freshTestDataSource();
  site = await seedDemoSite(ds, 'America/New_York');
});
afterAll(async () => ds?.destroy());

describe('storage', () => {
  it('deduplicates on (site_id, event_id, event_time)', async () => {
    const batch = [ev(1, '2026-11-10T15:00:00Z'), ev(2, '2026-11-10T15:01:00Z')];
    expect(await insertEvents(ds, site, batch)).toBe(2);
    expect(await insertEvents(ds, site, batch)).toBe(0);
    const [{ n }] = await ds.query(`SELECT count(*)::int n FROM events`);
    expect(n).toBe(2);
  });

  it('computes local_date in the site timezone and drops ids without consent', async () => {
    await insertEvents(ds, site, [ev(3, '2026-11-11T03:00:00Z', { consent_state: 'pending', visitor_id: 'leak', session_id: 'leak' })]);
    const [row] = await ds.query(`SELECT local_date, visitor_id, session_id, visitor_key FROM events WHERE event_id = $1`, [ev(3, '').event_id]);
    expect(row).toEqual({ local_date: '2026-11-10', visitor_id: null, session_id: null, visitor_key: 'e:eph1' });
  });

  it('moves default-partition rows when a month partition is created late', async () => {
    await insertEvents(ds, site, [ev(4, '2031-05-05T00:00:00Z')]);
    const [{ p }] = await ds.query(`SELECT growthos_ensure_events_partition('2031-05-01') p`);
    expect(p).toBe('events_y2031m05');
    const [{ n }] = await ds.query(`SELECT count(*)::int n FROM events_y2031m05`);
    expect(n).toBe(1);
  });

  it('processing is idempotent', async () => {
    await processPending(ds);
    const snap = async () => ({
      s: await ds.query(`SELECT * FROM sessions ORDER BY session_id`),
      a: await ds.query(`SELECT site_id, date, visitors, sessions, pageviews, events, bounces FROM agg_daily_site ORDER BY date`),
    });
    const first = await snap();
    // e3 (cookieless, ephemeral eph1) was stitched to vis1 when a later consented event with eph1 arrived:
    // 2 sessions (10:00 and 22:00 local, > 30 min apart) but one visitor.
    expect(first.a.find((r: { date: string }) => r.date === '2026-11-10')).toMatchObject({ pageviews: 3, sessions: 2, visitors: 1 });
    await ds.query(`INSERT INTO dirty_visitor_days (site_id, visitor_key, local_date) SELECT DISTINCT site_id, visitor_key, local_date FROM events`);
    await processPending(ds);
    expect(await snap()).toEqual(first);
  });

  it('stitches a visit when consent is granted part-way through the page', async () => {
    const cookieless = ev(20, '2026-11-12T15:00:00Z', { consent_state: 'pending', visitor_id: null, session_id: null, ephemeral_id: 'tab-9' });
    await insertEvents(ds, site, [cookieless]);
    await insertEvents(ds, site, [
      ev(21, '2026-11-12T15:00:20Z', { event_name: 'cta', consent_state: 'granted', visitor_id: 'vis-9', ephemeral_id: 'tab-9' }),
    ]);
    await processPending(ds);
    const keys = await ds.query(`SELECT DISTINCT visitor_key FROM events WHERE ephemeral_id = 'tab-9'`);
    expect(keys).toEqual([{ visitor_key: 'v:vis-9' }]);
    const sessions = await ds.query(
      `SELECT visitor_key, pageviews, interactions, is_bounce FROM sessions WHERE local_date = '2026-11-12'`,
    );
    expect(sessions).toEqual([{ visitor_key: 'v:vis-9', pageviews: 1, interactions: 1, is_bounce: false }]);
  });
});
