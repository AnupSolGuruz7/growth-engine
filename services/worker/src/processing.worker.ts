import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Queue, Worker, type Job } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import { ensurePartitions, processPending } from '@growthos/db';
import { DEAD_LETTER_QUEUE, JOBS, PROCESSING_QUEUE } from '@growthos/shared-types';
import type { DataSource } from 'typeorm';
import { WORKER_CONFIG, type WorkerConfig } from './config';

/**
 * Consumes the processing queue.
 * - `process`: drains dirty visitor-days (sessionisation) then dirty site-days (rollups). The work
 *   list lives in Postgres, so a lost Redis message only delays processing until the next sweep.
 * - `partitions`: creates upcoming monthly event partitions.
 * Failed jobs retry with exponential backoff; after the last attempt they go to the dead-letter queue.
 */
@Injectable()
export class ProcessingWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private worker?: Worker;
  private queue?: Queue;
  private dlq?: Queue;
  private conn?: Redis;

  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    @Inject(WORKER_CONFIG) private readonly cfg: WorkerConfig,
    private readonly log: PinoLogger,
  ) {
    log.setContext(ProcessingWorker.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    this.conn = new IORedis(this.cfg.redisUrl, { maxRetriesPerRequest: null });
    const connection = this.conn;
    const defaultJobOptions = {
      attempts: this.cfg.maxAttempts,
      backoff: { type: 'exponential' as const, delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    };
    this.queue = new Queue(PROCESSING_QUEUE, { connection, defaultJobOptions });
    this.dlq = new Queue(DEAD_LETTER_QUEUE, { connection });

    // Make sure the current partitions exist before consuming anything.
    const parts = await ensurePartitions(this.ds, 1, 2);
    this.log.info({ partitions: parts }, 'event partitions ensured');

    if (this.cfg.schedulers) {
      await this.queue.upsertJobScheduler(
        'sweep',
        { every: this.cfg.sweepIntervalSec * 1000 },
        { name: JOBS.PROCESS, data: { trigger: 'sweep' }, opts: defaultJobOptions },
      );
      await this.queue.upsertJobScheduler(
        'partitions-daily',
        { pattern: '15 0 * * *', tz: 'UTC' },
        { name: JOBS.PARTITIONS, data: {}, opts: defaultJobOptions },
      );
    }

    this.worker = new Worker(PROCESSING_QUEUE, (job) => this.handle(job), { connection, concurrency: 1 });
    this.worker.on('failed', (job, err) => void this.onFailed(job, err));
    this.worker.on('error', (err) => this.log.error({ err: err.message }, 'worker error'));
    this.log.info({ queue: PROCESSING_QUEUE, sweepEverySec: this.cfg.sweepIntervalSec }, 'worker started');
  }

  async handle(job: Job): Promise<unknown> {
    const started = Date.now();
    switch (job.name) {
      case JOBS.PROCESS: {
        const res = await processPending(this.ds, { sessionTimeoutMin: this.cfg.sessionTimeoutMin });
        if (res.sessionized || res.rolledUp) {
          this.log.info({ ...res, ms: Date.now() - started, trigger: job.data?.trigger ?? 'ingest' }, 'processed');
        }
        return res;
      }
      case JOBS.PARTITIONS:
        return { partitions: await ensurePartitions(this.ds, 1, 2) };
      default:
        throw new Error(`Unknown job: ${job.name}`);
    }
  }

  private async onFailed(job: Job | undefined, err: Error): Promise<void> {
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    this.log.warn({ job: job.name, id: job.id, attempt: job.attemptsMade, attempts, err: err.message }, 'job failed');
    if (job.attemptsMade >= attempts) {
      await this.dlq?.add(
        job.name,
        { original: job.data, job_id: job.id, failed_reason: err.message, failed_at: new Date().toISOString() },
        { removeOnComplete: false },
      );
      this.log.error({ job: job.name, id: job.id }, 'job moved to dead-letter queue');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await Promise.allSettled([this.queue?.close(), this.dlq?.close()]);
    this.conn?.disconnect();
  }
}
