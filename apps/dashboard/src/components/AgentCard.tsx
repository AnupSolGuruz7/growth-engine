import { CheckCircleFilled, CloseCircleFilled, CodeOutlined } from '@ant-design/icons';
import { Alert, Card, Empty, Tag, Tooltip, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { AgentResponse } from '@growthos/shared-types';
import { api } from '../api';
import { fmtNumber, timeAgo } from '../dates';

/** An agent seen in the last 15 minutes counts as active. */
const ACTIVE_MS = 15 * 60_000;
const CLIENT: Record<string, string> = { 'claude-code': 'Claude Code' };
const clientName = (c: string | null) => (c ? CLIENT[c] ?? c : 'an MCP client');

/**
 * Coding agent (Claude Code in the website repo) using GrowthOS through the MCP server:
 * how to connect it, whether it is active, and what it has been doing.
 */
export function AgentCard({ siteId }: { siteId: string }) {
  const { data } = useQuery<AgentResponse>({
    queryKey: ['agent', siteId],
    queryFn: () => api.agent(siteId),
    refetchInterval: 15_000,
  });
  if (!data) return null;
  const active = !!data.last_seen_at && Date.now() - new Date(data.last_seen_at).getTime() < ACTIVE_MS;

  return (
    <Card
      size="small"
      className="agent-card"
      style={{ marginTop: 16 }}
      data-testid="agent-card"
      title={<span><CodeOutlined /> Coding agent <span className="title-sub">Claude Code in your website repo, via MCP</span></span>}
      extra={
        data.last_seen_at ? (
          <span className="agent-status">
            <span className={`agent-dot${active ? ' on' : ''}`} />
            {active ? 'Active' : 'Idle'} · last call {timeAgo(data.last_seen_at)} · {fmtNumber(data.calls_7d)} calls in 7 days
          </span>
        ) : (
          <span className="agent-status"><span className="agent-dot" />Not connected yet</span>
        )
      }
    >
      <div className="agent-grid">
        <div>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            Gives Claude Code this site's SEO findings, fix drafts, growth suggestions, knowledge base and content rules, so it can make the
            changes in the repo itself. Run this <b>inside the website repo</b>:
          </Typography.Paragraph>
          <Typography.Paragraph copyable={{ text: data.setup_command }} className="agent-cmd" data-testid="agent-cmd">
            {data.setup_command}
          </Typography.Paragraph>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
            <code>--scope local</code> keeps the setting out of the repo (<code>project</code> would add a <code>.mcp.json</code> the client can
            see). Keep the GrowthOS API running while you use it. Then ask, for example: <i>“Use GrowthOS to fix the meta description findings
            that live in this repo, check the copy, and commit on a new branch.”</i>
          </Typography.Paragraph>
          {!data.built && (
            <Alert style={{ marginTop: 8 }} type="warning" showIcon message={<>Build the server first: <code>pnpm --filter @growthos/mcp build</code></>} />
          )}
        </div>
        <div>
          <Typography.Text strong style={{ fontSize: 13 }}>Recent activity</Typography.Text>
          {data.activity.length ? (
            <ul className="agent-log">
              {data.activity.map((a) => (
                <li key={a.id}>
                  {a.ok ? <CheckCircleFilled className="ok" /> : <CloseCircleFilled className="bad" />}
                  <div className="agent-log-main">
                    <div className="ellipsis-1" title={a.summary}>{a.summary}</div>
                    <span className="agent-log-meta">
                      <Tag bordered={false}>{a.tool}</Tag>
                      <Tooltip title={new Date(a.created_at).toLocaleString()}>{timeAgo(a.created_at)}</Tooltip>
                      {a.client && ` · ${clientName(a.client)}`}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No agent activity yet" />
          )}
        </div>
      </div>
    </Card>
  );
}
