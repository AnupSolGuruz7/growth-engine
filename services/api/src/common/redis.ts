import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { DEAD_LETTER_QUEUE, PROCESSING_QUEUE } from '@growthos/shared-types';
import { APP_CONFIG, type AppConfig } from '../config';

/** Shared Redis connection (rate limits) and BullMQ producers. */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  readonly redis: Redis;
  readonly processing: Queue;
  readonly deadLetter: Queue;
  private readonly queueConn: Redis;

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.redis = new IORedis(cfg.redisUrl, { maxRetriesPerRequest: 2, enableOfflineQueue: false, lazyConnect: false });
    this.redis.on('error', () => undefined); // surfaced through /health; avoid unhandled error spam
    // Producers fail fast when Redis is down: events are already durable in Postgres and the
    // worker's periodic sweep picks them up, so ingestion never blocks on the queue.
    this.queueConn = new IORedis(cfg.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    this.queueConn.on('error', () => undefined);
    const connection = this.queueConn;
    this.processing = new Queue(PROCESSING_QUEUE, { connection });
    this.deadLetter = new Queue(DEAD_LETTER_QUEUE, { connection });
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.processing.close(), this.deadLetter.close()]);
    this.redis.disconnect();
    this.queueConn.disconnect();
  }
}
