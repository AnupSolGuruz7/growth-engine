import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { Response } from 'express';
import type { DataSource } from 'typeorm';
import { Public } from '../common/public.decorator';
import { RedisService } from '../common/redis';

@Controller()
export class HealthController {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get('health')
  async health(@Res({ passthrough: true }) res: Response) {
    const check = async (fn: () => Promise<unknown>) => {
      try {
        await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))]);
        return 'ok' as const;
      } catch {
        return 'down' as const;
      }
    };
    const [db, redis] = await Promise.all([check(() => this.ds.query('SELECT 1')), check(() => this.redis.redis.ping())]);
    const ok = db === 'ok' && redis === 'ok';
    if (!ok) res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ok' : 'degraded', db, redis, uptime_s: Math.round(process.uptime()) };
  }
}
