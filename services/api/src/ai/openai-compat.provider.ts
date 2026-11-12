import * as z from 'zod/v4';
import {
  LlmOutputError,
  LlmRefusalError,
  addUsage,
  emptyUsage,
  type Effort,
  type LlmProvider,
  type LlmUsage,
  type StructuredRequest,
  type ToolCallRecord,
  type ToolLoopRequest,
  type ToolLoopResult,
} from './llm';

/** Providers that speak the OpenAI chat-completions protocol. */
export const OPENAI_COMPAT_PROVIDERS = {
  groq: { baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'openai/gpt-oss-120b', label: 'Groq' },
  xai: { baseUrl: 'https://api.x.ai/v1', defaultModel: 'grok-4', label: 'xAI' },
} as const;
export type OpenAiCompatName = keyof typeof OPENAI_COMPAT_PROVIDERS;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface ChatResponse {
  model: string;
  choices: { finish_reason: string; message: ChatMessage }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** "7.66s", "1m30s", "250ms" or seconds as a number → milliseconds. */
export function parseResetMs(v: string | null): number | null {
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v) * 1000;
  let ms = 0;
  for (const [, n, unit] of v.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)) {
    ms += Number(n) * (unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000);
  }
  return ms || null;
}

/** zod v4 schema → JSON Schema accepted by strict structured outputs ($schema removed). */
export function toStrictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

/**
 * LlmProvider for OpenAI-compatible APIs (Groq, xAI Grok). Same contract as ClaudeProvider:
 * schema-validated structured output (one corrective retry), a tool loop that checks the finish
 * reason before running tools, and token usage for the budget. Rate limits (429) are waited out
 * using the provider's reset headers, which matters on free tiers with small per-minute budgets.
 */
export class OpenAiCompatProvider implements LlmProvider {
  private readonly baseUrl: string;

  constructor(
    readonly name: OpenAiCompatName,
    private readonly apiKey: string,
    readonly model: string,
    private readonly opts: { maxRateLimitWaitMs?: number; fetchImpl?: typeof fetch; baseUrl?: string } = {},
  ) {
    this.baseUrl = opts.baseUrl ?? OPENAI_COMPAT_PROVIDERS[name].baseUrl;
  }

  /** gpt-oss / Grok reasoning models take a reasoning effort; others ignore it. */
  private reasoning(effort: Effort): Record<string, unknown> {
    return /gpt-oss|grok-3-mini/.test(this.model) ? { reasoning_effort: effort } : {};
  }

  private async chat(body: Record<string, unknown>): Promise<ChatResponse> {
    const f = this.opts.fetchImpl ?? fetch;
    const deadline = Date.now() + (this.opts.maxRateLimitWaitMs ?? 120_000);
    for (let attempt = 0; ; attempt++) {
      const res = await f(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, ...body }),
        signal: AbortSignal.timeout(180_000),
      });
      if (res.ok) return (await res.json()) as ChatResponse;
      const text = await res.text();
      let message = text.slice(0, 300);
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
      } catch {
        /* keep text */
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < 4) {
        const wait =
          parseResetMs(res.headers.get('retry-after')) ??
          parseResetMs(res.headers.get('x-ratelimit-reset-tokens')) ??
          2000 * 2 ** attempt;
        if (Date.now() + wait < deadline) {
          await sleep(Math.min(wait + 250, 65_000));
          continue;
        }
      }
      if (res.status === 413 || /too large|context length|maximum context/i.test(message)) {
        throw new ProviderHttpError(res.status, `The request is too large for this model or plan: ${message}`);
      }
      if (res.status === 429) throw new ProviderHttpError(429, `Rate limited by ${OPENAI_COMPAT_PROVIDERS[this.name].label}: ${message}`);
      throw new ProviderHttpError(res.status, `${OPENAI_COMPAT_PROVIDERS[this.name].label} API error ${res.status}: ${message}`);
    }
  }

  private usageOf(r: ChatResponse): LlmUsage {
    const cached = r.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      model: this.model,
      servedBy: r.model || this.model,
      inputTokens: (r.usage?.prompt_tokens ?? 0) - cached,
      outputTokens: r.usage?.completion_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    };
  }

  async structured<T>(req: StructuredRequest<T>): Promise<{ data: T; usage: LlmUsage }> {
    const messages: ChatMessage[] = [
      { role: 'system', content: req.system },
      { role: 'user', content: req.prompt },
    ];
    let usage = emptyUsage(this.model);
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.chat({
        messages,
        max_completion_tokens: req.maxTokens,
        response_format: { type: 'json_schema', json_schema: { name: 'output', strict: true, schema: toStrictJsonSchema(req.schema) } },
        ...this.reasoning(req.effort),
      });
      usage = addUsage(usage, this.usageOf(r));
      const choice = r.choices[0];
      if (!choice) throw new LlmOutputError('Empty response', usage);
      if (choice.finish_reason === 'content_filter') throw new LlmRefusalError('content_filter', usage);
      if (choice.finish_reason === 'length') throw new LlmOutputError('The response was cut off (max tokens)', usage);
      const content = choice.message.content ?? '';
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        parsed = undefined;
      }
      const check = req.schema.safeParse(parsed);
      if (check.success) return { data: check.data, usage };
      // one corrective retry: show the model what was wrong
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: `That output does not match the required JSON schema: ${check.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}. Return only corrected JSON.`,
      });
    }
    throw new LlmOutputError('The response did not match the expected format', usage);
  }

  async toolLoop(req: ToolLoopRequest): Promise<ToolLoopResult> {
    const history = req.history as ChatMessage[];
    const messages: ChatMessage[] = [...history, { role: 'user', content: req.userMessage }];
    const tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    let usage = emptyUsage(this.model);
    const toolCalls: ToolCallRecord[] = [];

    for (let turn = 0; turn < req.maxTurns; turn++) {
      const r = await this.chat({
        messages: [{ role: 'system', content: req.system }, ...messages],
        tools,
        tool_choice: 'auto',
        max_completion_tokens: 4096,
        ...this.reasoning(req.effort),
      });
      usage = addUsage(usage, this.usageOf(r));
      const choice = r.choices[0];
      if (!choice) throw new LlmOutputError('Empty response', usage);
      if (choice.finish_reason === 'content_filter') {
        return { text: 'I can’t help with that request.', history: messages, toolCalls, usage, refused: true };
      }
      // never run tools from a turn that was cut off
      if (choice.finish_reason === 'length') throw new LlmOutputError('The answer was cut off (max tokens)', usage);

      const msg = choice.message;
      const calls = msg.tool_calls ?? [];
      // keep only protocol fields (drops provider extras such as reasoning text)
      messages.push({ role: 'assistant', content: msg.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) });
      if (!calls.length) return { text: (msg.content ?? '').trim(), history: messages, toolCalls, usage, refused: false };

      for (const c of calls) {
        const started = Date.now();
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(c.function.arguments || '{}');
          const out = await req.execute(c.function.name, input);
          toolCalls.push({ name: c.function.name, input, ok: true, ms: Date.now() - started });
          messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify(out) });
        } catch (e) {
          const err = (e as Error).message.slice(0, 500);
          toolCalls.push({ name: c.function.name, input, ok: false, error: err, ms: Date.now() - started });
          messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ error: err }) });
        }
      }
    }
    throw new LlmOutputError(`No final answer after ${req.maxTurns} tool rounds`, usage);
  }
}
