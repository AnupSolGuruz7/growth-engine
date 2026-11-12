import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { askSchema, draftSchema, generateSuggestionsSchema, updateSuggestionSchema, type AiStatusDto } from '@growthos/shared-types';
import { Tenant, type TenantContext } from '../common/tenant';
import { parseOrThrow } from '../common/zod';
import { APP_CONFIG, type AppConfig } from '../config';
import { SitesService } from '../sites/sites.service';
import { AskService } from './ask.service';
import { DraftsService } from './drafts.service';
import { SuggestionsService } from './suggestions.service';
import { AiUsageService } from './usage.service';

const siteQuery = z.object({ site_id: z.string().uuid() });

@Controller('v1')
export class AiController {
  constructor(
    private readonly suggestions: SuggestionsService,
    private readonly askAi: AskService,
    private readonly drafts: DraftsService,
    private readonly usage: AiUsageService,
    private readonly sites: SitesService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  /** Whether AI is configured, plus this month's spend against the budget. */
  @Get('ai/status')
  async status(@Tenant() t: TenantContext, @Query() q: unknown): Promise<AiStatusDto> {
    const site = await this.sites.getOwned(t, parseOrThrow(siteQuery, q).site_id);
    const llm = this.usage.configured ? this.usage.provider() : null;
    return {
      configured: !!llm,
      provider: llm?.name ?? null,
      model: llm?.model ?? null,
      budget: {
        month: new Date().toISOString().slice(0, 7),
        used_usd: Math.round((await this.usage.monthSpend(site.id)) * 100) / 100,
        limit_usd: this.cfg.aiMonthlyBudgetUsd,
      },
      asks_today: await this.usage.asksToday(site.id),
      ask_daily_limit: this.cfg.aiAskDailyLimit,
    };
  }

  @Get('suggestions')
  list(@Tenant() t: TenantContext, @Query() q: unknown) {
    return this.suggestions.list(t, parseOrThrow(siteQuery, q).site_id);
  }

  /** Starts generation in the background; poll GET /v1/suggestions for latest_run.status. */
  @Post('suggestions/generate')
  generate(@Tenant() t: TenantContext, @Body() body: unknown) {
    return this.suggestions.generate(t, parseOrThrow(generateSuggestionsSchema, body).site_id);
  }

  @Patch('suggestions/:id')
  update(@Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.suggestions.setStatus(t, id, parseOrThrow(updateSuggestionSchema, body).status);
  }

  @Post('ai/ask')
  ask(@Tenant() t: TenantContext, @Body() body: unknown) {
    return this.askAi.ask(t, parseOrThrow(askSchema, body));
  }

  @Get('ai/conversations')
  conversations(@Tenant() t: TenantContext, @Query() q: unknown) {
    return this.askAi.conversations(t, parseOrThrow(siteQuery, q).site_id);
  }

  @Get('ai/conversations/:id')
  conversation(@Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.askAi.conversation(t, id);
  }

  /** AI-drafted, ready-to-paste copy for an SEO finding (cached; pass regenerate to redo). */
  @Post('seo/findings/:id/draft')
  draft(@Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.drafts.draft(t, id, parseOrThrow(draftSchema, body ?? {}).regenerate);
  }
}
