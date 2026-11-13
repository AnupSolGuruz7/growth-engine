import { z } from 'zod';

export const KNOWLEDGE_QUEUE = 'growthos-knowledge';
export const KNOWLEDGE_JOB = 'sync';

export const KNOWLEDGE_STATUSES = ['idle', 'queued', 'syncing', 'ready', 'failed'] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export const upsertKnowledgeSourceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  root_path: z.string().trim().min(2).max(1000),
});
export const knowledgeSearchSchema = z.object({
  q: z.string().trim().min(2).max(500),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

export interface KnowledgeStats {
  files: number;
  documents: number;
  chunks: number;
  tokens: number;
  embedded: number;
  rules: { words: number; claims: number };
  gsc: { queries: number; pages: number; months: number };
  skipped: number;
  duration_ms: number;
}

export interface KnowledgeSourceDto {
  id: string;
  site_id: string;
  name: string;
  root_path: string;
  status: KnowledgeStatus;
  progress: { phase: string; done: number; total: number } | null;
  error: string | null;
  stats: KnowledgeStats | null;
  embedding_model: string | null;
  last_synced_at: string | null;
  created_at: string;
}

export interface KnowledgeDocumentDto {
  path: string;
  title: string;
  chunk_count: number;
  bytes: number;
  modified_at: string | null;
}

export interface KnowledgeResponse {
  source: KnowledgeSourceDto | null;
  documents: KnowledgeDocumentDto[];
  /** Whether the server allows connecting sources (KNOWLEDGE_ALLOWED_ROOTS is set). */
  allowed_roots: string[];
}

/** A retrieved passage. `cite` is the human-readable citation, e.g. "knowledge/brand-facts.md › Pricing". */
export interface KnowledgeHit {
  id: string;
  path: string;
  title: string;
  heading: string;
  cite: string;
  content: string;
  tokens: number;
  score: number;
  match: 'semantic' | 'keyword' | 'both';
}

export interface GscSummaryDto {
  property: string | null;
  query_days: number | null;
  page_days: number | null;
  totals: { queries: number; clicks: number; impressions: number };
  top_queries: { query: string; clicks: number; impressions: number; ctr: number | null; position: number | null }[];
  opportunities: { query: string; clicks: number; impressions: number; ctr: number | null; position: number | null }[];
  top_pages: { page: string; clicks: number; impressions: number; ctr: number | null; position: number | null }[];
  monthly: { month: string; clicks: number; impressions: number }[];
}

/** A content rule from the knowledge source that AI-written text breaks. */
export interface RuleFlagDto {
  rule_id: string;
  kind: 'word' | 'claim';
  severity: 'block' | 'warn';
  quoted: string;
  why: string;
}

export interface SourceRef {
  path: string;
  heading: string;
  cite: string;
}
