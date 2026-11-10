import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { BatchResponse } from '@growthos/shared-types';
import { Public } from '../common/public.decorator';
import { IngestService } from './ingest.service';

@Controller('v1/events')
export class IngestController {
  constructor(private readonly ingest: IngestService) {}

  /** Public ingestion endpoint (CORS open). Validated by site public_id only (spec §3). */
  @Public()
  @Post('batch')
  @HttpCode(202)
  async batch(@Req() req: Request, @Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<BatchResponse> {
    res.setHeader('Cache-Control', 'no-store');
    return this.ingest.ingest({
      body,
      ip: req.ip ?? req.socket.remoteAddress ?? 'unknown',
      userAgent: req.get('user-agent') ?? '',
    });
  }
}
