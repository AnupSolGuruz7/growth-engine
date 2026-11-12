import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { createAuditSchema, findingsQuerySchema } from '@growthos/shared-types';
import { Tenant, type TenantContext } from '../common/tenant';
import { parseOrThrow } from '../common/zod';
import { SeoService } from './seo.service';

const siteQuery = z.object({ site_id: z.string().uuid() });
const pageQuery = z.object({ url: z.string().url() });

@Controller('v1/seo/audits')
export class SeoController {
  constructor(private readonly seo: SeoService) {}

  /** Starts a crawl of the site's own domain (spec §7.1). 409 while another audit of the site runs. */
  @Post()
  create(@Tenant() t: TenantContext, @Body() body: unknown) {
    return this.seo.create(t, parseOrThrow(createAuditSchema, body));
  }

  @Get()
  list(@Tenant() t: TenantContext, @Query() q: unknown) {
    return this.seo.list(t, parseOrThrow(siteQuery, q).site_id);
  }

  @Get(':id')
  get(@Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.seo.get(t, id);
  }

  @Get(':id/findings')
  findings(@Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: unknown) {
    return this.seo.findings(t, id, parseOrThrow(findingsQuerySchema, q));
  }

  @Get(':id/pages')
  pages(@Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.seo.pages(t, id);
  }

  @Get(':id/page')
  page(@Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: unknown) {
    return this.seo.page(t, id, parseOrThrow(pageQuery, q).url);
  }

  @Get(':id/compare/:prevId')
  compare(
    @Tenant() t: TenantContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('prevId', ParseUUIDPipe) prevId: string,
  ) {
    return this.seo.compare(t, id, prevId);
  }
}
