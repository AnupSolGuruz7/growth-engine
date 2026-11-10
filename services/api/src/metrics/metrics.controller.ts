import { Controller, Get, Header } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { RedisService } from '../common/redis';
import { MetricsService } from './metrics.service';

@Controller()
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly redis: RedisService,
    @InjectDataSource() private readonly ds: DataSource,
  ) {}

  /** Prometheus text format: ingestion counters/latency, queue depth, processing backlog. Requires X-Dev-Key. */
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4')
  async render(): Promise<string> {
    const gauges: Record<string, number> = {};
    try {
      const counts = await this.redis.processing.getJobCounts('waiting', 'active', 'delayed', 'failed');
      for (const [state, n] of Object.entries(counts)) gauges[`growthos_queue_jobs{queue="processing",state="${state}"}`] = n;
      gauges['growthos_queue_jobs{queue="dead_letter",state="waiting"}'] = await this.redis.deadLetter.getWaitingCount();
      gauges['growthos_queue_up'] = 1;
    } catch {
      gauges['growthos_queue_up'] = 0;
    }
    const [row] = await this.ds.query(
      `SELECT (SELECT count(*) FROM dirty_visitor_days)::int AS v, (SELECT count(*) FROM dirty_site_days)::int AS s`,
    );
    gauges['growthos_backlog{kind="visitor_days"}'] = row.v;
    gauges['growthos_backlog{kind="site_days"}'] = row.s;
    return this.metrics.render(gauges);
  }
}
