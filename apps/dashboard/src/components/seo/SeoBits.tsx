import { CloseCircleFilled, ExclamationCircleFilled, InfoCircleFilled, WarningFilled } from '@ant-design/icons';
import { Tag, Typography } from 'antd';
import type { SeoSeverity } from '@growthos/shared-types';

/** Status palette (reserved, never reused as series colours) — always icon + label, never colour alone. */
const SEV: Record<SeoSeverity, { color: string; bg: string; icon: React.ReactNode; label: string }> = {
  critical: { color: '#b42318', bg: '#fdecec', icon: <CloseCircleFilled />, label: 'Critical' },
  high: { color: '#b54708', bg: '#fdf0e8', icon: <ExclamationCircleFilled />, label: 'High' },
  medium: { color: '#8a5a00', bg: '#fef6e0', icon: <WarningFilled />, label: 'Medium' },
  low: { color: '#52514e', bg: '#f0efec', icon: <InfoCircleFilled />, label: 'Low' },
};

export function SeverityTag({ severity }: { severity: SeoSeverity }) {
  const s = SEV[severity];
  return (
    <Tag bordered={false} icon={s.icon} style={{ color: s.color, background: s.bg, fontWeight: 500 }}>
      {s.label}
    </Tag>
  );
}

export const CATEGORY_LABEL: Record<string, string> = {
  technical: 'Technical',
  'on-page': 'On-page',
  performance: 'Performance',
  search: 'Search',
};

/** Plain-language name of each check, used to group findings by issue type. */
export const CHECK_LABEL: Record<string, string> = {
  robots_missing: 'No robots.txt',
  robots_blocks_all: 'robots.txt blocks the whole site',
  sitemap_missing: 'No XML sitemap',
  sitemap_invalid: 'Sitemap is not valid XML',
  http_not_redirected: 'HTTP is not redirected to HTTPS',
  no_https: 'Site is not available over HTTPS',
  host_variant_duplicate: 'www and non-www both serve the site',
  canonical_other_domain: 'Canonical tags point to another domain',
  fetch_failed: 'Pages that could not be fetched',
  http_error: 'Pages returning errors (4xx/5xx)',
  redirect_chain: 'Redirect chains',
  noindex_in_sitemap: 'Sitemap lists noindex pages',
  noindex: 'Pages set to noindex',
  sitemap_url_error: 'Sitemap lists URLs that do not return 200',
  broken_internal_links: 'Broken internal links',
  insecure_internal_links: 'Internal links using http://',
  canonical_target_error: 'Canonical points to a redirect or error',
  paginated_canonical: 'Paginated pages canonicalise to page 1',
  canonical_elsewhere: 'Pages canonicalise to another URL',
  js_rendered_content: 'Content rendered by JavaScript',
  canonical_missing: 'Missing canonical tag',
  missing_viewport: 'Missing mobile viewport tag',
  title_missing: 'Missing page title',
  title_length: 'Title too short or too long',
  title_duplicate: 'Duplicate titles',
  meta_description_missing: 'Missing meta description',
  meta_description_length: 'Meta description too short or too long',
  meta_description_duplicate: 'Duplicate meta descriptions',
  h1_missing: 'Missing H1 heading',
  h1_multiple: 'More than one H1',
  heading_skip: 'Heading levels skipped',
  bold_as_heading: 'Bold text used as headings',
  images_missing_alt: 'Images without alt text',
  structured_data_invalid: 'Invalid structured data',
  structured_data_missing: 'No structured data on the homepage',
  thin_content: 'Thin content',
  test_page: 'Test or placeholder pages',
  orphan_page: 'Orphan pages (no internal links)',
  slow_response: 'Slow server response',
  render_blocking: 'Render-blocking resources',
  large_html: 'Very large HTML',
  trailing_slash_duplicate: 'Same page with and without trailing slash',
  cwv_lcp: 'Largest Contentful Paint (Core Web Vital)',
  cwv_cls: 'Layout shift (Core Web Vital)',
  cwv_inp: 'Interaction delay (Core Web Vital)',
};

export function scoreBand(score: number): { label: string; color: string } {
  if (score >= 90) return { label: 'Good', color: '#0a7d0a' };
  if (score >= 70) return { label: 'Needs work', color: '#8a5a00' };
  return { label: 'Poor', color: '#b42318' };
}

export const shortUrl = (u: string) => {
  try {
    const x = new URL(u);
    return x.pathname + x.search;
  } catch {
    return u;
  }
};

/** Renders a finding's evidence object as a readable definition list. */
export function Evidence({ value }: { value: Record<string, unknown> }) {
  // null means 'not present on the page' (e.g. a missing title) — show that instead of hiding it
  const entries = Object.entries(value).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length));
  if (!entries.length) return <Typography.Text type="secondary">See the page itself — this check looks at the whole page.</Typography.Text>;
  return (
    <dl className="evidence">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt>{k.replace(/_/g, ' ')}</dt>
          <dd>
            {v === null ? (
              <i>missing</i>
            ) : Array.isArray(v) ? (
              <ul>
                {v.slice(0, 20).map((x, i) => (
                  <li key={i}>
                    <code>{typeof x === 'object' ? JSON.stringify(x) : String(x)}</code>
                  </li>
                ))}
              </ul>
            ) : typeof v === 'object' ? (
              <code>{JSON.stringify(v)}</code>
            ) : (
              <code>{String(v)}</code>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** How the page may look as a Google result (title ~60 chars, description ~160). */
export function SerpPreview({ url, title, description }: { url: string; title: string | null; description: string | null }) {
  const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
  let crumb = url;
  try {
    const u = new URL(url);
    crumb = [u.hostname, ...u.pathname.split('/').filter(Boolean)].join(' › ');
  } catch {
    /* keep */
  }
  return (
    <div className="serp" aria-label="Search result preview">
      <div className="serp-url">{crumb}</div>
      <div className="serp-title">{title ? cut(title, 60) : <i>(no title — search engines will invent one)</i>}</div>
      <div className="serp-desc">{description ? cut(description, 160) : <i>(no meta description — a snippet will be taken from the page)</i>}</div>
    </div>
  );
}
