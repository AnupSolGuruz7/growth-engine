import { KeyOutlined } from '@ant-design/icons';
import { Alert, Progress, Space, Spin, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import Markdown from 'react-markdown';
import { Link } from 'react-router-dom';
import type { AiStatusDto } from '@growthos/shared-types';
import { api } from '../../api';

export function useAiStatus(siteId: string | undefined) {
  return useQuery({ queryKey: ['ai-status', siteId], queryFn: () => api.aiStatus(siteId!), enabled: !!siteId, staleTime: 15_000 });
}

/** Shown instead of AI features until ANTHROPIC_API_KEY is set. */
export function AiSetupCard() {
  return (
    <div className="empty-state" data-testid="ai-setup">
      <Space align="start" size="middle">
        <KeyOutlined style={{ fontSize: 28, color: '#2a78d6', marginTop: 4 }} />
        <div>
          <Typography.Title level={4} style={{ marginTop: 0 }}>Connect Claude to turn on AI insights</Typography.Title>
          <Typography.Paragraph>
            Growth suggestions, Ask AI and SEO copy drafts use Claude. They only read your analytics and SEO data through
            read-only tools, and every number they show is checked against that data.
          </Typography.Paragraph>
          <ol style={{ paddingLeft: 18, lineHeight: 1.8 }}>
            <li>Create an API key at <Typography.Text code>platform.claude.com</Typography.Text> → API keys.</li>
            <li>Add <Typography.Text code>ANTHROPIC_API_KEY=…</Typography.Text> to the repo's <Typography.Text code>.env</Typography.Text> (never commit it).</li>
            <li>Restart the API. Spend is capped per site per month (<Typography.Text code>AI_MONTHLY_BUDGET_USD</Typography.Text>, default $20).</li>
          </ol>
        </div>
      </Space>
    </div>
  );
}

/** Small budget meter: this month's AI spend for the site against the cap. */
export function BudgetMeter({ status }: { status: AiStatusDto }) {
  const pct = Math.min(100, Math.round((status.budget.used_usd / status.budget.limit_usd) * 100));
  return (
    <div style={{ minWidth: 200 }} title="AI spend this month for this site">
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        AI budget {status.budget.month}: ${status.budget.used_usd.toFixed(2)} of ${status.budget.limit_usd}
      </Typography.Text>
      <Progress percent={pct} size="small" showInfo={false} status={pct >= 90 ? 'exception' : 'normal'} />
    </div>
  );
}

/** Renders model Markdown safely (no raw HTML); dashboard paths become in-app links. */
export function AiMarkdown({ text }: { text: string }) {
  return (
    <div className="ai-md">
      <Markdown
        components={{
          a: ({ href, children }) =>
            href?.startsWith('/') ? <Link to={href}>{children}</Link> : <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a>,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

export function AiError({ error }: { error: unknown }) {
  const e = error as { status?: number; message?: string; body?: { error?: string } } | null;
  if (!e) return null;
  if (e.body?.error === 'ai_not_configured') return <AiSetupCard />;
  return <Alert type={e.status === 429 ? 'warning' : 'error'} showIcon message={e.message ?? 'Something went wrong'} style={{ marginBottom: 12 }} />;
}

export const Thinking = ({ label }: { label: string }) => (
  <Space>
    <Spin size="small" /> <Typography.Text type="secondary">{label}</Typography.Text>
  </Space>
);
