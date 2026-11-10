export const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
export type UtmKey = (typeof UTM_KEYS)[number];
export type Utm = Partial<Record<UtmKey, string>>;

function tryParse(raw: string | null | undefined, base?: string): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw, base);
  } catch {
    return null;
  }
}

/**
 * Normalises a URL path for reporting:
 * - drops query and hash, collapses duplicate slashes,
 * - removes a trailing slash (except for "/"),
 * - percent-decodes when safe, caps the length.
 * Case is preserved because paths can be case-sensitive.
 */
export function normalizePath(path: string | null | undefined): string {
  if (!path) return '/';
  let p = path.split('#')[0]!.split('?')[0]!;
  try {
    p = decodeURI(p);
  } catch {
    /* keep encoded form */
  }
  p = p.replace(/\/{2,}/g, '/');
  if (!p.startsWith('/')) p = '/' + p;
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p.slice(0, 1024);
}

/**
 * Sanitises a page URL: keeps origin + path and only the utm_* query parameters; drops the hash,
 * credentials and every other query parameter. Returns null for non-http(s) or unparsable input.
 */
export function sanitizeUrl(raw: string | null | undefined): string | null {
  const u = tryParse(raw);
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return null;
  const out = new URL(u.origin + u.pathname);
  for (const k of UTM_KEYS) {
    const v = u.searchParams.get(k);
    if (v) out.searchParams.set(k, v.slice(0, 256));
  }
  return out.toString().slice(0, 2048);
}

/** Referrers keep origin + path only (no query string at all). */
export function sanitizeReferrer(raw: string | null | undefined): string | null {
  const u = tryParse(raw);
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return null;
  return (u.origin + u.pathname).slice(0, 2048);
}

export function hostOf(raw: string | null | undefined): string | null {
  const u = tryParse(raw);
  return u ? normalizeHost(u.hostname) : null;
}

export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

export function extractUtm(raw: string | null | undefined): Utm {
  const u = tryParse(raw);
  const out: Utm = {};
  if (!u) return out;
  for (const k of UTM_KEYS) {
    const v = u.searchParams.get(k);
    if (v) out[k] = v.slice(0, 256);
  }
  return out;
}
