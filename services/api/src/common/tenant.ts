import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

/**
 * Who the request acts for. During the auth-free phase the DevKeyGuard always resolves the seeded
 * `dev` organisation; M6 replaces only that resolution step (spec §3, §9). Every service method that
 * reads or writes tenant data takes this context and scopes its queries by organizationId.
 */
export interface TenantContext {
  organizationId: string;
}

export const Tenant = createParamDecorator((_: unknown, ctx: ExecutionContext): TenantContext => {
  const req = ctx.switchToHttp().getRequest<{ tenant?: TenantContext }>();
  if (!req.tenant) throw new Error('Tenant context missing — is the route marked @Public()?');
  return req.tenant;
});
