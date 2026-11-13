import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { knowledgeSearchSchema, upsertKnowledgeSourceSchema } from '@growthos/shared-types';
import { Tenant, type TenantContext } from '../common/tenant';
import { parseOrThrow } from '../common/zod';
import { KnowledgeService } from './knowledge.service';

/** A site's knowledge base: connect a local folder, sync it, search it, and read its Search Console snapshot. */
@Controller('v1/sites/:siteId/knowledge')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get()
  get(@Tenant() t: TenantContext, @Param('siteId', ParseUUIDPipe) siteId: string) {
    return this.knowledge.get(t, siteId);
  }

  @Put()
  upsert(@Tenant() t: TenantContext, @Param('siteId', ParseUUIDPipe) siteId: string, @Body() body: unknown) {
    return this.knowledge.upsert(t, siteId, parseOrThrow(upsertKnowledgeSourceSchema, body));
  }

  @Delete()
  @HttpCode(204)
  remove(@Tenant() t: TenantContext, @Param('siteId', ParseUUIDPipe) siteId: string) {
    return this.knowledge.remove(t, siteId);
  }

  @Post('sync')
  sync(@Tenant() t: TenantContext, @Param('siteId', ParseUUIDPipe) siteId: string) {
    return this.knowledge.sync(t, siteId);
  }

  @Get('search')
  search(@Tenant() t: TenantContext, @Param('siteId', ParseUUIDPipe) siteId: string, @Query() q: unknown) {
    const i = parseOrThrow(knowledgeSearchSchema, q);
    return this.knowledge.searchOwned(t, siteId, i.q, i.limit);
  }

  @Get('gsc')
  gsc(@Tenant() t: TenantContext, @Param('siteId', ParseUUIDPipe) siteId: string) {
    return this.knowledge.gscSummary(t, siteId);
  }
}
