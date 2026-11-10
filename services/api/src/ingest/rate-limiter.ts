import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../common/redis';
import { APP_CONFIG, type AppConfig } from '../config';

export interface RateDecision {
  allowed: boolean;
  scope?: 'ip' | 'site';
  retryAfterSec?: number;
}

/**
 * Fixed one-minute windows in Redis. IPs are hashed before use as keys so raw addresses are never
 * stored (spec §13). Fails open if Redis is unavailable: ingestion availability beats strict limits.
 */
@Injectable()
export class RateLimiter {
  private readonly log = new Logger(RateLimiter.name);

  constructor(
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  checkIp(ip: string): Promise<RateDecision> {
    const h = createHash('sha256').update(ip).digest('hex').slice(0, 24);
    return this.hit('ip', `rl:ip:${h}`, this.cfg.rateLimitIpPerMin);
  }

  checkSite(siteId: string): Promise<RateDecision> {
    return this.hit('site', `rl:site:${siteId}`, this.cfg.rateLimitSitePerMin);
  }

  private async hit(scope: 'ip' | 'site', prefix: string, limit: number): Promise<RateDecision> {
    const now = Date.now();
    const window = Math.floor(now / 60_000);
    const key = `${prefix}:${window}`;
    try {
      const res = await this.redis.redis.multi().incr(key).expire(key, 120).exec();
      const count = Number(res?.[0]?.[1] ?? 0);
      if (count > limit) {
        return { allowed: false, scope, retryAfterSec: Math.max(1, Math.ceil(((window + 1) * 60_000 - now) / 1000)) };
      }
      return { allowed: true };
    } catch (e) {
      this.log.warn(`rate limiter unavailable, allowing request: ${(e as Error).message}`);
      return { allowed: true };
    }
  }
}
