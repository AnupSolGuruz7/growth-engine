import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { PinoLogger } from 'nestjs-pino';
import { insertEvents, recordBotDrops, type NormalizedEvent } from '@growthos/db';
import {
  JOBS,
  PROCESS_JOB_ID,
  batchEnvelopeSchema,
  detectBot,
  formatZodIssues,
  incomingEventSchema,
  type BatchResponse,
  type RejectedEvent,
} from '@growthos/shared-types';
import type { DataSource } from 'typeorm';
import { RedisService } from '../common/redis';
import { MetricsService } from '../metrics/metrics.service';
import { normalizeEvent } from './normalize';
import { RateLimiter } from './rate-limiter';
import { SiteCache } from './site-cache';

/** Events older than this (e.g. stuck in an SDK retry queue) or this far in the future are rejected. */
export const MAX_EVENT_AGE_MS = 7 * 24 * 3600_000;
export const MAX_EVENT_FUTURE_MS = 10 * 60_000;

export interface IngestRequest {
  body: unknown;
  ip: string;
  userAgent: string;
}

@Injectable()
export class IngestService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly sites: SiteCache,
    private readonly limiter: RateLimiter,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
    private readonly log: PinoLogger,
  ) {
    log.setContext(IngestService.name);
  }

  async ingest(req: IngestRequest): Promise<BatchResponse> {
    const started = performance.now();
    try {
      const res = await this.handle(req);
      this.metrics.inc('growthos_ingest_requests_total', { status: '202' });
      return res;
    } catch (e) {
      const status = e instanceof HttpException ? e.getStatus() : 500;
      this.metrics.inc('growthos_ingest_requests_total', { status: String(status) });
      if (status >= 500) this.metrics.inc('growthos_ingest_errors_total');
      throw e;
    } finally {
      this.metrics.observeLatency(performance.now() - started);
    }
  }

  private async handle(req: IngestRequest): Promise<BatchResponse> {
    // 1. per-IP limit first: cheapest protection, before touching the database
    this.enforce(await this.limiter.checkIp(req.ip));

    // 2. envelope (sendBeacon posts text/plain, so the body may still be a string)
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        throw new BadRequestException({ error: 'invalid_json', message: 'Body is not valid JSON' });
      }
    }
    const env = batchEnvelopeSchema.safeParse(body);
    if (!env.success) {
      throw new BadRequestException({ error: 'invalid_batch', message: formatZodIssues(env.error) });
    }
    const batch = env.data;

    // 3. site resolved server-side; unknown and inactive sites rejected
    const site = await this.sites.byPublicId(batch.site_id);
    if (!site) throw new NotFoundException({ error: 'unknown_site', message: 'Unknown site_id' });
    if (site.status !== 'active') throw new ForbiddenException({ error: 'site_inactive', message: 'Site is inactive' });
    this.enforce(await this.limiter.checkSite(site.id));

    // 4. bots: counted, never stored
    const bot = detectBot(req.userAgent, batch.automation);
    if (bot) {
      await recordBotDrops(this.ds, site, bot, batch.events.length);
      this.metrics.inc('growthos_ingest_events_total', { result: 'bot' }, batch.events.length);
      return { accepted: 0, duplicates: 0, rejected: [], dropped_bots: batch.events.length };
    }

    // 5. per-event validation + normalisation
    const rejected: RejectedEvent[] = [];
    const valid: NormalizedEvent[] = [];
    const seen = new Set<string>();
    let inBatchDuplicates = 0;
    const now = Date.now();
    batch.events.forEach((raw, index) => {
      const parsed = incomingEventSchema.safeParse(raw);
      const id = typeof (raw as { event_id?: unknown })?.event_id === 'string' ? (raw as { event_id: string }).event_id : null;
      if (!parsed.success) {
        rejected.push({ event_id: id, index, reason: 'invalid_schema', detail: formatZodIssues(parsed.error) });
        return;
      }
      const t = Date.parse(parsed.data.event_time);
      if (t < now - MAX_EVENT_AGE_MS || t > now + MAX_EVENT_FUTURE_MS) {
        rejected.push({ event_id: id, index, reason: 'event_time_out_of_range', detail: 'must be within the last 7 days and at most 10 minutes ahead' });
        return;
      }
      const ev = normalizeEvent(parsed.data, {
        siteDomain: site.domain,
        userAgent: req.userAgent,
        schemaVersion: batch.schema_version,
        sdkVersion: batch.sdk_version ?? null,
      });
      const key = `${ev.event_id}|${ev.event_time}`;
      if (seen.has(key)) {
        inBatchDuplicates++;
        return;
      }
      seen.add(key);
      valid.push(ev);
    });

    // 6. bulk insert, ON CONFLICT DO NOTHING; dirty keys marked in the same statement
    const accepted = await insertEvents(this.ds, site, valid);
    const duplicates = valid.length - accepted + inBatchDuplicates;

    // 7. wake the worker (best effort — the worker also sweeps periodically)
    if (accepted > 0) {
      this.redis.processing
        .add(JOBS.PROCESS, {}, { jobId: PROCESS_JOB_ID, delay: 2000, removeOnComplete: true, removeOnFail: true })
        .catch((e: Error) => this.log.warn({ err: e.message }, 'could not enqueue processing job'));
    }

    this.metrics.inc('growthos_ingest_events_total', { result: 'accepted' }, accepted);
    this.metrics.inc('growthos_ingest_events_total', { result: 'duplicate' }, duplicates);
    this.metrics.inc('growthos_ingest_events_total', { result: 'rejected' }, rejected.length);
    this.log.info({ site_id: site.id, accepted, duplicates, rejected: rejected.length }, 'batch ingested');
    return { accepted, duplicates, rejected, dropped_bots: 0 };
  }

  private enforce(d: { allowed: boolean; scope?: string; retryAfterSec?: number }): void {
    if (d.allowed) return;
    this.metrics.inc('growthos_ingest_rate_limited_total', { scope: d.scope ?? 'unknown' });
    throw new HttpException(
      { error: 'rate_limited', scope: d.scope, retry_after_sec: d.retryAfterSec, message: 'Too many requests' },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
