import { load } from 'cheerio';

export interface ParsedHtml {
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  robotsMeta: string | null;
  lang: string | null;
  hasViewport: boolean;
  h1: string[];
  headings: { level: number; text: string }[];
  wordCount: number;
  textExcerpt: string;
  /** Absolute http(s) URLs of <a href> links (hash removed). */
  links: { url: string; nofollow: boolean }[];
  images: number;
  imagesMissingAlt: string[];
  structuredData: { types: string[]; valid: boolean }[];
  renderBlocking: { scripts: string[]; stylesheets: number };
  /** Short paragraphs that consist only of bold text: subheads written as bold instead of <h2>. */
  boldPseudoHeadings: string[];
  paginationRel: { next: string | null; prev: string | null };
}

const clean = (s: string | undefined | null) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t || null;
};

function abs(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

/** Extracts SEO-relevant facts from an HTML document. Never executes scripts. */
export function parseHtml(html: string, pageUrl: string): ParsedHtml {
  const $ = load(html);
  const baseHref = $('base[href]').attr('href');
  const base = (baseHref && abs(baseHref, pageUrl)) || pageUrl;

  const headings = $('h1, h2, h3, h4, h5, h6')
    .toArray()
    .slice(0, 100)
    .map((el) => ({ level: Number(el.tagName.slice(1)), text: clean($(el).text())?.slice(0, 200) ?? '' }));

  const links = $('a[href]')
    .toArray()
    .map((el) => {
      const url = abs($(el).attr('href') ?? '', base);
      return url ? { url, nofollow: /nofollow/i.test($(el).attr('rel') ?? '') } : null;
    })
    .filter((l): l is { url: string; nofollow: boolean } => !!l);

  const imgs = $('img').toArray();
  const imagesMissingAlt = imgs
    // alt="" is correct for decorative images; only a missing attribute is a problem
    .filter((el) => $(el).attr('alt') === undefined && $(el).attr('role') !== 'presentation')
    .map((el) => abs($(el).attr('src') ?? '', base) ?? ($(el).attr('src') ?? '(inline)'))
    .slice(0, 50);

  const structuredData = $('script[type="application/ld+json"]')
    .toArray()
    .map((el) => {
      try {
        const data = JSON.parse($(el).text());
        const items = Array.isArray(data) ? data : data['@graph'] ? data['@graph'] : [data];
        const types = items.flatMap((d: { '@type'?: string | string[] }) => (d?.['@type'] ? [d['@type']].flat() : []));
        return { types: types.map(String).slice(0, 10), valid: true };
      } catch {
        return { types: [], valid: false };
      }
    });

  const head = $('head');
  const renderBlockingScripts = head
    .find('script[src]')
    .toArray()
    .filter((el) => $(el).attr('async') === undefined && $(el).attr('defer') === undefined && $(el).attr('type') !== 'module')
    .map((el) => abs($(el).attr('src') ?? '', base) ?? '');
  const renderBlockingCss = head.find('link[rel="stylesheet"]').toArray().filter((el) => !/print/.test($(el).attr('media') ?? '')).length;

  const boldPseudoHeadings = $('p')
    .toArray()
    .filter((el) => {
      const p = $(el);
      const strong = p.children('strong, b');
      const text = clean(p.text()) ?? '';
      return strong.length === 1 && clean(strong.text()) === text && text.length > 3 && text.length < 80;
    })
    .map((el) => clean($(el).text())!)
    .slice(0, 10);

  // Visible text: drop non-content elements before counting words.
  const body = $('body').clone();
  body.find('script, style, noscript, template, svg, iframe').remove();
  const text = clean(body.text()) ?? '';

  return {
    title: clean($('head > title').first().text() || $('title').first().text()),
    metaDescription: clean($('meta[name="description" i]').attr('content')),
    canonical: (() => {
      const href = $('link[rel="canonical" i]').attr('href');
      return href ? abs(href, base) : null;
    })(),
    robotsMeta: clean($('meta[name="robots" i]').attr('content'))?.toLowerCase() ?? null,
    lang: clean($('html').attr('lang')),
    hasViewport: $('meta[name="viewport" i]').length > 0,
    h1: headings.filter((h) => h.level === 1).map((h) => h.text),
    headings,
    wordCount: text ? text.split(' ').filter((w) => /\p{L}|\p{N}/u.test(w)).length : 0,
    textExcerpt: text.slice(0, 4000),
    links,
    images: imgs.length,
    imagesMissingAlt,
    structuredData,
    renderBlocking: { scripts: renderBlockingScripts, stylesheets: renderBlockingCss },
    boldPseudoHeadings,
    paginationRel: {
      next: (() => { const h = $('link[rel="next" i]').attr('href'); return h ? abs(h, base) : null; })(),
      prev: (() => { const h = $('link[rel="prev" i]').attr('href'); return h ? abs(h, base) : null; })(),
    },
  };
}

/** Extracts <loc> entries from a sitemap or sitemap index. */
export function parseSitemap(xml: string): { valid: boolean; isIndex: boolean; locs: string[] } {
  if (!/<(urlset|sitemapindex)[\s>]/i.test(xml)) return { valid: false, isIndex: false, locs: [] };
  const $ = load(xml, { xml: true });
  const isIndex = $('sitemapindex').length > 0;
  const locs = $('loc')
    .toArray()
    .map((el) => $(el).text().trim())
    .filter(Boolean)
    .slice(0, 5000);
  return { valid: true, isIndex, locs };
}
