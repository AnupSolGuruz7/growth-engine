import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EXPECTED_FINDINGS, auditScore, crawlSite, isPrivateAddress, parsePageSpeed, runChecks, scoreFindings,
  startFixtureSite, type CrawlResult, type Finding,
} from '../src';

let site: Awaited<ReturnType<typeof startFixtureSite>>;
let crawl: CrawlResult;
let findings: Finding[];
const path = (u: string) => new URL(u).pathname;

beforeAll(async () => {
  site = await startFixtureSite();
  crawl = await crawlSite({ startUrl: site.url + '/', allowPrivate: true, delayMs: 0, concurrency: 2 });
  findings = runChecks(crawl);
});
afterAll(() => site?.close());

describe('crawler', () => {
  it('reads robots.txt and the sitemap', () => {
    expect(crawl.robots).toMatchObject({ found: true, disallowsAll: false });
    expect(crawl.sitemap).toMatchObject({ found: true, valid: true });
    expect(crawl.sitemap.urls).toHaveLength(7);
  });

  it('respects robots.txt: disallowed URLs are never requested', () => {
    expect(site.requests.some((r) => r.includes('/private'))).toBe(false);
    expect(crawl.pages.find((p) => path(p.url) === '/private/area')?.blockedByRobots).toBe(true);
  });

  it('stays on the host, uses GET only and records redirect chains', () => {
    expect(site.requests.every((r) => r.startsWith('GET '))).toBe(true);
    expect(crawl.pages.every((p) => new URL(p.url).hostname === '127.0.0.1')).toBe(true);
    const old = crawl.pages.find((p) => path(p.url) === '/old-pricing')!;
    expect(old.redirectChain.map((h) => h.status)).toEqual([301, 301, 301, 200]);
    expect(path(old.finalUrl!)).toBe('/pricing');
  });

  it('counts inlinks and finds orphans', () => {
    expect(crawl.pages.find((p) => path(p.url) === '/pricing')!.inlinks).toBeGreaterThanOrEqual(5);
    expect(crawl.pages.find((p) => path(p.url) === '/orphan')!.inlinks).toBe(0);
  });

  it('respects the page limit', async () => {
    const small = await crawlSite({ startUrl: site.url + '/', allowPrivate: true, delayMs: 0, maxPages: 3 });
    expect(small.pages).toHaveLength(3);
    expect(small.limitReached).toBe(true);
  });

  it('refuses private addresses unless explicitly allowed (SSRF guard)', async () => {
    const blocked = await crawlSite({ startUrl: site.url + '/', allowPrivate: false, delayMs: 0 });
    expect(blocked.pages[0]!.fetchError).toBe('blocked_private_address');
    const viaName = await crawlSite({ startUrl: site.url.replace('127.0.0.1', 'localhost') + '/', allowPrivate: false, delayMs: 0 });
    expect(viaName.pages[0]!.fetchError).toBe('blocked_private_address');
    expect(['10.0.0.1', '172.20.1.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1'].every(isPrivateAddress)).toBe(true);
    expect(['8.8.8.8', '1.1.1.1', '2606:4700::1111'].some(isPrivateAddress)).toBe(false);
  });
});

describe('checks', () => {
  it('reports every planted issue', () => {
    const got = new Set(findings.map((f) => `${f.check_id} ${path(f.url)}`));
    const missing = EXPECTED_FINDINGS.filter(([c, p]) => !got.has(`${c} ${p}`));
    expect(missing).toEqual([]);
  });

  it('does not flag clean things', () => {
    const got = findings.map((f) => `${f.check_id} ${path(f.url)}`);
    expect(got).not.toContain('robots_missing /robots.txt');
    expect(got).not.toContain('sitemap_missing /sitemap.xml');
    expect(got.filter((g) => g.startsWith('title_missing'))).toEqual(['title_missing /about']);
    // decorative alt="" is fine: /blog has 3 images, one missing alt, one alt="", one described
    const blogAlt = findings.find((f) => f.check_id === 'images_missing_alt' && path(f.url) === '/blog')!;
    expect((blogAlt.evidence.images as string[]).map(path)).toEqual(['/a.png']);
    expect(findings.some((f) => f.check_id === 'structured_data_missing')).toBe(false);
    // http on localhost / an IP is development, not a missing-HTTPS problem
    expect(findings.some((f) => f.check_id === 'no_https' || f.check_id === 'http_not_redirected')).toBe(false);
  });

  it('flags client-rendered pages and marks their content checks low-confidence', () => {
    const onApp = findings.filter((f) => path(f.url) === '/app');
    expect(onApp.find((f) => f.check_id === 'js_rendered_content')).toMatchObject({ severity: 'medium' });
    const h1 = onApp.find((f) => f.check_id === 'h1_missing')!;
    expect(h1.confidence).toBeLessThanOrEqual(0.3);
    expect(h1.limits).toMatch(/JavaScript/);
    // ordinary pages are not affected
    expect(findings.filter((f) => f.check_id === 'js_rendered_content').map((f) => path(f.url))).toEqual(['/app']);
    expect(findings.find((f) => f.check_id === 'h1_missing' && path(f.url) === '/about')!.confidence).toBeGreaterThan(0.3);
  });

  it('gives every finding evidence and a concrete fix', () => {
    for (const f of findings) {
      expect(f.explanation.length).toBeGreaterThan(20);
      expect(f.suggested_fix.length).toBeGreaterThan(15);
      expect(f.confidence).toBeGreaterThan(0);
    }
    const dup = findings.find((f) => f.check_id === 'title_duplicate')!;
    expect((dup.evidence.pages as string[]).map(path).sort()).toEqual(['/', '/blog']);
  });

  it('prioritises by severity, confidence and real traffic', () => {
    const scored = scoreFindings(findings, new Map([['/about', 5000], ['/blog', 3]]));
    const aboutTitle = scored.find((f) => f.check_id === 'title_missing')!;
    expect(aboutTitle.pageviews_28d).toBe(5000);
    expect(scored[0]!.priority).toBeGreaterThanOrEqual(scored[scored.length - 1]!.priority);
    // same finding gets the same fingerprint across audits
    expect(scoreFindings(findings, new Map()).map((f) => f.fingerprint)).toEqual(
      expect.arrayContaining(scored.map((f) => f.fingerprint)),
    );
  });

  it('scores 0–100 and drops as issues pile up', () => {
    const s = auditScore(findings);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(100);
    expect(auditScore([])).toBe(100);
  });
});

describe('pagespeed', () => {
  it('prefers field data and flags poor Core Web Vitals', () => {
    const r = parsePageSpeed('https://x.com/', {
      loadingExperience: { metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 4800 }, CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5 }, INTERACTION_TO_NEXT_PAINT: { percentile: 250 } } },
      lighthouseResult: { categories: { performance: { score: 0.42 } }, audits: { 'largest-contentful-paint': { numericValue: 1000 } } },
    });
    expect(r).toEqual({ url: 'https://x.com/', source: 'field', lcpMs: 4800, cls: 0.05, inpMs: 250, performanceScore: 42 });
    const cwv = runChecks({ ...crawl, pages: [] }, [r]).filter((f) => f.check_id.startsWith('cwv_'));
    expect(cwv.map((f) => [f.check_id, f.severity])).toEqual([['cwv_lcp', 'high'], ['cwv_inp', 'medium']]);
  });
});
