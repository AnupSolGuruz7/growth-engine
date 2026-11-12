import * as z from 'zod/v4';
import { OpenAiCompatProvider, parseResetMs, toStrictJsonSchema } from '../src/ai/openai-compat.provider';

type Reply = { status?: number; headers?: Record<string, string>; body: unknown };

/** fetch stand-in: returns scripted replies in order and records request bodies. */
function scripted(replies: Reply[]) {
  const bodies: Record<string, any>[] = [];
  const impl = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    const r = replies.shift()!;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  return { impl, bodies };
}

const ok = (message: Record<string, unknown>, finish = 'stop') => ({
  body: { model: 'openai/gpt-oss-120b', choices: [{ finish_reason: finish, message: { role: 'assistant', ...message } }], usage: { prompt_tokens: 100, completion_tokens: 20 } },
});

describe('OpenAiCompatProvider (Groq / xAI)', () => {
  const Schema = z.object({ items: z.array(z.object({ name: z.string(), note: z.string().nullable() })) });

  it('sends strict JSON-schema output requests and validates the result', async () => {
    const { impl, bodies } = scripted([ok({ content: '{"items":[{"name":"a","note":null}]}' })]);
    const p = new OpenAiCompatProvider('groq', 'k', 'openai/gpt-oss-120b', { fetchImpl: impl });
    const r = await p.structured({ system: 'sys', prompt: 'go', schema: Schema, effort: 'low', maxTokens: 500 });
    expect(r.data).toEqual({ items: [{ name: 'a', note: null }] });
    expect(r.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, model: 'openai/gpt-oss-120b' });
    expect(bodies[0]).toMatchObject({
      model: 'openai/gpt-oss-120b',
      reasoning_effort: 'low',
      response_format: { type: 'json_schema', json_schema: { strict: true, schema: { type: 'object', additionalProperties: false } } },
    });
    expect(bodies[0]!.response_format.json_schema.schema.$schema).toBeUndefined();
  });

  it('retries once with the validation error when the JSON does not match', async () => {
    const { impl, bodies } = scripted([ok({ content: '{"items":[{"name":1}]}' }), ok({ content: '{"items":[]}' })]);
    const p = new OpenAiCompatProvider('groq', 'k', 'openai/gpt-oss-120b', { fetchImpl: impl });
    const r = await p.structured({ system: 's', prompt: 'p', schema: Schema, effort: 'low', maxTokens: 500 });
    expect(r.data).toEqual({ items: [] });
    expect(r.usage.inputTokens).toBe(200); // both attempts are billed
    expect(bodies[1]!.messages.at(-1).content).toMatch(/does not match the required JSON schema/);
  });

  it('waits out a 429 using the reset header, then succeeds', async () => {
    const { impl } = scripted([
      { status: 429, headers: { 'retry-after': '0.05' }, body: { error: { message: 'Rate limit reached for tokens per minute' } } },
      ok({ content: '{"items":[]}' }),
    ]);
    const p = new OpenAiCompatProvider('groq', 'k', 'openai/gpt-oss-120b', { fetchImpl: impl });
    await expect(p.structured({ system: 's', prompt: 'p', schema: Schema, effort: 'low', maxTokens: 50 })).resolves.toBeTruthy();
  });

  it('reports a request that is too large for the plan clearly', async () => {
    const { impl } = scripted([{ status: 413, body: { error: { message: 'Request too large for model on tokens per minute (TPM): Limit 8000' } } }]);
    const p = new OpenAiCompatProvider('groq', 'k', 'm', { fetchImpl: impl });
    await expect(p.structured({ system: 's', prompt: 'p', schema: Schema, effort: 'low', maxTokens: 50 })).rejects.toThrow(/too large for this model or plan/);
  });

  it('runs a tool loop: executes tool calls, returns results, stops at the final answer', async () => {
    const { impl, bodies } = scripted([
      ok({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_overview', arguments: '{"from":null,"to":null}' } }] }, 'tool_calls'),
      ok({ content: 'Sessions were 42.' }),
    ]);
    const p = new OpenAiCompatProvider('groq', 'k', 'openai/gpt-oss-120b', { fetchImpl: impl });
    const executed: string[] = [];
    const r = await p.toolLoop({
      system: 'sys', history: [], userMessage: 'How many sessions?', effort: 'medium', maxTurns: 4,
      tools: [{ name: 'get_overview', description: 'd', inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
      execute: async (name) => {
        executed.push(name);
        return { sessions: 42 };
      },
    });
    expect(executed).toEqual(['get_overview']);
    expect(r).toMatchObject({ text: 'Sessions were 42.', refused: false, toolCalls: [{ name: 'get_overview', ok: true }] });
    expect(bodies[0]!.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(bodies[1]!.messages.at(-1)).toEqual({ role: 'tool', tool_call_id: 'c1', content: '{"sessions":42}' });
    // stored history excludes the system prompt and keeps only protocol fields
    expect(r.history.map((m: any) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('never runs tools from a truncated turn', async () => {
    const { impl } = scripted([
      ok({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{"fr' } }] }, 'length'),
    ]);
    const p = new OpenAiCompatProvider('groq', 'k', 'm', { fetchImpl: impl });
    const exec = jest.fn();
    await expect(
      p.toolLoop({ system: 's', history: [], userMessage: 'q', effort: 'low', maxTurns: 2, tools: [], execute: exec }),
    ).rejects.toThrow(/cut off/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('parses reset durations', () => {
    expect(parseResetMs('7.66s')).toBe(7660);
    expect(parseResetMs('1m30s')).toBe(90_000);
    expect(parseResetMs('250ms')).toBe(250);
    expect(parseResetMs('2')).toBe(2000);
    expect(parseResetMs(null)).toBeNull();
    expect(toStrictJsonSchema(z.object({ a: z.string() }))).toEqual({
      type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false,
    });
  });
});
