import { HttpException, HttpStatus, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { APP_CONFIG, type AppConfig } from '../config';
import { LLM_PROVIDER, costUsd, type LlmProvider, type LlmUsage, type ToolCallRecord } from './llm';

export type AiKind = 'suggestions' | 'ask' | 'draft';

interface Scope {
  organization_id: string;
  id: string;
}

/**
 * Audit trail + guard rails for every model call (spec §8.4): monthly cost budget per site,
 * daily Ask AI limit, and a log row for each call and tool call.
 */
@Injectable()
export class AiUsageService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider | null,
  ) {}

  /** The provider, or a 503 explaining how to enable AI. */
  provider(): LlmProvider {
    if (!this.llm) {
      throw new ServiceUnavailableException({
        error: 'ai_not_configured',
        message: 'AI is not configured: set ANTHROPIC_API_KEY in .env and restart the API.',
      });
    }
    return this.llm;
  }

  get configured(): boolean {
    return !!this.llm;
  }

  async monthSpend(siteId: string): Promise<number> {
    const [r] = await this.ds.query(
      `SELECT COALESCE(sum(cost_usd), 0)::float AS usd FROM ai_calls
       WHERE site_id = $1 AND created_at >= date_trunc('month', now())`,
      [siteId],
    );
    return Number(r.usd);
  }

  async asksToday(siteId: string): Promise<number> {
    const [r] = await this.ds.query(
      `SELECT count(*)::int AS n FROM ai_calls WHERE site_id = $1 AND kind = 'ask' AND created_at > now() - interval '24 hours'`,
      [siteId],
    );
    return r.n;
  }

  /** Throws 429 when the site is over its monthly AI budget or the daily Ask AI limit. */
  async assertAllowed(site: Scope, kind: AiKind): Promise<void> {
    const spent = await this.monthSpend(site.id);
    if (spent >= this.cfg.aiMonthlyBudgetUsd) {
      throw new HttpException(
        { error: 'ai_budget_exceeded', message: `This site has used its AI budget for the month ($${this.cfg.aiMonthlyBudgetUsd}).`, used_usd: spent },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (kind === 'ask' && (await this.asksToday(site.id)) >= this.cfg.aiAskDailyLimit) {
      throw new HttpException(
        { error: 'ai_daily_limit', message: `Ask AI is limited to ${this.cfg.aiAskDailyLimit} questions per site per day.` },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  async record(
    site: Scope,
    kind: AiKind,
    usage: LlmUsage | undefined,
    status: 'ok' | 'error' | 'refused',
    ms: number,
    refId: string | null,
    error?: string,
  ): Promise<void> {
    const u = usage ?? { model: this.llm?.model ?? 'unknown', servedBy: '', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    await this.ds.query(
      `INSERT INTO ai_calls (organization_id, site_id, kind, model, served_by, status, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, error, ref_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        site.organization_id, site.id, kind, u.model, u.servedBy || null, status, u.inputTokens, u.outputTokens,
        u.cacheReadTokens, u.cacheWriteTokens, costUsd(u), ms, error?.slice(0, 500) ?? null, refId,
      ],
    );
  }

  async recordTools(site: Scope, conversationId: string | null, calls: ToolCallRecord[]): Promise<void> {
    for (const c of calls) {
      await this.ds.query(
        `INSERT INTO ai_tool_calls (organization_id, site_id, conversation_id, tool, input, ok, error, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [site.organization_id, site.id, conversationId, c.name, JSON.stringify(c.input), c.ok, c.error ?? null, c.ms],
      );
    }
  }
}
