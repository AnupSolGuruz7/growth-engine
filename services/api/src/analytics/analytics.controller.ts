import { Controller, Get, Header, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { EVENT_NAME_RE, EXPORT_REPORTS, analyticsQuerySchema } from '@growthos/shared-types';
import { Tenant, type TenantContext } from '../common/tenant';
import { parseOrThrow } from '../common/zod';
import { AnalyticsService } from './analytics.service';

const eventsQuery = z.object({ event_name: z.string().regex(EVENT_NAME_RE).optional() });
const exportQuery = z.object({ report: z.enum(EXPORT_REPORTS) });
const realtimeQuery = z.object({
  site_id: z.string().uuid(),
  minutes: z.coerce.number().int().min(1).max(60).optional().default(5),
});

@Controller('v1/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  overview(@Tenant() t: TenantContext, @Query() q: unknown) {
    return this.analytics.overview(t, parseOrThrow(analyticsQuerySchema, q));
  }

  @Get('pages')
  pages(@Tenant() t: TenantContext, @Query() q: unknown) {
    return this.analytics.pages(t, parseOrThrow(analyticsQuerySchema, q));
  }

  @Get('sources')
  sources(@Tenant() t: TenantContext, @Query() q: unknown) {
    return this.analytics.sources(t, parseOrThrow(analyticsQuerySchema, q));
  }

  @Get('events')
  events(@Tenant() t: TenantContext, @Query() q: Record<string, unknown>) {
    const { event_name } = parseOrThrow(eventsQuery, q);
    return this.analytics.events(t, parseOrThrow(analyticsQuerySchema, q), event_name);
  }

  @Get('devices')
  devices(@Tenant() t: TenantContext, @Query() q: unknown) {
    return this.analytics.devices(t, parseOrThrow(analyticsQuerySchema, q));
  }

  @Get('realtime')
  @Header('Cache-Control', 'no-store')
  realtime(@Tenant() t: TenantContext, @Query() q: unknown) {
    const { site_id, minutes } = parseOrThrow(realtimeQuery, q);
    return this.analytics.realtime(t, site_id, minutes);
  }

  @Get('export.csv')
  async exportCsv(@Tenant() t: TenantContext, @Query() q: Record<string, unknown>, @Res() res: Response) {
    const { report } = parseOrThrow(exportQuery, q);
    const query = parseOrThrow(analyticsQuerySchema, q);
    const csv = await this.analytics.exportCsv(t, query, report);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="growthos-${report}-${query.from}_${query.to}.csv"`);
    res.send(csv);
  }
}
