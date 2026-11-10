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
    schedulers: true,
    ...overrides,
  };
  if (!cfg.databaseUrl) throw new Error('DATABASE_URL is required');
  return cfg;
}
