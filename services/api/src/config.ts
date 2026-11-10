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
}

export const APP_CONFIG = Symbol('APP_CONFIG');

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
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
    ...overrides,
  };
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL is required');
  if (cfg.devKey.length < 16) throw new Error('DEV_KEY must be set to at least 16 characters');
  return cfg;
}
