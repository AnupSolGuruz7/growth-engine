import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { createSiteSchema, updateSiteSchema } from '@growthos/shared-types';
import { Tenant, type TenantContext } from '../common/tenant';
import { parseOrThrow } from '../common/zod';
import { SitesService } from './sites.service';

@Controller('v1/sites')
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  @Post()
  create(@Tenant() t: TenantContext, @Body() body: unknown) {
    return this.sites.create(t, parseOrThrow(createSiteSchema, body));
  }

  @Get()
  list(@Tenant() t: TenantContext) {
    return this.sites.list(t);
  }

  @Get(':id')
  get(@Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sites.get(t, id);
  }

  @Patch(':id')
  update(@Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.sites.update(t, id, parseOrThrow(updateSiteSchema, body));
  }

  @Post(':id/rotate-public-id')
  rotate(@Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sites.rotatePublicId(t, id);
  }

  /** Deletes the site's analytics data (events, sessions, rollups). The site itself is kept. */
  @Delete(':id/data')
  deleteData(@Tenant() t: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sites.deleteData(t, id);
  }
}
