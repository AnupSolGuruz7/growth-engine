import { createHash } from 'node:crypto';
import { createDataSource } from '../datasource';
import { loadEnv } from '../env';
import { deleteSiteData, ensurePartitions, insertEvents, type NormalizedEvent } from '../events';
import { processPending } from '../processing';
import { seedDemoSite } from '../seed';

/**
 * Seeds ~4 weeks of synthetic traffic for the demo site so the dashboard has something to show
 * (and the Playwright smoke test has deterministic-ish data). Wipes the demo site's data first.
 * Usage: pnpm db:seed-demo [days=28]
 */

// mulberry32 — small deterministic PRNG
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const uuidFrom = (s: string) => {
  const h = createHash('sha256').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const PAGES = ['/', '/pricing', '/features', '/blog', '/blog/launch-week', '/blog/seo-basics', '/about', '/contact', '/app', '/app/settings'];
const SOURCES: { w: number; referrer?: string; utm?: [string, string, string] }[] = [
  { w: 30 },
  { w: 25, referrer: 'https://www.google.com/' },
  { w: 5, referrer: 'https://www.bing.com/' },
  { w: 8, referrer: 'https://t.co/' },
  { w: 6, referrer: 'https://www.linkedin.com/' },
  { w: 6, referrer: 'https://news.ycombinator.com/' },
  { w: 5, referrer: 'https://chatgpt.com/' },
  { w: 5, referrer: 'https://partner-blog.example.org/post' },
  { w: 6, utm: ['google', 'cpc', 'brand_search'] },
  { w: 4, utm: ['newsletter', 'email', 'november_digest'] },
];
const DEVICES: [string, number][] = [['desktop', 58], ['mobile', 36], ['tablet', 6]];

function pick<T>(r: () => number, items: { w: number; v: T }[]): T {
  const total = items.reduce((s, i) => s + i.w, 0);
  let x = r() * total;
  for (const i of items) if ((x -= i.w) <= 0) return i.v;
  return items[items.length - 1]!.v;
}

async function main() {
  loadEnv();
  const days = Number(process.argv[2] ?? 28);
  const ds = await createDataSource().initialize();
  const site = await seedDemoSite(ds);
  await deleteSiteData(ds, site.id, { analyticsOnly: true }); // keep SEO audits and AI history
  await ensurePartitions(ds, Math.ceil(days / 28) + 1, 2);

  const r = rng(42);
  const now = Date.now();
  const events: NormalizedEvent[] = [];
  const returning: string[] = [];

  const base = (over: Partial<NormalizedEvent>): NormalizedEvent => ({
    event_id: '', event_name: 'page_view', event_time: '', visitor_id: null, session_id: null,
    ephemeral_id: null, page_url: null, page_path: '/', page_title: null, referrer: null,
    referrer_host: null, utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null,
    utm_content: null, device_category: 'desktop', consent_state: 'pending', schema_version: 1,
    sdk_version: 'seed', properties: {}, ...over,
  });

  for (let d = days - 1; d >= 0; d--) {
    const dayStart = now - d * 86_400_000;
    const weekday = new Date(dayStart).getUTCDay();
    const visits = Math.round((weekday === 0 || weekday === 6 ? 35 : 60) * (0.8 + r() * 0.4) * (1 + (days - d) / days / 2));
    for (let v = 0; v < visits; v++) {
      const granted = r() < 0.6;
      let visitorId: string | null = null;
      if (granted) {
        visitorId = returning.length && r() < 0.3 ? returning[Math.floor(r() * returning.length)]! : `vis_${d}_${v}`;
        if (!returning.includes(visitorId)) returning.push(visitorId);
      }
      const eph = `eph_${d}_${v}`;
      const src = pick(r, SOURCES.map((s) => ({ w: s.w, v: s })));
      const device = pick(r, DEVICES.map(([v, w]) => ({ w, v })));
      // spread the visit over the elapsed part of "today", the whole day otherwise
      const span = d === 0 ? Math.max(60_000, now - Math.floor(now / 86_400_000) * 86_400_000 - 600_000) : 86_400_000 - 3_600_000;
      let t = Math.floor((d === 0 ? Math.floor(now / 86_400_000) * 86_400_000 : dayStart - (dayStart % 86_400_000)) + r() * span);
      const pagesInVisit = r() < 0.42 ? 1 : 2 + Math.floor(r() * 4);
      let path = r() < 0.5 ? '/' : PAGES[Math.floor(r() * PAGES.length)]!;
      for (let p = 0; p < pagesInVisit; p++) {
        const first = p === 0;
        events.push(
          base({
            event_id: uuidFrom(`${d}:${v}:${p}`),
            event_time: new Date(t).toISOString(),
            visitor_id: visitorId,
            session_id: granted ? `ses_${d}_${v}` : null,
            ephemeral_id: eph,
            page_path: path,
            page_url: `http://localhost:5174${path}`,
            consent_state: granted ? 'granted' : 'pending',
            device_category: device,
            referrer: first && src.referrer ? src.referrer : null,
            referrer_host: first && src.referrer ? new URL(src.referrer).hostname.replace(/^www\./, '') : null,
            utm_source: first ? src.utm?.[0] ?? null : null,
            utm_medium: first ? src.utm?.[1] ?? null : null,
            utm_campaign: first ? src.utm?.[2] ?? null : null,
          }),
        );
        if (path === '/pricing' && r() < 0.3) {
          events.push(base({ event_id: uuidFrom(`${d}:${v}:${p}:signup`), event_name: 'signup_click', event_time: new Date(t + 15_000).toISOString(), visitor_id: visitorId, ephemeral_id: eph, page_path: path, consent_state: granted ? 'granted' : 'pending', device_category: device, properties: { plan: r() < 0.5 ? 'pro' : 'starter' } }));
        }
        if (path === '/contact' && r() < 0.4) {
          events.push(base({ event_id: uuidFrom(`${d}:${v}:${p}:enq`), event_name: 'enquiry_submitted', event_time: new Date(t + 40_000).toISOString(), visitor_id: visitorId, ephemeral_id: eph, page_path: path, consent_state: granted ? 'granted' : 'pending', device_category: device, properties: { form: 'contact' } }));
        }
        if (r() < 0.06) {
          events.push(base({ event_id: uuidFrom(`${d}:${v}:${p}:out`), event_name: 'outbound_click', event_time: new Date(t + 20_000).toISOString(), visitor_id: visitorId, ephemeral_id: eph, page_path: path, consent_state: granted ? 'granted' : 'pending', device_category: device, properties: { host: 'apps.apple.com', path: '/app/growthos' } }));
        }
        t += 20_000 + Math.floor(r() * 180_000);
        path = PAGES[Math.floor(r() * PAGES.length)]!;
      }
    }
  }
  // A few events in the last minutes so Realtime is not empty.
  for (let i = 0; i < 6; i++) {
    events.push(base({ event_id: uuidFrom(`rt:${now}:${i}`), event_time: new Date(now - i * 40_000).toISOString(), ephemeral_id: `rt_${i % 3}`, page_path: PAGES[i % PAGES.length]! }));
  }

  let inserted = 0;
  for (let i = 0; i < events.length; i += 500) inserted += await insertEvents(ds, site, events.slice(i, i + 500));
  const res = await processPending(ds, { sessionTimeoutMin: Number(process.env.SESSION_TIMEOUT_MIN ?? 30) });
  console.log(`Demo site ${site.id}: inserted ${inserted} events over ${days} days; ${res.sessionized} visitor-days sessionized, ${res.rolledUp} site-days rolled up.`);
  await ds.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
