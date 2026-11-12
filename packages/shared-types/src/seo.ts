import { z } from 'zod';

export const SEO_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type SeoSeverity = (typeof SEO_SEVERITIES)[number];

export const SEO_CATEGORIES = ['technical', 'on-page', 'performance', 'search'] as const;
export type SeoCategory = (typeof SEO_CATEGORIES)[number];

export type SeoAuditStatus = 'queued' | 'running' | 'completed' | 'failed';

export const SEO_QUEUE = 'growthos-seo';
export const SEO_JOB = 'audit';

export const createAuditSchema = z.object({
  site_id: z.string().uuid(),
  /** Optional start URL; must be on the site's host. Defaults to https://<domain>/. */
  start_url: z.string().url().max(2048).optional(),
  max_pages: z.coerce.number().int().min(1).max(500).optional(),
});
export type CreateAuditInput = z.input<typeof createAuditSchema>;

export const findingsQuerySchema = z.object({
  severity: z.enum(SEO_SEVERITIES).optional(),
  category: z.enum(SEO_CATEGORIES).optional(),
  check_id: z.string().max(64).optional(),
  url: z.string().max(2048).optional(),
});

export interface SeoAuditSummary {
  by_severity: Record<SeoSeverity, number>;
  by_category: Record<SeoCategory, number>;
  pages: { crawled: number; indexable: number; errors: number; blocked_by_robots: number; redirects: number };
  robots: { found: boolean; status: number | null; sitemaps: string[] };
  sitemap: { url: string | null; found: boolean; valid: boolean; urls: number };
  pagespeed: { tested: number; skipped_reason: string | null };
}

export interface SeoAuditDto {
  id: string;
  site_id: string;
  status: SeoAuditStatus;
  start_url: string;
  max_pages: number;
  pages_crawled: number;
  score: number | null;
  summary: SeoAuditSummary | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  /** The previous completed audit of the same site, for comparison. */
  previous_audit_id: string | null;
  comparison: SeoComparisonCounts | null;
}

export interface SeoFindingDto {
  id: string;
  url: string;
  category: SeoCategory;
  check_id: string;
  severity: SeoSeverity;
  title: string;
  evidence: Record<string, unknown>;
  explanation: string;
  suggested_fix: string;
  confidence: number;
  effort: number;
  limits: string | null;
  pageviews_28d: number;
  priority: number;
  fingerprint: string;
  /** Present when the audit is compared with a previous one. */
  change?: 'new' | 'unchanged';
}

export interface SeoPageRow {
  url: string;
  path: string;
  status: number | null;
  title: string | null;
  meta_description: string | null;
  h1: string[];
  word_count: number | null;
  inlinks: number;
  indexable: boolean;
  in_sitemap: boolean;
  response_ms: number | null;
  pageviews_28d: number;
  findings: number;
}

export interface SeoPageDetail extends SeoPageRow {
  depth: number;
  final_url: string | null;
  redirect_chain: { url: string; status: number }[];
  content_type: string | null;
  bytes: number | null;
  fetch_error: string | null;
  blocked_by_robots: boolean;
  canonical: string | null;
  robots_meta: string | null;
  x_robots_tag: string | null;
  lang: string | null;
  headings: { level: number; text: string }[];
  internal_links: number;
  external_links: number;
  images: number;
  images_missing_alt: number;
  structured_data: { types: string[]; valid: boolean }[];
  render_blocking: number;
  issues: SeoFindingDto[];
}

export interface SeoComparisonCounts {
  new: number;
  resolved: number;
  unchanged: number;
}

export interface SeoComparisonDto {
  audit_id: string;
  previous_audit_id: string;
  counts: SeoComparisonCounts;
  new: SeoFindingDto[];
  resolved: SeoFindingDto[];
}
