import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import {
  LlmOutputError,
  LlmRefusalError,
  addUsage,
  emptyUsage,
  type LlmProvider,
  type LlmUsage,
  type StructuredRequest,
  type ToolCallRecord,
  type ToolLoopRequest,
  type ToolLoopResult,
} from './llm';

/** Server-side refusal fallback: if the model declines, the API re-runs the request on a fallback model. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

function usageOf(model: string, m: Anthropic.Beta.BetaMessage): LlmUsage {
  return {
    model,
    servedBy: m.model,
    inputTokens: m.usage.input_tokens,
    outputTokens: m.usage.output_tokens,
    cacheReadTokens: m.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: m.usage.cache_creation_input_tokens ?? 0,
  };
}

const textOf = (content: Anthropic.Beta.BetaContentBlock[]) =>
  content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

/**
 * Claude implementation of LlmProvider (default model Claude Opus 5.5).
 * - adaptive thinking (the model's default); depth set per feature with output_config.effort
 * - stable system prompt cached with cache_control
 * - refusal fallbacks enabled ("default" routing)
 * - stop_reason checked before using output or running tools
 */
export class ClaudeProvider implements LlmProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey, timeout: 240_000, maxRetries: 2 });
  }

  private system(text: string): Anthropic.Beta.BetaTextBlockParam[] {
    return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
  }

  async structured<T>(req: StructuredRequest<T>): Promise<{ data: T; usage: LlmUsage }> {
    const res = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: req.maxTokens,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      system: this.system(req.system),
      output_config: { effort: req.effort, format: betaZodOutputFormat(req.schema) },
      messages: [{ role: 'user', content: req.prompt }],
    });
    const usage = usageOf(this.model, res);
    if (res.stop_reason === 'refusal') throw new LlmRefusalError(res.stop_details?.category ?? null, usage);
    if (res.stop_reason === 'max_tokens') throw new LlmOutputError('The response was cut off (max_tokens)', usage);
    if (res.parsed_output == null) throw new LlmOutputError('The response did not match the expected format', usage);
    return { data: res.parsed_output as T, usage };
  }

  async toolLoop(req: ToolLoopRequest): Promise<ToolLoopResult> {
    const messages = [...(req.history as Anthropic.Beta.BetaMessageParam[]), { role: 'user' as const, content: req.userMessage }];
    const tools: Anthropic.Beta.BetaTool[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
      strict: true,
    }));
    let usage = emptyUsage(this.model);
    const toolCalls: ToolCallRecord[] = [];

    for (let turn = 0; turn < req.maxTurns; turn++) {
      const res = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 16000,
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
        system: this.system(req.system),
        output_config: { effort: req.effort },
        tools,
        messages,
      });
      usage = addUsage(usage, usageOf(this.model, res));

      if (res.stop_reason === 'refusal') {
        return {
          text: 'I can’t help with that request.',
          history: messages, // the refused turn is not kept
          toolCalls,
          usage,
          refused: true,
        };
      }
      // A turn cut off at max_tokens may carry a truncated tool input: never run it.
      if (res.stop_reason === 'max_tokens') throw new LlmOutputError('The answer was cut off (max_tokens)', usage);

      messages.push({ role: 'assistant', content: res.content });
      if (res.stop_reason === 'pause_turn') continue;

      const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (!uses.length) return { text: textOf(res.content), history: messages, toolCalls, usage, refused: false };

      // Run all tool calls of the turn, then return every result in one user message.
      const results = await Promise.all(
        uses.map(async (u): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
          const started = Date.now();
          const input = (u.input ?? {}) as Record<string, unknown>;
          try {
            const out = await req.execute(u.name, input);
            toolCalls.push({ name: u.name, input, ok: true, ms: Date.now() - started });
            return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) };
          } catch (e) {
            const msg = (e as Error).message.slice(0, 500);
            toolCalls.push({ name: u.name, input, ok: false, error: msg, ms: Date.now() - started });
            return { type: 'tool_result', tool_use_id: u.id, is_error: true, content: msg };
          }
        }),
      );
      messages.push({ role: 'user', content: results });
    }
    throw new LlmOutputError(`No final answer after ${req.maxTurns} tool rounds`, usage);
  }
}
