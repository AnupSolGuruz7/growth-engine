import { loadEnv } from '@growthos/db';

export interface AppConfig {
  env: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  redisUrl: string;
  devKey: string;
  publicApiUrl: string;
  trustProxy: boolean;
  rateLimitSitePerMin: number;
  rateLimitIpPerMin: number;
  migrationsRun: boolean;
  sdkFile: string | null;
  /** Claude API key; AI features are disabled (503 ai_not_configured) without it. */
  anthropicApiKey: string | null;
  groqApiKey: string | null;
  xaiApiKey: string | null;
  /** anthropic | groq | xai; null when no key is configured. */
  aiProvider: 'anthropic' | 'groq' | 'xai' | null;
  /** Model id; empty = the provider default (claude-opus-5-5, openai/gpt-oss-120b, grok-4). */
  aiModel: string;
  /** Optional price override in USD per million tokens (for budgets with models not in the price table). */
  aiPriceInputPerMTok: number | null;
  aiPriceOutputPerMTok: number | null;
  aiMonthlyBudgetUsd: number;
  aiAskDailyLimit: number;
  /**
   * Folders a site's knowledge source may be read from (KNOWLEDGE_ALLOWED_ROOTS, separated by ; or ,).
   * Empty = connecting a knowledge source is refused: the API must never read arbitrary server paths.
   */
  knowledgeAllowedRoots: string[];
  /** Upper bound on knowledge text added to one AI prompt (tokens, approx.). */
  knowledgeContextTokens: number;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** AI_PROVIDER wins; otherwise the first provider with a key (Anthropic, then Groq, then xAI). */
function pickProvider(): AppConfig['aiProvider'] {
  const explicit = process.env.AI_PROVIDER?.toLowerCase();
  if (explicit === 'anthropic' || explicit === 'groq' || explicit === 'xai') return explicit;
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.GROQ_API_KEY) return 'groq';
  if (process.env.XAI_API_KEY) return 'xai';
  return null;
}

/** Reads configuration from the environment (root .env is loaded first, real env vars win). */
export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  loadEnv();
  const devKey = process.env.DEV_KEY ?? '';
  const cfg: AppConfig = {
    env: process.env.NODE_ENV ?? 'development',
    port: num('API_PORT', 4000),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    databaseUrl: process.env.DATABASE_URL ?? '',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379/0',
    devKey,
    publicApiUrl: (process.env.PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, ''),
    trustProxy: process.env.TRUST_PROXY === 'true',
    rateLimitSitePerMin: num('RATE_LIMIT_SITE_PER_MIN', 600),
    rateLimitIpPerMin: num('RATE_LIMIT_IP_PER_MIN', 120),
    migrationsRun: process.env.MIGRATIONS_RUN === 'true',
    sdkFile: process.env.SDK_FILE ?? null,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
    groqApiKey: process.env.GROQ_API_KEY || null,
    xaiApiKey: process.env.XAI_API_KEY || null,
    aiProvider: pickProvider(),
    aiModel: process.env.AI_MODEL || '',
    aiPriceInputPerMTok: process.env.AI_PRICE_INPUT_PER_MTOK ? Number(process.env.AI_PRICE_INPUT_PER_MTOK) : null,
    aiPriceOutputPerMTok: process.env.AI_PRICE_OUTPUT_PER_MTOK ? Number(process.env.AI_PRICE_OUTPUT_PER_MTOK) : null,
    aiMonthlyBudgetUsd: num('AI_MONTHLY_BUDGET_USD', 20),
    aiAskDailyLimit: num('AI_ASK_DAILY_LIMIT', 50),
    knowledgeAllowedRoots: (process.env.KNOWLEDGE_ALLOWED_ROOTS ?? '').split(/[;,]/).map((p) => p.trim()).filter(Boolean),
    knowledgeContextTokens: num('KNOWLEDGE_CONTEXT_TOKENS', 1500),
    ...overrides,
  };
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL is required');
  if (cfg.devKey.length < 16) throw new Error('DEV_KEY must be set to at least 16 characters');
  return cfg;
}
