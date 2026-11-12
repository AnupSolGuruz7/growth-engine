import { type DynamicModule, Module } from '@nestjs/common';
import { AnalyticsService } from '../analytics/analytics.service';
import type { AppConfig } from '../config';
import { AiController } from './ai.controller';
import { AskService } from './ask.service';
import { ClaudeProvider } from './claude.provider';
import { DraftsService } from './drafts.service';
import { FactsService } from './facts';
import { LLM_PROVIDER, setPriceOverride, type LlmProvider } from './llm';
import { OPENAI_COMPAT_PROVIDERS, OpenAiCompatProvider } from './openai-compat.provider';
import { SuggestionsService } from './suggestions.service';
import { AiUsageService } from './usage.service';

/** Builds the configured provider: Claude (Anthropic), or an OpenAI-compatible API (Groq, xAI Grok). */
export function createProvider(cfg: AppConfig): LlmProvider | null {
  // a Claude model id only makes sense for Anthropic; ignore it for other providers
  const model = cfg.aiProvider !== 'anthropic' && cfg.aiModel.startsWith('claude') ? '' : cfg.aiModel;
  switch (cfg.aiProvider) {
    case 'anthropic':
      return cfg.anthropicApiKey ? new ClaudeProvider(cfg.anthropicApiKey, model || 'claude-opus-5-5') : null;
    case 'groq':
      return cfg.groqApiKey ? new OpenAiCompatProvider('groq', cfg.groqApiKey, model || OPENAI_COMPAT_PROVIDERS.groq.defaultModel) : null;
    case 'xai':
      return cfg.xaiApiKey ? new OpenAiCompatProvider('xai', cfg.xaiApiKey, model || OPENAI_COMPAT_PROVIDERS.xai.defaultModel) : null;
    default:
      return null;
  }
}

/**
 * AI insights (spec §8). The provider comes from AI_PROVIDER + its key; without one the endpoints
 * answer 503 ai_not_configured. Tests inject a scripted provider.
 */
@Module({})
export class AiModule {
  static forRoot(cfg: AppConfig, override?: LlmProvider | null): DynamicModule {
    const provider = override !== undefined ? override : createProvider(cfg);
    if (provider) setPriceOverride(provider.model, cfg.aiPriceInputPerMTok, cfg.aiPriceOutputPerMTok);
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
