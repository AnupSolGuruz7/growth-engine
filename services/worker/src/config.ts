import { loadEnv } from '@growthos/db';

export interface WorkerConfig {
  env: string;
  logLevel: string;
  databaseUrl: string;
  redisUrl: string;
  sessionTimeoutMin: number;
  sweepIntervalSec: number;
  /** Attempts before a job is moved to the dead-letter queue. */
  maxAttempts: number;
  /** SEO crawler (spec §7.1): 2 workers × 650 ms ≈ 1.5 requests/second. */
  seoConcurrency: number;
  seoDelayMs: number;
  /** Allow auditing localhost / private networks — development only. */
  seoAllowPrivate: boolean;
  seoUserAgent: string | undefined;
  pagespeedEnabled: boolean;
  pagespeedApiKey: string | undefined;
  pagespeedPages: number;
  /** Disable the repeatable schedulers (tests drive jobs explicitly). */
  schedulers: boolean;
}

export const WORKER_CONFIG = Symbol('WORKER_CONFIG');

const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export function loadWorkerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  loadEnv();
  const cfg: WorkerConfig = {
    env: process.env.NODE_ENV ?? 'development',
    logLevel: process.env.LOG_LEVEL ?? 'info',
    databaseUrl: process.env.DATABASE_URL ?? '',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379/0',
    sessionTimeoutMin: num('SESSION_TIMEOUT_MIN', 30),
    sweepIntervalSec: num('SWEEP_INTERVAL_SEC', 30),
    maxAttempts: num('JOB_MAX_ATTEMPTS', 5),
    seoConcurrency: Math.min(num('SEO_CONCURRENCY', 2), 4),
    seoDelayMs: Number(process.env.SEO_CRAWL_DELAY_MS ?? 650),
    seoAllowPrivate: process.env.SEO_ALLOW_PRIVATE_HOSTS === 'true',
    seoUserAgent: process.env.SEO_USER_AGENT || undefined,
    pagespeedEnabled: process.env.PAGESPEED_ENABLED !== 'false',
    pagespeedApiKey: process.env.PAGESPEED_API_KEY || undefined,
    pagespeedPages: num('PAGESPEED_PAGES', 3),
    schedulers: true,
    ...overrides,
  };
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL is required');
  return cfg;
}
