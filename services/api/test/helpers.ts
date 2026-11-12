import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import IORedis from 'ioredis';
import { freshTestDataSource, loadEnv } from '@growthos/db';
import type { DataSource } from 'typeorm';
import type { LlmProvider } from '../src/ai/llm';
import { createApp } from '../src/app.factory';
import type { AppConfig } from '../src/config';

export const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

export interface TestContext {
  app: INestApplication;
  ds: DataSource;
  devKey: string;
  close: () => Promise<void>;
}

/** Fresh test database + flushed test Redis + a running app pointed at both. */
export async function setupTestApp(overrides: Partial<AppConfig> = {}, deps: { llm?: LlmProvider | null } = { llm: null }): Promise<TestContext> {
  loadEnv();
  const dbUrl = process.env.TEST_DATABASE_URL!;
  const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';
  const ds = await freshTestDataSource();
  const r = new IORedis(redisUrl);
  await r.flushdb();
  r.disconnect();
  const devKey = 'test-dev-key-0123456789';
  const app = await createApp({
    databaseUrl: dbUrl,
    redisUrl,
    devKey,
    env: 'test',
    logLevel: 'silent',
    trustProxy: true,
    rateLimitIpPerMin: 10_000,
    rateLimitSitePerMin: 10_000,
    publicApiUrl: 'https://api.test',
    ...overrides,
  }, deps);
  await app.init();
  return {
    app,
    ds,
    devKey,
    close: async () => {
      await app.close();
      await ds.destroy();
    },
  };
}

export function event(over: Record<string, unknown> = {}) {
  return {
    event_id: randomUUID(),
    event_name: 'page_view',
    event_time: new Date(Date.now() - 60_000).toISOString(),
    page_url: 'https://shop.example.com/products/1?email=a@b.com&utm_source=nl#reviews',
    page_path: '/products/1',
    consent_state: 'pending',
    ephemeral_id: 'eph-1',
    ...over,
  };
}
