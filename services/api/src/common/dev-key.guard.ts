import { timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectDataSource } from '@nestjs/typeorm';
import { seedDevOrganization } from '@growthos/db';
import type { DataSource } from 'typeorm';
import { APP_CONFIG, type AppConfig } from '../config';
import { IS_PUBLIC } from './public.decorator';
import type { TenantContext } from './tenant';

/**
 * Global guard for the testing phase: every route requires `X-Dev-Key` unless marked @Public().
 * On success it attaches the dev organisation as the tenant context.
 */
@Injectable()
export class DevKeyGuard implements CanActivate {
  private devOrg: Promise<{ id: string }> | null = null;
  private readonly key: Buffer;

  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) cfg: AppConfig,
    @InjectDataSource() private readonly ds: DataSource,
  ) {
    this.key = Buffer.from(cfg.devKey);
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; tenant?: TenantContext }>();
    const given = Buffer.from(req.headers['x-dev-key'] ?? '');
    if (given.length !== this.key.length || !timingSafeEqual(given, this.key)) {
      throw new UnauthorizedException({ error: 'invalid_dev_key', message: 'Missing or invalid X-Dev-Key header' });
    }
    this.devOrg ??= seedDevOrganization(this.ds).catch((e) => {
      this.devOrg = null;
      throw e;
    });
    req.tenant = { organizationId: (await this.devOrg).id };
    return true;
  }
}
