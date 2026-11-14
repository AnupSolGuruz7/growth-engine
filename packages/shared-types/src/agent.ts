import { z } from 'zod';

/** One tool call reported by the GrowthOS MCP server. */
export const agentActivitySchema = z.object({
  site_id: z.string().uuid().nullable().optional(),
  client: z.string().trim().max(100).nullable().optional(),
  tool: z.string().trim().min(1).max(64),
  summary: z.string().trim().min(1).max(300),
  ok: z.boolean().default(true),
});
export type AgentActivityInput = z.infer<typeof agentActivitySchema>;

export const agentQuerySchema = z.object({ site_id: z.string().uuid() });

export interface AgentActivityDto {
  id: string;
  client: string | null;
  tool: string;
  summary: string;
  ok: boolean;
  created_at: string;
}

export interface AgentResponse {
  /** Command that registers the MCP server with Claude Code (run inside the website repo). */
  setup_command: string;
  /** services/mcp/dist/main.js exists (pnpm --filter @growthos/mcp build). */
  built: boolean;
  /** Latest activity from any agent, for this site or site-independent. */
  last_seen_at: string | null;
  client: string | null;
  calls_7d: number;
  activity: AgentActivityDto[];
}
