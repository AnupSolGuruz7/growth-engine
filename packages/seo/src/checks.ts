import { createHash } from 'node:crypto';
import type { SeoCategory, SeoSeverity } from '@growthos/shared-types';
import type { CrawledPage, CrawlResult } from './crawler';
import type { PageSpeedResult } from './pagespeed';

export interface Finding {
  check_id: string;
  category: SeoCategory;
  severity: SeoSeverity;
  title: string;
  url: string;
  evidence: Record<string, unknown>;
  explanation: string;
  suggested_fix: string;
  /** 0..1: how sure we are this is a real problem (some checks flag things that may be intended). */
  confidence: number;
  /** 1 = minutes, 2 = hours, 3 = needs a developer / larger change. */
  effort: 1 | 2 | 3;
  limits?: string;
  /** Overrides the default url-based fingerprint for site-wide or grouped findings. */
  group_key?: string;
}

export interface ScoredFinding extends Finding {
  pageviews_28d: number;
  priority: number;
  fingerprint: string;
}

const SEV_WEIGHT: Record<SeoSeverity, number> = { critical: 8, high: 4, medium: 2, low: 1 };

export const TITLE_MIN = 30;
export const TITLE_MAX = 60;
export const DESC_MIN = 70;
export const DESC_MAX = 160;
export const THIN_WORDS = 200;

const isNoindex = (p: CrawledPage) => /noindex/.test(p.html?.robotsMeta ?? '') || /noindex/.test(p.xRobotsTag ?? '');
export const isIndexable = (p: CrawledPage) =>
  p.status === 200 && !!p.html && !p.finalUrl && !isNoindex(p) && !p.blockedByRobots && (!p.html.canonical || sameUrl(p.html.canonical, p.url));

function sameUrl(a: string, b: string): boolean {
  const n = (u: string) => {
    try {
      const x = new URL(u);
      x.hash = '';
      return (x.origin + x.pathname.replace(/\/$/, '') + x.search).toLowerCase();
    } catch {
      return u;
    }
  };
  return n(a) === n(b);
}

const bareHost = (h: string) => h.toLowerCase().replace(/^www\./, '');

/**
 * Placeholder / test pages: a whole path segment like /test or /staging-2, or placeholder text in
 * the title or H1. Ordinary words inside a slug ("stress-test-your-cash-flow") do not count.
 */
export function isPlaceholderPage(path: string, title: string | null, h1: string[]): boolean {
  const segment = /(^|\/)(test|tests|testing|test-page|staging|dev|demo-page|sample-page|hello-world|untitled)(-\d+)?(\/|$)/i;
  const text = /\b(lorem ipsum|sample page|hello world|test page|untitled( page)?)\b/i;
  return segment.test(path) || text.test(`${title ?? ''} ${h1.join(' ')}`) || /^\s*test\s*$/i.test(title ?? '');
}

/**
 * The canonical points to the same path on a different host: this host mirrors that one
 * (a staging copy, an alias domain). Search engines index the other host, but the content —
 * and so every on-page check — is the same.
 */
export function isMirrorCanonical(p: CrawledPage): boolean {
  if (!p.html?.canonical) return false;
  try {
    const c = new URL(p.html.canonical);
    const u = new URL(p.url);
    const path = (x: URL) => (x.pathname.replace(/\/+$/, '') || '/') + x.search;
    return bareHost(c.hostname) !== bareHost(u.hostname) && path(c) === path(u);
  } catch {
    return false;
  }
}

/** Pages whose content is checked: live HTML, not noindex or robots-blocked, canonical to itself or to its mirror. */
export const isContentChecked = (p: CrawledPage) =>
  p.status === 200 && !!p.html && !p.finalUrl && !isNoindex(p) && !p.blockedByRobots &&
  (!p.html.canonical || sameUrl(p.html.canonical, p.url) || isMirrorCanonical(p));

const isPaginated = (p: CrawledPage) =>
  !!p.html?.paginationRel.prev || /[?&](page|p)=\d+/.test(p.url) || /\/page\/\d+\/?$/.test(new URL(p.url).pathname);

/** Runs every check over a crawl. Pure: same crawl in, same findings out. */
export function runChecks(crawl: CrawlResult, psi: PageSpeedResult[] = []): Finding[] {
  const f: Finding[] = [];
  const add = (x: Finding) => f.push(x);
  const byUrl = new Map(crawl.pages.map((p) => [p.url, p]));
  const home = crawl.pages[0];
  const htmlPages = crawl.pages.filter((p) => p.status === 200 && p.html && !p.finalUrl);
  // pages whose content is checked (includes mirror pages: same content as the canonical host)
  const indexable = htmlPages.filter(isContentChecked);

  // ---------------------------------------------------------------- site level
  const mirrors = htmlPages.filter(isMirrorCanonical);
  const siteIsMirror = mirrors.length >= 3 && mirrors.length >= htmlPages.length * 0.5;
  if (siteIsMirror) {
    const target = new URL(mirrors[0]!.html!.canonical!);
    add({
      check_id: 'canonical_other_domain', category: 'technical', severity: 'medium',
      title: `This host is a copy of ${target.hostname} (canonical tags point there)`,
      url: home?.url ?? crawl.startUrl,
      evidence: {
        canonical_host: target.hostname,
        pages_pointing_there: mirrors.length,
        pages_checked: htmlPages.length,
        examples: mirrors.slice(0, 5).map((p) => ({ page: p.url, canonical: p.html!.canonical })),
      },
      explanation: `${mirrors.length} of ${htmlPages.length} pages declare the same page on ${target.hostname} as the canonical version, so search engines will index ${target.hostname}, not ${crawl.host}. That is correct for a staging or mirror copy, and wrong if ${crawl.host} is meant to rank.`,
      suggested_fix: `If ${crawl.host} is a staging copy: keep the canonicals, block indexing (noindex or password protection) and audit ${target.hostname} for search results. If ${crawl.host} should rank: make every canonical self-referencing.`,
      confidence: 0.7, effort: 1, group_key: 'site',
      limits: 'Content checks below still run on these pages because they serve the same content as the canonical host.',
    });
  }

  // ---------------------------------------------------------------- site level (robots, sitemap, https)
  if (!crawl.robots.found) {
    add({
      check_id: 'robots_missing', category: 'technical', severity: 'low', title: 'No robots.txt',
      url: crawl.robots.url, evidence: { status: crawl.robots.status },
      explanation: 'Search engines look for /robots.txt first. Without it every URL is crawlable and no sitemap is advertised.',
      suggested_fix: `Add ${crawl.origin}/robots.txt, for example:\n\nUser-agent: *\nAllow: /\n\nSitemap: ${crawl.origin}/sitemap.xml`,
      confidence: 0.9, effort: 1, group_key: 'site',
    });
  }
  if (crawl.robots.disallowsAll) {
    add({
      check_id: 'robots_blocks_all', category: 'technical', severity: 'critical', title: 'robots.txt blocks the whole site',
      url: crawl.robots.url, evidence: { rule: 'Disallow: /' },
      explanation: 'robots.txt disallows the homepage, so search engines will not crawl the site at all.',
      suggested_fix: 'Remove the "Disallow: /" rule for "User-agent: *" (keep it only on staging sites).',
      confidence: 0.95, effort: 1, group_key: 'site',
    });
  }
  if (!crawl.sitemap.found) {
    add({
      check_id: 'sitemap_missing', category: 'technical', severity: 'medium', title: 'No XML sitemap',
      url: `${crawl.origin}/sitemap.xml`, evidence: { looked_at: crawl.robots.sitemaps[0] ?? `${crawl.origin}/sitemap.xml`, status: crawl.sitemap.status },
      explanation: 'A sitemap tells search engines which pages exist and helps new or deep pages get discovered.',
      suggested_fix: 'Generate /sitemap.xml listing every indexable page (most CMSs and frameworks have a plugin) and reference it in robots.txt with a "Sitemap:" line.',
      confidence: 0.9, effort: 2, group_key: 'site',
    });
  } else if (!crawl.sitemap.valid) {
    add({
      check_id: 'sitemap_invalid', category: 'technical', severity: 'high', title: 'Sitemap is not valid XML',
      url: crawl.sitemap.url!, evidence: { status: crawl.sitemap.status },
      explanation: 'The sitemap URL answers but does not contain a <urlset> or <sitemapindex>, so search engines cannot use it.',
      suggested_fix: 'Serve a valid sitemap (https://www.sitemaps.org/protocol.html) with Content-Type application/xml.',
      confidence: 0.9, effort: 2, group_key: 'site',
    });
  }
  const localHost = crawl.host === 'localhost' || /^[\d.]+$/.test(crawl.host) || crawl.host.includes(':');
  if (crawl.startUrl.startsWith('http:') && !localHost) {
    add(crawl.httpsAvailable
      ? {
          check_id: 'http_not_redirected', category: 'technical', severity: 'medium', title: 'Site is served over HTTP without redirecting to HTTPS',
          url: crawl.startUrl, evidence: { start_url: crawl.startUrl },
          explanation: 'Pages answer on http:// as well as https://, which splits ranking signals and shows a "Not secure" warning.',
          suggested_fix: 'Redirect every http:// URL to its https:// equivalent with a 301 and enable HSTS.',
          confidence: 0.8, effort: 2, group_key: 'site',
        }
      : {
          check_id: 'no_https', category: 'technical', severity: 'high', title: 'Site is not available over HTTPS',
          url: crawl.startUrl, evidence: { start_url: crawl.startUrl },
          explanation: 'HTTPS is a ranking signal and browsers mark HTTP pages "Not secure".',
          suggested_fix: 'Install a TLS certificate (e.g. Let\'s Encrypt) and redirect all HTTP traffic to HTTPS.',
          confidence: 0.85, effort: 3, group_key: 'site',
          limits: 'Not reported for localhost / IP addresses.',
        });
  }
  if (crawl.hostVariant && crawl.hostVariant.status === 200 && !crawl.hostVariant.redirectsToCanonical) {
    add({
      check_id: 'host_variant_duplicate', category: 'technical', severity: 'medium', title: 'www and non-www both serve the site',
      url: crawl.hostVariant.url, evidence: { variant: crawl.hostVariant.url, status: crawl.hostVariant.status },
      explanation: 'The same content is reachable on two hostnames, which creates duplicate URLs and splits links.',
      suggested_fix: `301-redirect ${crawl.hostVariant.url} to ${crawl.origin}/ (keep one canonical hostname).`,
      confidence: 0.8, effort: 2, group_key: 'site',
    });
  }

  // ---------------------------------------------------------------- per page: technical
  const brokenBySource = new Map<string, { url: string; status: number | null }[]>();
  for (const p of crawl.pages) {
    if (p.blockedByRobots) continue;
    if (p.fetchError && p.fetchError !== 'too_many_redirects') {
      add({
        check_id: 'fetch_failed', category: 'technical', severity: 'high', title: 'Page could not be fetched',
        url: p.url, evidence: { error: p.fetchError, linked_from: p.linkedFrom.slice(0, 5) },
        explanation: 'The request failed (timeout, DNS or connection error), so search engines may not be able to load this page either.',
        suggested_fix: 'Check that the page loads reliably; investigate server errors or timeouts in your hosting logs.',
        confidence: 0.7, effort: 2, limits: 'A single failed request can be a temporary blip; re-run the audit to confirm.',
      });
      continue;
    }
    if (p.status !== null && p.status >= 400) {
      const important = p === home || p.inSitemap;
      add({
        check_id: 'http_error', category: 'technical', severity: important ? 'critical' : 'high',
        title: `Page returns ${p.status}`, url: p.url,
        evidence: { status: p.status, in_sitemap: p.inSitemap, linked_from: p.linkedFrom.slice(0, 10) },
        explanation: p.status >= 500 ? 'A server error tells search engines the page is broken.' : 'Linked or listed pages that return an error waste crawl budget and frustrate visitors.',
        suggested_fix: p.status === 404 || p.status === 410
          ? 'Restore the page, or 301-redirect it to the closest live page and update links/sitemap entries pointing to it.'
          : 'Fix the server error for this URL.',
        confidence: 0.95, effort: 2,
      });
      for (const src of p.linkedFrom) {
        if (!brokenBySource.has(src)) brokenBySource.set(src, []);
        brokenBySource.get(src)!.push({ url: p.url, status: p.status });
      }
    }
    if (p.fetchError === 'too_many_redirects' || p.redirectChain.length >= 3) {
      add({
        check_id: 'redirect_chain', category: 'technical', severity: p.fetchError ? 'high' : 'medium',
        title: p.fetchError ? 'Redirect loop or too many redirects' : `Redirect chain of ${p.redirectChain.length - 1} hops`,
        url: p.url, evidence: { chain: p.redirectChain },
        explanation: 'Each extra redirect slows the page down and can stop crawlers from reaching the destination.',
        suggested_fix: `Redirect ${p.url} straight to the final URL in one 301, and update internal links to point at the final URL.`,
        confidence: 0.9, effort: 1,
      });
    }
    if (p.status === 200 && p.html && sitemapListed(crawl, p) && isNoindex(p)) {
      add({
        check_id: 'noindex_in_sitemap', category: 'technical', severity: 'high', title: 'Sitemap lists a noindex page',
        url: p.url, evidence: { robots_meta: p.html.robotsMeta, x_robots_tag: p.xRobotsTag },
        explanation: 'The sitemap asks search engines to index this page while the page itself says "noindex" — conflicting signals.',
        suggested_fix: 'Either remove "noindex" (if the page should rank) or remove the URL from the sitemap.',
        confidence: 0.9, effort: 1,
      });
    } else if (p.status === 200 && p.html && isNoindex(p)) {
      add({
        check_id: 'noindex', category: 'technical', severity: 'low', title: 'Page is set to noindex',
        url: p.url, evidence: { robots_meta: p.html.robotsMeta, x_robots_tag: p.xRobotsTag, pageviews_note: 'see traffic column' },
        explanation: 'This page will not appear in search results. That is fine for thank-you or account pages, a problem for content pages.',
        suggested_fix: 'If the page should rank, remove the noindex directive from the robots meta tag / X-Robots-Tag header.',
        confidence: 0.5, effort: 1, limits: 'Often intentional — confirm before changing.',
      });
    }
    if (p.inSitemap && p.status !== null && p.status !== 200) {
      add({
        check_id: 'sitemap_url_error', category: 'technical', severity: 'medium', title: `Sitemap lists a URL that returns ${p.status}`,
        url: p.url, evidence: { status: p.status, final_url: p.finalUrl },
        explanation: 'Sitemaps should only list final, live, indexable URLs.',
        suggested_fix: p.finalUrl ? `Replace the entry with the final URL ${p.finalUrl}.` : 'Remove the URL from the sitemap or fix the page.',
        confidence: 0.9, effort: 1,
      });
    }
  }
  for (const [src, broken] of brokenBySource) {
    add({
      check_id: 'broken_internal_links', category: 'technical', severity: 'medium',
      title: `${broken.length} broken internal link${broken.length > 1 ? 's' : ''}`, url: src,
      evidence: { broken: broken.slice(0, 20) },
      explanation: 'Links to error pages lead visitors to dead ends and waste link equity.',
      suggested_fix: `Update or remove the links on this page pointing to: ${broken.slice(0, 5).map((b) => b.url).join(', ')}${broken.length > 5 ? ' …' : ''}`,
      confidence: 0.95, effort: 1,
    });
  }

  // ---------------------------------------------------------------- per page: html pages
  for (const p of htmlPages) {
    const h = p.html!;
    if (p.insecureLinks.length) {
      add({
        check_id: 'insecure_internal_links', category: 'technical', severity: 'medium', title: 'Internal links use http://',
        url: p.url, evidence: { links: [...new Set(p.insecureLinks)].slice(0, 10) },
        explanation: 'Linking to the http:// version forces an extra redirect and can cause mixed-content warnings.',
        suggested_fix: 'Change these links to https:// (or to relative URLs).',
        confidence: 0.9, effort: 1,
      });
    }
    // site-wide mirror canonicals are reported once above, not per page
    if (h.canonical && !sameUrl(h.canonical, p.url) && !(siteIsMirror && isMirrorCanonical(p))) {
      const sameHost = (() => {
        try {
          return bareHost(new URL(h.canonical).hostname) === bareHost(new URL(p.url).hostname);
        } catch {
          return false;
        }
      })();
      const target = byUrl.get(h.canonical) ?? byUrl.get(h.canonical.replace(/\/$/, '')) ?? byUrl.get(h.canonical + '/');
      if (target && (target.status !== 200 || target.finalUrl)) {
        add({
          check_id: 'canonical_target_error', category: 'technical', severity: 'high', title: 'Canonical points to a redirect or error page',
          url: p.url, evidence: { canonical: h.canonical, target_status: target.status, target_redirects_to: target.finalUrl },
          explanation: 'Canonical URLs must be live, final pages; otherwise search engines may ignore the hint.',
          suggested_fix: `Point the canonical at the final live URL${target.finalUrl ? ` (${target.finalUrl})` : ''}.`,
          confidence: 0.9, effort: 1,
        });
      } else if (isPaginated(p) && sameHost && !isMirrorCanonical(p)) {
        add({
          check_id: 'paginated_canonical', category: 'technical', severity: 'medium', title: 'Paginated page canonicalises to another page',
          url: p.url, evidence: { canonical: h.canonical },
          explanation: 'Pointing page 2, 3… at page 1 tells search engines to ignore the items listed only on later pages.',
          suggested_fix: 'Give each paginated page a self-referencing canonical.',
          confidence: 0.8, effort: 1,
        });
      } else {
        add({
          check_id: 'canonical_elsewhere', category: 'technical', severity: 'low', title: 'Page canonicalises to another URL',
          url: p.url, evidence: { canonical: h.canonical },
          explanation: 'This page asks search engines to rank a different URL instead. Correct for duplicates, wrong for unique content.',
          suggested_fix: 'If this page has unique content, make the canonical self-referencing.',
          confidence: 0.4, effort: 1, limits: 'Usually intentional for duplicate/variant URLs.',
        });
      }
    }
    if (!isContentChecked(p)) continue;

    if (h.jsRendered) {
      add({
        check_id: 'js_rendered_content', category: 'technical', severity: 'medium', title: 'Content is rendered by JavaScript',
        url: p.url, evidence: { static_word_count: h.wordCount },
        explanation: 'The HTML sent by the server is an empty app shell; the visible content only appears after JavaScript runs. Search engines render JavaScript later and less reliably, and other crawlers (social previews, AI assistants) often never see the content.',
        suggested_fix: 'Server-side render or pre-render this route (e.g. Next.js/Nuxt SSR or static generation, or a prerender service) so the HTML already contains the title, headings and text.',
        confidence: 0.7, effort: 3,
        limits: 'Detected from the static HTML (empty mount element + scripts). Content checks on this page are marked low-confidence.',
      });
    }

    if (!h.canonical) {
      add({
        check_id: 'canonical_missing', category: 'technical', severity: 'low', title: 'No canonical tag',
        url: p.url, evidence: {},
        explanation: 'A self-referencing canonical protects against duplicates created by tracking parameters or alternative URLs.',
        suggested_fix: `Add <link rel="canonical" href="${p.url}"> to the <head>.`,
        confidence: 0.7, effort: 1,
      });
    }
    if (!h.hasViewport) {
      add({
        check_id: 'missing_viewport', category: 'technical', severity: 'medium', title: 'No mobile viewport meta tag',
        url: p.url, evidence: {},
        explanation: 'Without a viewport tag the page renders as a zoomed-out desktop page on phones; Google indexes mobile-first.',
        suggested_fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the <head>.',
        confidence: 0.9, effort: 1,
      });
    }

    // ---- on-page
    if (!h.title) {
      add({
        check_id: 'title_missing', category: 'on-page', severity: 'high', title: 'Missing <title>',
        url: p.url, evidence: { title: null },
        explanation: 'The title is the clickable headline in search results and one of the strongest on-page signals.',
        suggested_fix: `Add a unique, descriptive <title> of ${TITLE_MIN}–${TITLE_MAX} characters that leads with the page's main topic.`,
        confidence: 0.95, effort: 1,
      });
    } else if (h.title.length < TITLE_MIN || h.title.length > TITLE_MAX) {
      add({
        check_id: 'title_length', category: 'on-page', severity: 'low',
        title: h.title.length < TITLE_MIN ? 'Title is short' : 'Title may be truncated in results',
        url: p.url, evidence: { title: h.title, length: h.title.length, recommended: `${TITLE_MIN}–${TITLE_MAX}` },
        explanation: h.title.length < TITLE_MIN
          ? 'A very short title misses the chance to describe the page and match more searches.'
          : 'Search engines cut titles at roughly 60 characters (≈580px), hiding the end.',
        suggested_fix: `Rewrite the title to ${TITLE_MIN}–${TITLE_MAX} characters, keeping the key topic at the start.`,
        confidence: 0.6, effort: 1, limits: 'Length guidance only; pixel width decides the exact cut-off.',
      });
    }
    if (!h.metaDescription) {
      add({
        check_id: 'meta_description_missing', category: 'on-page', severity: 'medium', title: 'Missing meta description',
        url: p.url, evidence: { meta_description: null },
        explanation: 'Without one, search engines pick a random snippet, which usually lowers click-through rate.',
        suggested_fix: `Write a ${DESC_MIN}–${DESC_MAX} character summary that says what the page offers and why to click.`,
        confidence: 0.85, effort: 1,
      });
    } else if (h.metaDescription.length < DESC_MIN || h.metaDescription.length > DESC_MAX) {
      add({
        check_id: 'meta_description_length', category: 'on-page', severity: 'low',
        title: h.metaDescription.length < DESC_MIN ? 'Meta description is short' : 'Meta description is long',
        url: p.url, evidence: { meta_description: h.metaDescription, length: h.metaDescription.length, recommended: `${DESC_MIN}–${DESC_MAX}` },
        explanation: 'Descriptions outside this range are often truncated or replaced by search engines.',
        suggested_fix: `Rewrite to ${DESC_MIN}–${DESC_MAX} characters.`,
        confidence: 0.5, effort: 1,
      });
    }
    if (h.h1.length === 0) {
      add({
        check_id: 'h1_missing', category: 'on-page', severity: 'medium', title: 'No H1 heading',
        url: p.url, evidence: { headings: h.headings.slice(0, 5) },
        explanation: 'The H1 tells visitors and search engines what the page is about.',
        suggested_fix: 'Add exactly one <h1> that states the main topic of the page.',
        confidence: 0.85, effort: 1,
      });
    } else if (h.h1.length > 1) {
      add({
        check_id: 'h1_multiple', category: 'on-page', severity: 'low', title: `${h.h1.length} H1 headings`,
        url: p.url, evidence: { h1: h.h1.slice(0, 5) },
        explanation: 'Several H1s blur the main topic of the page.',
        suggested_fix: 'Keep one <h1> for the main topic and turn the others into <h2>.',
        confidence: 0.6, effort: 1,
      });
    }
    const skip = h.headings.find((x, i) => i > 0 && x.level > h.headings[i - 1]!.level + 1);
    if (skip) {
      add({
        check_id: 'heading_skip', category: 'on-page', severity: 'low', title: 'Heading levels are skipped',
        url: p.url, evidence: { outline: h.headings.slice(0, 15).map((x) => `h${x.level}: ${x.text}`), first_skip: `h${skip.level}: ${skip.text}` },
        explanation: 'Jumping from, say, H2 to H4 breaks the document outline used by screen readers and search engines.',
        suggested_fix: 'Use heading levels in order (H1 → H2 → H3) without skipping.',
        confidence: 0.6, effort: 1,
      });
    }
    if (h.boldPseudoHeadings.length >= 2 && !h.headings.some((x) => x.level === 2)) {
      add({
        check_id: 'bold_as_heading', category: 'on-page', severity: 'low', title: 'Subheadings written as bold text',
        url: p.url, evidence: { examples: h.boldPseudoHeadings.slice(0, 5) },
        explanation: 'Bold paragraphs look like headings but give no structure to search engines or screen readers.',
        suggested_fix: `Turn these into <h2> elements: ${h.boldPseudoHeadings.slice(0, 3).map((t) => `"${t}"`).join(', ')}.`,
        confidence: 0.6, effort: 1,
      });
    }
    if (h.imagesMissingAlt.length) {
      add({
        check_id: 'images_missing_alt', category: 'on-page', severity: h.imagesMissingAlt.length >= 3 ? 'medium' : 'low',
        title: `${h.imagesMissingAlt.length} image${h.imagesMissingAlt.length > 1 ? 's' : ''} without alt text`,
        url: p.url, evidence: { images: h.imagesMissingAlt.slice(0, 10), total_images: h.images },
        explanation: 'Alt text makes images accessible and lets them rank in image search.',
        suggested_fix: 'Describe each meaningful image in its alt attribute; use alt="" only for purely decorative images.',
        confidence: 0.8, effort: 1,
      });
    }
    if (h.structuredData.some((s) => !s.valid)) {
      add({
        check_id: 'structured_data_invalid', category: 'on-page', severity: 'medium', title: 'Invalid JSON-LD structured data',
        url: p.url, evidence: { blocks: h.structuredData },
        explanation: 'A JSON-LD block does not parse, so search engines ignore it and rich results are lost.',
        suggested_fix: 'Fix the JSON syntax (validate with https://validator.schema.org).',
        confidence: 0.9, effort: 1,
      });
    } else if (p === home && h.structuredData.length === 0) {
      add({
        check_id: 'structured_data_missing', category: 'on-page', severity: 'low', title: 'No structured data on the homepage',
        url: p.url, evidence: {},
        explanation: 'Organization / WebSite structured data helps search engines show your name, logo and sitelinks.',
        suggested_fix: 'Add a JSON-LD <script type="application/ld+json"> with "@type": "Organization" (name, url, logo).',
        confidence: 0.6, effort: 1,
      });
    }
    if ((h.wordCount ?? 0) < THIN_WORDS && p !== home) {
      add({
        check_id: 'thin_content', category: 'on-page', severity: 'low', title: `Thin content (${h.wordCount} words)`,
        url: p.url, evidence: { word_count: h.wordCount, threshold: THIN_WORDS },
        explanation: 'Pages with very little text rarely rank and can drag down how search engines judge the site.',
        suggested_fix: 'Expand the page with useful, specific content, merge it into a related page, or set it to noindex.',
        confidence: 0.5, effort: 2, limits: 'Word count is a rough proxy; some pages (contact, tools) are short by design.',
      });
    }
    if (isPlaceholderPage(p.path, h.title, h.h1)) {
      add({
        check_id: 'test_page', category: 'on-page', severity: 'medium', title: 'Looks like a test or placeholder page',
        url: p.url, evidence: { title: h.title, h1: h.h1 },
        explanation: 'Placeholder pages that are live and indexable look unprofessional in search results.',
        suggested_fix: 'Delete the page (410) or set it to noindex and remove internal links to it.',
        confidence: 0.6, effort: 1,
      });
    }
    if (p.inSitemap && p.inlinks === 0 && p !== home) {
      add({
        check_id: 'orphan_page', category: 'technical', severity: 'medium', title: 'Orphan page (in sitemap, no internal links)',
        url: p.url, evidence: { in_sitemap: true, inlinks: 0 },
        explanation: 'No crawled page links here, so visitors cannot find it and search engines see it as unimportant.',
        suggested_fix: 'Link to this page from relevant pages (navigation, related content) — or remove it if it is obsolete.',
        confidence: 0.75, effort: 1, limits: `Based on the ${crawl.pages.length} pages crawled.`,
      });
    }

    // ---- performance (from the crawl itself)
    if ((p.responseMs ?? 0) > 1500) {
      add({
        check_id: 'slow_response', category: 'performance', severity: (p.responseMs ?? 0) > 3000 ? 'medium' : 'low',
        title: `Slow server response (${p.responseMs} ms)`, url: p.url, evidence: { response_ms: p.responseMs },
        explanation: 'A slow HTML response delays everything else on the page and hurts Core Web Vitals.',
        suggested_fix: 'Cache the page (CDN / page cache), and check slow database queries or server resources.',
        confidence: 0.5, effort: 3, limits: 'Measured once from the crawler location; re-run to confirm.',
      });
    }
    const blocking = h.renderBlocking.scripts.length + h.renderBlocking.stylesheets;
    if (blocking >= 4) {
      add({
        check_id: 'render_blocking', category: 'performance', severity: blocking >= 8 ? 'medium' : 'low',
        title: `${blocking} render-blocking resources`, url: p.url,
        evidence: { scripts: h.renderBlocking.scripts.slice(0, 10), stylesheets: h.renderBlocking.stylesheets },
        explanation: 'Scripts and stylesheets in <head> without async/defer must load before anything is painted.',
        suggested_fix: 'Add defer (or async) to scripts, inline critical CSS and load the rest asynchronously.',
        confidence: 0.6, effort: 2,
      });
    }
    if ((p.bytes ?? 0) > 1_000_000) {
      add({
        check_id: 'large_html', category: 'performance', severity: 'low', title: `Large HTML document (${Math.round((p.bytes ?? 0) / 1024)} KB)`,
        url: p.url, evidence: { bytes: p.bytes },
        explanation: 'Very large HTML slows parsing, especially on phones.',
        suggested_fix: 'Remove inlined data/markup that is not needed for the first view; paginate long lists.',
        confidence: 0.6, effort: 2,
      });
    }
  }

  // ---------------------------------------------------------------- cross-page
  for (const [key, label, check] of [
    ['title', 'title', 'title_duplicate'],
    ['metaDescription', 'meta description', 'meta_description_duplicate'],
  ] as const) {
    const groups = new Map<string, CrawledPage[]>();
    for (const p of indexable) {
      const v = p.html![key];
      if (!v) continue;
      const k = v.toLowerCase();
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(p);
    }
    for (const [value, ps] of groups) {
      if (ps.length < 2) continue;
      add({
        check_id: check, category: 'on-page', severity: key === 'title' ? 'medium' : 'low',
        title: `${ps.length} pages share the same ${label}`, url: ps[0]!.url,
        evidence: { [key === 'title' ? 'title' : 'meta_description']: ps[0]!.html![key], pages: ps.slice(0, 20).map((x) => x.url) },
        explanation: `Duplicate ${label}s make pages compete with each other and make it hard for searchers to tell them apart.`,
        suggested_fix: `Write a unique ${label} for each of these pages that reflects its specific content.`,
        confidence: 0.85, effort: 1, group_key: `${check}|${value}`,
      });
    }
  }

  // trailing-slash duplicates: /x and /x/ both live and not canonicalised together
  const live = new Map(indexable.map((p) => [p.url, p]));
  for (const p of indexable) {
    if (!p.url.endsWith('/') || new URL(p.url).pathname === '/') continue;
    const twin = live.get(p.url.slice(0, -1));
    if (twin) {
      add({
        check_id: 'trailing_slash_duplicate', category: 'technical', severity: 'low', title: 'Same page with and without trailing slash',
        url: twin.url, evidence: { urls: [twin.url, p.url] },
        explanation: 'Two URLs serve the same content, splitting links and ranking signals.',
        suggested_fix: 'Pick one form, 301-redirect the other to it and use it consistently in links.',
        confidence: 0.8, effort: 2,
      });
    }
  }

  // ---------------------------------------------------------------- Core Web Vitals (PageSpeed Insights)
  for (const r of psi) {
    const rate = (v: number | null, good: number, poor: number): SeoSeverity | null =>
      v === null ? null : v > poor ? 'high' : v > good ? 'medium' : null;
    const metrics: [string, string, number | null, number, number, string][] = [
      ['cwv_lcp', 'Largest Contentful Paint', r.lcpMs, 2500, 4000, 'ms'],
      ['cwv_cls', 'Cumulative Layout Shift', r.cls, 0.1, 0.25, ''],
      ['cwv_inp', 'Interaction to Next Paint', r.inpMs, 200, 500, 'ms'],
    ];
    for (const [id, name, value, good, poor, unit] of metrics) {
      const sev = rate(value, good, poor);
      if (!sev) continue;
      add({
        check_id: id, category: 'performance', severity: sev,
        title: `${name} ${sev === 'high' ? 'is poor' : 'needs improvement'} (${unit === 'ms' ? Math.round(value!) : value}${unit})`,
        url: r.url, evidence: { metric: name, value, good_below: good, poor_above: poor, source: r.source, strategy: 'mobile' },
        explanation: `${name} is one of Google's Core Web Vitals; values above ${good}${unit} are not "good".`,
        suggested_fix: id === 'cwv_lcp'
          ? 'Optimise the largest above-the-fold image or text block: compress/resize images, preload the hero image, reduce server response time.'
          : id === 'cwv_cls'
            ? 'Reserve space for images, ads and embeds (width/height or aspect-ratio) and avoid inserting content above existing content.'
            : 'Break up long JavaScript tasks and reduce third-party scripts that run on interaction.',
        confidence: r.source === 'field' ? 0.9 : 0.65, effort: 3,
        limits: r.source === 'field' ? 'Real-user data (Chrome UX Report, last 28 days).' : 'Lab data from a single simulated mobile load.',
      });
    }
  }
  // Content checks on JavaScript-rendered pages only saw the empty shell: keep them, but say so.
  const jsPages = new Set(htmlPages.filter((p) => p.html!.jsRendered).map((p) => p.url));
  return f.map((x) =>
    jsPages.has(x.url) && JS_SENSITIVE.has(x.check_id)
      ? {
          ...x,
          confidence: Math.min(x.confidence, 0.3),
          limits: 'This page renders its content with JavaScript; only the static HTML was checked, so this may not match what visitors see.',
        }
      : x,
  );
}

/** Checks whose result depends on page content that a JavaScript app may only add after load. */
const JS_SENSITIVE = new Set([
  'h1_missing', 'h1_multiple', 'heading_skip', 'bold_as_heading', 'thin_content', 'images_missing_alt',
  'structured_data_missing', 'title_missing', 'title_length', 'title_duplicate', 'meta_description_missing',
  'meta_description_length', 'meta_description_duplicate',
]);

function sitemapListed(crawl: CrawlResult, p: CrawledPage): boolean {
  return p.inSitemap || crawl.sitemap.urls.includes(p.url);
}

/** Adds traffic, priority and a stable fingerprint; sorted by priority (highest first). */
export function scoreFindings(findings: Finding[], pageviewsByPath: Map<string, number>): ScoredFinding[] {
  return findings
    .map((x) => {
      let path = '/';
      try {
        path = new URL(x.url).pathname.replace(/\/+$/, '') || '/';
      } catch {
        /* keep / */
      }
      const pv = pageviewsByPath.get(path) ?? 0;
      const priority = (SEV_WEIGHT[x.severity] * x.confidence * (1 + Math.log10(1 + pv))) / x.effort;
      const fp = createHash('sha1').update(`${x.check_id}|${x.group_key ?? x.url}`).digest('hex').slice(0, 20);
      return { ...x, pageviews_28d: pv, priority: Math.round(priority * 100) / 100, fingerprint: fp };
    })
    .sort((a, b) => b.priority - a.priority || a.url.localeCompare(b.url));
}

const PENALTY: Record<SeoSeverity, number> = { critical: 15, high: 6, medium: 2, low: 0.5 };
const MAX_PER_CHECK = 20;

/** 0–100 health score: penalties per finding, capped per check so one noisy check cannot zero the score. */
export function auditScore(findings: Finding[]): number {
  const perCheck = new Map<string, number>();
  for (const x of findings) perCheck.set(x.check_id, (perCheck.get(x.check_id) ?? 0) + PENALTY[x.severity] * x.confidence);
  const total = [...perCheck.values()].reduce((s, v) => s + Math.min(v, MAX_PER_CHECK), 0);
  return Math.max(0, Math.round(100 - total));
}
