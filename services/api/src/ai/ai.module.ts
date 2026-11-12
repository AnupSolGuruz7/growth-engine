import { type DynamicModule, Module } from '@nestjs/common';
import { AnalyticsService } from '../analytics/analytics.service';
import type { AppConfig } from '../config';
import { AiController } from './ai.controller';
import { AskService } from './ask.service';
import { ClaudeProvider } from './claude.provider';
import { DraftsService } from './drafts.service';
import { FactsService } from './facts';
import { LLM_PROVIDER, type LlmProvider } from './llm';
import { SuggestionsService } from './suggestions.service';
import { AiUsageService } from './usage.service';

/**
 * AI insights (spec §8). The provider is Claude when ANTHROPIC_API_KEY is set, null otherwise
 * (endpoints then answer 503 ai_not_configured). Tests inject a scripted provider.
 */
@Module({})
export class AiModule {
  static forRoot(cfg: AppConfig, override?: LlmProvider | null): DynamicModule {
    const provider = override !== undefined ? override : cfg.anthropicApiKey ? new ClaudeProvider(cfg.anthropicApiKey, cfg.aiModel) : null;
    return {
      module: AiModule,
      controllers: [AiController],
      providers: [
        { provide: LLM_PROVIDER, useValue: provider },
        AnalyticsService,
        AiUsageService,
        FactsService,
        SuggestionsService,
        AskService,
        DraftsService,
      ],
    };
  }
}
