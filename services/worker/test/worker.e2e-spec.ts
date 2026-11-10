import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { freshTestDataSource, insertEvents, seedDemoSite, type NormalizedEvent } from '@growthos/db';
import { DEAD_LETTER_QUEUE, JOBS, PROCESSING_QUEUE } from '@growthos/shared-types';
import type { DataSource } from 'typeorm';
import { loadWorkerConfig } from '../src/config';
import { WorkerModule } from '../src/worker.module';

const ev = (n: number, time: string): NormalizedEvent => ({
  event_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, event_name: 'page_view', event_time: time,
  visitor_id: 'v1', session_id: 's1', ephemeral_id: null, page_url: null, page_path: `/p${n}`, page_title: null,
  referrer: null, referrer_host: null, utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null,
  utm_content: null, device_category: 'mobile', consent_state: 'granted', schema_version: 1, sdk_version: 't',
  properties: {},
});

describe('Processing worker (e2e)', () => {
  let ds: DataSource;
  let app: INestApplicationContext;
  let queue: Queue;
  let dlq: Queue;
  let events: QueueEvents;
  let conn: IORedis;
  let eventsConn: IORedis;

  beforeAll(async () => {
    ds = await freshTestDataSource();
    const redisUrl = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';
    conn = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    await conn.flushdb();
    const cfg = loadWorkerConfig({
      databaseUrl: process.env.TEST_DATABASE_URL!, redisUrl, logLevel: 'silent', env: 'test', schedulers: false, maxAttempts: 2,
    });
    app = await NestFactory.createApplicationContext(WorkerModule.forRoot(cfg), { logger: false });
    await app.init();
    queue = new Queue(PROCESSING_QUEUE, { connection: conn });
    dlq = new Queue(DEAD_LETTER_QUEUE, { connection: conn });
    eventsConn = conn.duplicate();
    events = new QueueEvents(PROCESSING_QUEUE, { connection: eventsConn });
    await events.waitUntilReady();
  });

  afterAll(async () => {
    await app?.close();
    await Promise.allSettled([queue?.close(), dlq?.close(), events?.close()]);
    // BullMQ does not close connections it was handed
    conn?.disconnect();
    eventsConn?.disconnect();
    await ds?.destroy();
  });

  it('ensures partitions on boot', async () => {
    const rows = await ds.query(`SELECT count(*)::int n FROM pg_class WHERE relname ~ '^events_y\\d{4}m\\d{2}$'`);
    expect(rows[0].n).toBeGreaterThanOrEqual(4);
  });

  it('sessionises and rolls up when a process job runs', async () => {
    const site = await seedDemoSite(ds, 'Asia/Kolkata');
    // 18:20 and 18:40 UTC = 23:50 and 00:10 in Kolkata: same visitor, 20 min apart, but split at local midnight.
    await insertEvents(ds, site, [ev(1, '2026-11-10T18:20:00Z'), ev(2, '2026-11-10T18:40:00Z')]);
    const job = await queue.add(JOBS.PROCESS, { trigger: 'test' });
    const result = await job.waitUntilFinished(events, 15_000);
    expect(result).toEqual({ sessionized: 2, rolledUp: 2 });
    const sessions = await ds.query(`SELECT local_date, pageviews, is_bounce, device_category FROM sessions ORDER BY local_date`);
    expect(sessions).toEqual([
      { local_date: '2026-11-10', pageviews: 1, is_bounce: true, device_category: 'mobile' },
      { local_date: '2026-11-11', pageviews: 1, is_bounce: true, device_category: 'mobile' },
    ]);
    const [{ n }] = await ds.query(`SELECT count(*)::int n FROM dirty_visitor_days`);
    expect(n).toBe(0);
  });

  it('retries failing jobs and then moves them to the dead-letter queue', async () => {
    const job = await queue.add('no-such-job', { x: 1 }, { attempts: 2, backoff: { type: 'fixed', delay: 50 } });
    await expect(job.waitUntilFinished(events, 15_000)).rejects.toThrow('Unknown job');
    for (let i = 0; i < 50 && (await dlq.getWaitingCount()) === 0; i++) await new Promise((r) => setTimeout(r, 100));
    const [dead] = await dlq.getWaiting();
    expect(dead?.data).toMatchObject({ original: { x: 1 }, failed_reason: 'Unknown job: no-such-job' });
    expect((await queue.getJob(job.id!))?.attemptsMade).toBe(2);
  });
});
