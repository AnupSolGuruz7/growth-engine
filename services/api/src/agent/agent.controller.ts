import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Body, Controller, Get, HttpCode, Injectable, Post, Query } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { findRepoRoot } from '@growthos/db';
import {
  agentActivitySchema, agentQuerySchema,
  type AgentActivityDto, type AgentActivityInput, type AgentResponse,
} from '@growthos/shared-types';
import type { DataSource } from 'typeorm';
import { Tenant, type TenantContext } from '../common/tenant';
import { parseOrThrow } from '../common/zod';
import { SitesService } from '../sites/sites.service';

/** Activity older than this is pruned when new activity arrives. */
const KEEP_DAYS = 30;

/** Coding agents using GrowthOS through the MCP server (services/mcp): setup and activity log. */
@Injectable()
export class AgentService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly sites: SitesService,
  ) {}

  async record(t: TenantContext, input: AgentActivityInput): Promise<void> {
    const siteId = input.site_id ? (await this.sites.getOwned(t, input.site_id)).id : null;
    await this.ds.query(
      `INSERT INTO agent_activity (organization_id, site_id, client, tool, summary, ok) VALUES ($1, $2, $3, $4, $5, $6)`,
      [t.organizationId, siteId, input.client ?? null, input.tool, input.summary, input.ok],
    );
    await this.ds.query(
      `DELETE FROM agent_activity WHERE organization_id = $1 AND created_at < now() - make_interval(days => $2)`,
      [t.organizationId, KEEP_DAYS],
    );
  }

  async get(t: TenantContext, siteId: string): Promise<AgentResponse> {
    const site = await this.sites.getOwned(t, siteId);
    const where = `organization_id = $1 AND (site_id = $2 OR site_id IS NULL)`;
    const rows: AgentActivityDto[] = await this.ds.query(
      `SELECT id, client, tool, summary, ok, created_at FROM agent_activity WHERE ${where} ORDER BY created_at DESC LIMIT 15`,
      [t.organizationId, site.id],
    );
    const [{ n }] = await this.ds.query(
      `SELECT count(*)::int AS n FROM agent_activity WHERE ${where} AND created_at > now() - interval '7 days'`,
      [t.organizationId, site.id],
    );
    const root = findRepoRoot(__dirname);
    const main = root ? join(root, 'services', 'mcp', 'dist', 'main.js') : null;
    return {
      setup_command: `claude mcp add growthos --scope local -- node ${(main ?? '<growthOs>/services/mcp/dist/main.js').replace(/\\/g, '/')}`,
      built: !!main && existsSync(main),
      last_seen_at: rows[0] ? new Date(rows[0].created_at).toISOString() : null,
      client: rows[0]?.client ?? null,
      calls_7d: n,
      activity: rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() })),
    };
  }
}

@Controller('v1/agent')
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  @Get()
  get(@Tenant() t: TenantContext, @Query() q: unknown) {
    return this.agent.get(t, parseOrThrow(agentQuerySchema, q).site_id);
  }

  /** Called by the MCP server after each tool call. */
  @Post('activity')
  @HttpCode(204)
  async record(@Tenant() t: TenantContext, @Body() body: unknown) {
    await this.agent.record(t, parseOrThrow(agentActivitySchema, body));
  }
}
