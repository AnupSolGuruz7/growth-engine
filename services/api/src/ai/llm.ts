import type * as z from 'zod/v4';

/**
 * Provider-agnostic LLM interface (spec §8.4: providers are swappable). The rest of the app only
 * talks to this; ClaudeProvider is the production implementation and tests use a scripted fake.
 */
export type Effort = 'low' | 'medium' | 'high';

export interface LlmUsage {
  model: string;
  /** The model that actually answered (differs when a refusal fallback served the request). */
  servedBy: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface StructuredRequest<T> {
  /** Stable instructions (cached by providers that support prompt caching). */
  system: string;
  /** Per-request content. Untrusted data must already be wrapped in tagged blocks. */
  prompt: string;
  schema: z.ZodType<T>;
  effort: Effort;
  maxTokens: number;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema; every property required, optional ones typed as nullable (strict tool use). */
  inputSchema: Record<string, unknown>;
}

export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  ok: boolean;
  error?: string;
  ms: number;
}

export interface ToolLoopRequest {
  system: string;
  /** Provider-native message history from earlier turns (stored as-is, appended to only). */
  history: unknown[];
  userMessage: string;
  tools: ToolSpec[];
  /** Executes a tool call. Throwing marks the result as an error for the model. */
  execute: (name: string, input: Record<string, unknown>) => Promise<unknown>;
  effort: Effort;
  maxTurns: number;
}

export interface ToolLoopResult {
  text: string;
  history: unknown[];
  toolCalls: ToolCallRecord[];
  usage: LlmUsage;
  refused: boolean;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  structured<T>(req: StructuredRequest<T>): Promise<{ data: T; usage: LlmUsage }>;
  toolLoop(req: ToolLoopRequest): Promise<ToolLoopResult>;
}

/** The model declined the request (safety classifiers). Not retried. */
export class LlmRefusalError extends Error {
  constructor(
    readonly category: string | null,
    readonly usage?: LlmUsage,
  ) {
    super(`The model declined this request${category ? ` (${category})` : ''}`);
  }
}

export class LlmOutputError extends Error {
  constructor(
    message: string,
    readonly usage?: LlmUsage,
  ) {
    super(message);
  }
}

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

export const emptyUsage = (model: string): LlmUsage => ({
  model,
  servedBy: model,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    model: a.model,
    servedBy: b.servedBy || a.servedBy,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/**
 * USD per million tokens. Unknown models are priced like Claude Opus 5.5 (conservative for budgets).
 * Groq rows are approximate list prices (free-tier keys are not billed at all); override with
 * AI_PRICE_INPUT_PER_MTOK / AI_PRICE_OUTPUT_PER_MTOK.
 */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'openai/gpt-oss-120b': { input: 0.15, output: 0.75, cacheRead: 0.075, cacheWrite: 0 },
  'openai/gpt-oss-20b': { input: 0.1, output: 0.5, cacheRead: 0.05, cacheWrite: 0 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

/** Lets config override the price of the active model. */
export function setPriceOverride(model: string, input: number | null, output: number | null): void {
  if (input === null || output === null) return;
  PRICES[model] = { input, output, cacheRead: input / 2, cacheWrite: input };
}

export function costUsd(u: LlmUsage): number {
  const p = PRICES[u.servedBy] ?? PRICES[u.model] ?? PRICES['claude-opus-5-5']!;
  return (
    (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite) /
    1_000_000
  );
}
