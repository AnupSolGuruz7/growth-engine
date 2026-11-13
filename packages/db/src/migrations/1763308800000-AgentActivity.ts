import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Activity log of coding agents using GrowthOS through its MCP server (services/mcp): one row per
 * tool call, with a short human summary. Only summaries are stored, never the copy or passages.
 */
export class AgentActivity1763308800000 implements MigrationInterface {
  name = 'AgentActivity1763308800000';

  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE agent_activity (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        organization_id uuid NOT NULL,
        site_id         uuid REFERENCES sites(id) ON DELETE CASCADE,   -- null for site-independent tools
        client          text,                                          -- e.g. claude-code
        tool            text NOT NULL,
        summary         text NOT NULL,
        ok              boolean NOT NULL DEFAULT true,
        created_at      timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX agent_activity_org_idx ON agent_activity (organization_id, created_at DESC)`);
  }

  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE agent_activity`);
  }
}
