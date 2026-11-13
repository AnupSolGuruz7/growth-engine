/**
 * Google Search Console exports found in a knowledge source, recognised by shape (not by filename):
 *   { source: "gsc", keywords: [{keyword, clicks, impressions, position}] }        -> queries
 *   { source: "gsc", pages: [{page, clicks, impressions, ctr, position}], days }   -> pages
 *   [ { month: "2025-05", clicks, impressions, pages } ]                             -> monthly
 */
export interface GscQueryRow { query: string; clicks: number; impressions: number; ctr: number | null; position: number | null }
export interface GscPageRow { page: string; clicks: number; impressions: number; ctr: number | null; position: number | null }
export interface GscMonthRow { month: string; clicks: number; impressions: number; pages: number | null }

export type GscExport =
  | { kind: 'queries'; days: number | null; property: string | null; rows: GscQueryRow[] }
  | { kind: 'pages'; days: number | null; property: string | null; rows: GscPageRow[] }
  | { kind: 'monthly'; days: null; property: null; rows: GscMonthRow[] };

/** Exports can repeat a key (e.g. a query differing only in case upstream); keep the first. */
function uniqueBy<T>(rows: T[], key: (r: T) => string): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(key(r)) ? false : (seen.add(key(r)), true)));
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const daysFromName = (file: string) => {
  const m = file.match(/(\d{1,3})d\b/);
  return m ? Number(m[1]) : null;
};

export function parseGscExport(json: unknown, file: string): GscExport | null {
  if (Array.isArray(json)) {
    const rows = json
      .filter((r) => r && typeof r === 'object' && /^\d{4}-\d{2}$/.test(String((r as { month?: unknown }).month)))
      .map((r) => {
        const x = r as Record<string, unknown>;
        return { month: String(x.month), clicks: num(x.clicks) ?? 0, impressions: num(x.impressions) ?? 0, pages: num(x.pages) };
      });
    return rows.length && rows.length === json.length ? { kind: 'monthly', days: null, property: null, rows: uniqueBy(rows, (r) => r.month) } : null;
  }
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  if (o.source !== 'gsc') return null;
  const days = num(o.days) ?? daysFromName(file);
  const property = typeof o.property === 'string' ? o.property : null;
  if (Array.isArray(o.keywords)) {
    const rows = o.keywords
      .map((r) => r as Record<string, unknown>)
      .filter((r) => typeof r.keyword === 'string')
      .map((r) => {
        const clicks = num(r.clicks) ?? 0;
        const impressions = num(r.impressions) ?? 0;
        return { query: String(r.keyword).slice(0, 300), clicks, impressions, ctr: num(r.ctr) ?? (impressions ? clicks / impressions : null), position: num(r.position) };
      });
    return { kind: 'queries', days, property, rows: uniqueBy(rows, (r) => r.query) };
  }
  if (Array.isArray(o.pages)) {
    const rows = o.pages
      .map((r) => r as Record<string, unknown>)
      .filter((r) => typeof r.page === 'string')
      .map((r) => {
        const clicks = num(r.clicks) ?? 0;
        const impressions = num(r.impressions) ?? 0;
        return { page: String(r.page).slice(0, 2000), clicks, impressions, ctr: num(r.ctr) ?? (impressions ? clicks / impressions : null), position: num(r.position) };
      });
    return { kind: 'pages', days, property, rows: uniqueBy(rows, (r) => r.page) };
  }
  return null;
}
