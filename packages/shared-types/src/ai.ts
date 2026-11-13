import { z } from 'zod';
import type { RuleFlagDto, SourceRef } from './knowledge';

export const SUGGESTION_STATUSES = ['new', 'accepted', 'dismissed', 'done'] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];
export type SuggestionArea = 'seo' | 'content' | 'marketing';
export type Level = 'high' | 'medium' | 'low';

export const generateSuggestionsSchema = z.object({ site_id: z.string().uuid() });
export const updateSuggestionSchema = z.object({ status: z.enum(SUGGESTION_STATUSES) });
export const askSchema = z.object({
  site_id: z.string().uuid(),
  question: z.string().trim().min(2).max(2000),
  conversation_id: z.string().uuid().optional(),
});
export const draftSchema = z.object({ regenerate: z.boolean().optional() });

/** One verified fact a suggestion relies on. `link` is computed server-side, never taken from the model. */
export interface EvidenceItem {
  ref: string;
  value: number | string;
  label: string;
  link: string;
}

export interface MeasurementResult {
  window_days: number;
  before: number | null;
  after: number | null;
  /** Days of data available after the change (results are partial until it reaches window_days). */
  after_days: number;
  change: number | null;
}

export interface SuggestionDto {
  id: string;
  run_id: string;
  title: string;
  area: SuggestionArea;
  evidence: EvidenceItem[];
  action: string;
  copy: string | null;
  expected_outcome: string;
  assumptions: string | null;
  priority: Level;
  effort: Level;
  confidence: Level;
  measurement: { metric_ref: string; label: string; direction: 'increase' | 'decrease'; window_days: number; baseline: number | string };
  status: SuggestionStatus;
  status_changed_at: string | null;
  done_at: string | null;
  created_at: string;
  /** Before/after comparison of the measurement metric, once marked done. */
  result: MeasurementResult | null;
  /** Knowledge-base passages the suggestion draws on (verified to exist). */
  sources: SourceRef[];
  /** Content rules from the knowledge source that this suggestion's text breaks. */
  rule_flags: RuleFlagDto[];
}

export interface SuggestionRunDto {
  id: string;
  status: 'running' | 'completed' | 'failed';
  range_from: string;
  range_to: string;
  accepted: number;
  dropped: { title: string; reason: string }[];
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface SuggestionsResponse {
  suggestions: SuggestionDto[];
  latest_run: SuggestionRunDto | null;
}

export interface AiStatusDto {
  configured: boolean;
  provider: string | null;
  model: string | null;
  budget: { month: string; used_usd: number; limit_usd: number };
  asks_today: number;
  ask_daily_limit: number;
}

export interface AskTurn {
  role: 'user' | 'assistant';
  text: string;
  at: string;
  /** Tools the assistant used to answer (names + date ranges), for transparency. */
  tools?: { name: string; input: Record<string, unknown> }[];
  /** Knowledge-base passages the assistant retrieved while answering. */
  sources?: SourceRef[];
  /** Content rules from the knowledge source that the answer breaks. */
  rule_flags?: RuleFlagDto[];
}

export interface ConversationDto {
  id: string;
  title: string;
  transcript: AskTurn[];
  created_at: string;
  updated_at: string;
}

export interface DraftDto {
  finding_id: string;
  drafts: { field: string; value: string; note: string; length: number }[];
  caution: string | null;
  /** Content rules broken by the drafted copy (per draft index). */
  rule_flags?: { index: number; flags: RuleFlagDto[] }[];
  /** Knowledge passages given to the model as brand context. */
  sources?: SourceRef[];
  created_at: string;
}

/** Checks for which the AI can draft ready-to-paste copy. */
export const DRAFTABLE_CHECKS = [
  'title_missing', 'title_length', 'title_duplicate', 'meta_description_missing', 'meta_description_length',
  'meta_description_duplicate', 'h1_missing', 'h1_multiple', 'images_missing_alt', 'bold_as_heading',
  'structured_data_missing', 'thin_content',
] as const;
