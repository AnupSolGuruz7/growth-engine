import robotsParser from 'robots-parser';
import { fetchUrl, type FetchOptions, type Hop } from './fetcher';
import { createCrawlerAgent } from './net';
import { parseHtml, parseSitemap, type ParsedHtml } from './parse';

export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; GrowthOS-SEO-Audit/1.0; +https://github.com/growthos)';
/** Token matched against robots.txt groups. */
export const ROBOTS_TOKEN = 'GrowthOS-SEO-Audit';

export interface CrawlOptions {
  startUrl: string;
  maxPages?: number;
  maxDepth?: number;
  concurrency?: number;
  /** Pause between requests per worker; 2 workers × 650 ms ≈ 1.5 requests/second (spec §7.1). */
  delayMs?: number;
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
  /** Allow crawling localhost / private networks (dev only). */
  allowPrivate?: boolean;
  onProgress?: (pagesCrawled: number) => void | Promise<void>;
}

export interface CrawledPage {
  url: string;
  path: string;
  depth: number;
  status: number | null;
  finalUrl: string | null;
  redirectChain: Hop[];
  responseMs: number | null;
  contentType: string | null;
  bytes: number | null;
  xRobotsTag: string | null;
  fetchError: string | null;
  blockedByRobots: boolean;
  inSitemap: boolean;
  /** Distinct crawled pages linking here (internal links only). */
  inlinks: number;
  linkedFrom: string[];
  html: ParsedHtml | null;
  /** Internal links that use http:// while the site is https. */
  insecureLinks: string[];
}

export interface CrawlResult {
  startUrl: string;
  origin: string;
  host: string;
  pages: CrawledPage[];
  robots: { url: string; found: boolean; status: number | null; sitemaps: string[]; disallowsAll: boolean };
  sitemap: { url: string | null; found: boolean; valid: boolean; urls: string[]; status: number | null };
  /** Whether the www / non-www twin of the start host also answers 200 without redirecting. */
  hostVariant: { url: string; status: number | null; redirectsToCanonical: boolean } | null;
  httpsAvailable: boolean;
  limitReached: boolean;
}

const strip = (h: string) => h.toLowerCase().replace(/^www\./, '');

/** Normalises crawl URLs: no hash, no tracking params, sorted query. */
export function normalizeCrawlUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|msclkid$|mc_)/i.test(k)) u.searchParams.delete(k);
    }
    u.searchParams.sort();
    return u.toString();
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SKIP_EXT = /\.(pdf|zip|gz|rar|7z|exe|dmg|mp4|mp3|wav|avi|mov|jpe?g|png|gif|webp|svg|ico|css|js|woff2?|ttf|xml|json)$/i;

/**
 * Crawls one site: stays on the start host (www and non-www count as the same site), respects
 * robots.txt, reads the sitemap, follows internal links breadth-first. GET only, never submits forms.
 */
export async function crawlSite(opts: CrawlOptions): Promise<CrawlResult> {
  const maxPages = opts.maxPages ?? 500;
  const maxDepth = opts.maxDepth ?? 10;
  const concurrency = opts.concurrency ?? 2;
  const delayMs = opts.delayMs ?? 650;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const allowPrivate = !!opts.allowPrivate;
  const agent = createCrawlerAgent(allowPrivate, timeoutMs);
  const fo: FetchOptions = {
    agent,
    userAgent: opts.userAgent ?? DEFAULT_USER_AGENT,
    timeoutMs,
    maxBytes: opts.maxBytes ?? 5 * 1024 * 1024,
    allowPrivate,
  };

  try {
    const start = new URL(normalizeCrawlUrl(opts.startUrl) ?? opts.startUrl);
    const siteHost = strip(start.hostname);
    const isAllowedHost = (h: string) => strip(h) === siteHost;
    const origin = start.origin;

    // ---- robots.txt
    const robotsUrl = `${origin}/robots.txt`;
    const r = await fetchUrl(robotsUrl, isAllowedHost, fo);
    const robotsFound = r.status === 200 && !!r.body && !/<html/i.test(r.body.slice(0, 500));
    const robots = robotsParser(robotsUrl, robotsFound ? r.body! : '');
    const robotsSitemaps = robots.getSitemaps().filter((s) => {
      try {
        return isAllowedHost(new URL(s).hostname);
      } catch {
        return false;
      }
    });
    const allowed = (u: string) => robots.isAllowed(u, ROBOTS_TOKEN) !== false;

    // ---- sitemap (robots-declared first, else /sitemap.xml); one level of sitemap index
    const sitemapUrl = robotsSitemaps[0] ?? `${origin}/sitemap.xml`;
    const sitemapUrls = new Set<string>();
    let sitemapValid = false;
    const s = await fetchUrl(sitemapUrl, isAllowedHost, fo);
    const sitemapFound = s.status === 200 && !!s.body;
    if (sitemapFound) {
      const parsed = parseSitemap(s.body!);
      sitemapValid = parsed.valid;
      const children = parsed.isIndex ? parsed.locs.slice(0, 10) : [];
      for (const loc of parsed.isIndex ? [] : parsed.locs) sitemapUrls.add(loc);
      for (const child of children) {
        const c = await fetchUrl(child, isAllowedHost, fo);
        if (c.status === 200 && c.body) for (const loc of parseSitemap(c.body).locs) sitemapUrls.add(loc);
      }
    }
    const sitemapSet = new Set([...sitemapUrls].map((u) => normalizeCrawlUrl(u)).filter((u): u is string => !!u));

    // ---- BFS crawl
    const pages = new Map<string, CrawledPage>();
    const queue: { url: string; depth: number }[] = [];
    const seen = new Set<string>();
    const enqueue = (url: string, depth: number) => {
      const n = normalizeCrawlUrl(url);
      if (!n || seen.has(n) || depth > maxDepth) return;
      const u = new URL(n);
      if (!isAllowedHost(u.hostname) || SKIP_EXT.test(u.pathname)) return;
      seen.add(n);
      queue.push({ url: n, depth });
    };
    enqueue(start.toString(), 0);
    for (const u of sitemapSet) enqueue(u, 1);

    const links = new Map<string, Set<string>>(); // target -> sources
    let limitReached = false;
    let crawled = 0;

    const blank = (url: string, depth: number): CrawledPage => ({
      url, path: new URL(url).pathname, depth, status: null, finalUrl: null, redirectChain: [], responseMs: null,
      contentType: null, bytes: null, xRobotsTag: null, fetchError: null, blockedByRobots: false,
      inSitemap: sitemapSet.has(url), inlinks: 0, linkedFrom: [], html: null, insecureLinks: [],
    });

    let inFlight = 0;
    const work = async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) {
          // another worker may still add links from the page it is fetching
          if (inFlight === 0) return;
          await sleep(10);
          continue;
        }
        if (crawled >= maxPages) {
          limitReached = true;
          return;
        }
        crawled++;
        inFlight++;
        try {
          await crawlOne(next);
        } finally {
          inFlight--;
        }
        await opts.onProgress?.(crawled);
        if (delayMs) await sleep(delayMs);
      }
    };

    const crawlOne = async (next: { url: string; depth: number }) => {
      {
        const page = blank(next.url, next.depth);
        pages.set(next.url, page);
        if (!allowed(next.url)) {
          page.blockedByRobots = true;
          return;
        }
        const res = await fetchUrl(next.url, isAllowedHost, fo);
        page.status = res.status;
        page.finalUrl = res.finalUrl !== next.url ? res.finalUrl : null;
        page.redirectChain = res.hops.length > 1 || res.leftHost ? res.hops : [];
        page.responseMs = res.ms;
        page.contentType = res.contentType;
        page.bytes = res.bytes;
        page.xRobotsTag = res.xRobotsTag?.toLowerCase() ?? null;
        page.fetchError = res.error;
        if (page.finalUrl && !res.leftHost) enqueue(page.finalUrl, next.depth); // the redirect target is a page too
        if (res.status === 200 && res.body && /html/i.test(res.contentType ?? 'text/html') && !page.finalUrl) {
          page.html = parseHtml(res.body, next.url);
          for (const l of page.html.links) {
            const target = normalizeCrawlUrl(l.url);
            if (!target) continue;
            const t = new URL(target);
            if (!isAllowedHost(t.hostname)) continue;
            if (start.protocol === 'https:' && t.protocol === 'http:') page.insecureLinks.push(target);
            if (!links.has(target)) links.set(target, new Set());
            links.get(target)!.add(next.url);
            if (!l.nofollow) enqueue(target, next.depth + 1);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, work));
    if (queue.length) limitReached = true;

    for (const [target, sources] of links) {
      const p = pages.get(target);
      if (p) {
        p.inlinks = [...sources].filter((s) => s !== target).length;
        p.linkedFrom = [...sources].filter((s) => s !== target).slice(0, 20);
      }
    }
    // a redirecting URL passes its inlinks on to its target
    for (const p of pages.values()) {
      if (p.finalUrl && pages.get(p.finalUrl)) pages.get(p.finalUrl)!.inlinks += p.inlinks;
    }

    // ---- host variant (www <-> non-www) and https availability
    let hostVariant: CrawlResult['hostVariant'] = null;
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(start.hostname) && start.hostname !== 'localhost') {
      const twin = start.hostname.startsWith('www.') ? start.hostname.slice(4) : `www.${start.hostname}`;
      const twinUrl = `${start.protocol}//${twin}${start.port ? ':' + start.port : ''}/`;
      const tv = await fetchUrl(twinUrl, () => true, { ...fo });
      hostVariant = {
        url: twinUrl,
        status: tv.hops[0]?.status ?? tv.status,
        redirectsToCanonical: tv.hops.length > 1 && isAllowedHost(new URL(tv.finalUrl).hostname) && new URL(tv.finalUrl).hostname === start.hostname,
      };
    }
    let httpsAvailable = start.protocol === 'https:';
    if (!httpsAvailable && start.hostname !== 'localhost' && !/^\d/.test(start.hostname)) {
      const hs = await fetchUrl(`https://${start.host}/`, isAllowedHost, fo);
      httpsAvailable = hs.status !== null && hs.status < 500;
    }

    return {
      startUrl: start.toString(),
      origin,
      host: start.hostname,
      pages: [...pages.values()],
      robots: {
        url: robotsUrl,
        found: robotsFound,
        status: r.status,
        sitemaps: robotsSitemaps,
        disallowsAll: robotsFound && !allowed(`${origin}/`),
      },
      sitemap: { url: sitemapFound ? sitemapUrl : null, found: sitemapFound, valid: sitemapValid, urls: [...sitemapSet], status: s.status },
      hostVariant,
      httpsAvailable,
      limitReached,
    };
  } finally {
    await agent.close().catch(() => undefined);
  }
}
