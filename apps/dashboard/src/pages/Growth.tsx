import { ArrowDownOutlined, ArrowUpOutlined, BulbOutlined, CheckOutlined, CloseOutlined, LikeOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Empty, Popover, Segmented, Space, Spin, Tag, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { EvidenceItem, SuggestionDto, SuggestionStatus } from '@growthos/shared-types';
import { api, ApiError } from '../api';
import { AiError, AiSetupCard, BudgetMeter, Thinking, modelLabel, useAiStatus } from '../components/ai/AiBits';
import { fmtNumber, timeAgo } from '../dates';
import { useCurrentSite } from '../hooks';

const AREA: Record<string, { label: string; color: string }> = {
  seo: { label: 'SEO', color: 'blue' },
  content: { label: 'Content', color: 'purple' },
  marketing: { label: 'Marketing', color: 'geekblue' },
};

/** Rates (0–1) as percentages, durations in seconds, counts with separators. */
function fmtValue(ref: string, v: number | string | null): string {
  if (v === null) return '—';
  if (typeof v === 'string') return v;
  if (/rate/.test(ref)) return `${(v * 100).toFixed(1)}%`;
  if (/duration/.test(ref)) return `${Math.round(v)}s`;
  return Number.isInteger(v) ? fmtNumber(v) : v.toFixed(2);
}

/** Fact labels carry unit hints for the model ("(0–1)"); people see percentages instead. */
const humanLabel = (l: string) => l.replaceAll(' (0–1)', '');

function Evidence({ items }: { items: EvidenceItem[] }) {
  return (
    <ul className="evidence-list">
      {items.map((e) => (
        <li key={e.ref}>
          <Link to={e.link}>{humanLabel(e.label)}</Link>: <b>{fmtValue(e.ref, e.value)}</b>
        </li>
      ))}
    </ul>
  );
}

function Result({ s }: { s: SuggestionDto }) {
  const r = s.result!;
  const good = r.change !== null && (s.measurement.direction === 'increase' ? r.change > 0 : r.change < 0);
  return (
    <div className="measure">
      <Typography.Text strong>Before / after: {humanLabel(s.measurement.label)}</Typography.Text>
      <div>
        {fmtValue(s.measurement.metric_ref, r.before)} in the {r.window_days} days before → {r.after === null ? 'waiting for data' : fmtValue(s.measurement.metric_ref, r.after)}
        {r.after_days > 0 && r.after_days < r.window_days && <Typography.Text type="secondary"> (projected from {r.after_days} of {r.window_days} days)</Typography.Text>}
        {r.change !== null && (
          <span style={{ marginLeft: 8, color: good ? '#0a7d0a' : '#b42318', fontWeight: 600 }}>
            {r.change > 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />} {Math.abs(r.change * 100).toFixed(1)}%
            <span className="sr-only">{good ? ' (in the intended direction)' : ' (against the intended direction)'}</span>
          </span>
        )}
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>A change after you acted is not proof the action caused it — seasonality and other changes matter too.</Typography.Text>
    </div>
  );
}

function SuggestionCard({ s, siteId }: { s: SuggestionDto; siteId: string }) {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const set = useMutation({
    mutationFn: (status: SuggestionStatus) => api.updateSuggestion(s.id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['suggestions', siteId] }),
    onError: (e) => message.error((e as Error).message),
  });
  return (
    <Card size="small" className={`suggestion status-${s.status}`} data-testid="suggestion">
      <Space wrap size={6} style={{ marginBottom: 6 }}>
        <Tag color={AREA[s.area]!.color} bordered={false}>{AREA[s.area]!.label}</Tag>
        <Tag bordered={false}>priority {s.priority}</Tag>
        <Tag bordered={false}>effort {s.effort}</Tag>
        <Tag bordered={false}>confidence {s.confidence}</Tag>
        {s.status !== 'new' && <Tag color={s.status === 'done' ? 'green' : s.status === 'accepted' ? 'blue' : undefined}>{s.status}</Tag>}
      </Space>
      <Typography.Title level={5} style={{ margin: '2px 0 8px' }}>{s.title}</Typography.Title>
      <Typography.Paragraph style={{ marginBottom: 8 }}>{s.action}</Typography.Paragraph>
      {s.copy && (
        <Typography.Paragraph copyable={{ text: s.copy }} className="fix">
          {s.copy}
        </Typography.Paragraph>
      )}
      <div className="sugg-grid">
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>EVIDENCE (checked against your data)</Typography.Text>
          <Evidence items={s.evidence} />
        </div>
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>EXPECTED OUTCOME</Typography.Text>
          <div>{s.expected_outcome}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>HOW TO MEASURE</Typography.Text>
          <div>
            Watch <Link to={s.evidence.find((e) => e.ref === s.measurement.metric_ref)?.link ?? '/'}>{humanLabel(s.measurement.label)}</Link> — should{' '}
            {s.measurement.direction} over {s.measurement.window_days} days (now {fmtValue(s.measurement.metric_ref, s.measurement.baseline)}).
          </div>
        </div>
      </div>
      {s.assumptions && <Alert type="info" showIcon message={s.assumptions} style={{ marginTop: 10 }} />}
      {s.result && <Result s={s} />}
      <Space wrap style={{ marginTop: 12 }}>
        {s.status === 'new' && <Button size="small" icon={<LikeOutlined />} onClick={() => set.mutate('accepted')} loading={set.isPending}>Accept</Button>}
        {s.status !== 'done' && <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => set.mutate('done')} loading={set.isPending}>Mark done</Button>}
        {s.status !== 'dismissed' && s.status !== 'done' && <Button size="small" icon={<CloseOutlined />} onClick={() => set.mutate('dismissed')} loading={set.isPending}>Dismiss</Button>}
        {(s.status === 'dismissed' || s.status === 'done') && <Button size="small" type="link" onClick={() => set.mutate('new')}>Reopen</Button>}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>suggested {timeAgo(s.created_at)}</Typography.Text>
      </Space>
    </Card>
  );
}

type Filter = 'open' | 'done' | 'dismissed' | 'all';

export function GrowthPage() {
  const { site } = useCurrentSite();
  const qc = useQueryClient();
  const status = useAiStatus(site?.id);
  const [filter, setFilter] = useState<Filter>('open');
  const list = useQuery({
    queryKey: ['suggestions', site?.id],
    queryFn: () => api.suggestions(site!.id),
    enabled: !!site,
    refetchInterval: (q) => (q.state.data?.latest_run?.status === 'running' ? 3000 : false),
  });
  const generate = useMutation({
    mutationFn: () => api.generateSuggestions(site!.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['suggestions', site!.id] }),
  });
  if (!site) return null;
  const run = list.data?.latest_run;
  const running = run?.status === 'running';
  const all = list.data?.suggestions ?? [];
  const shown = all.filter((s) =>
    filter === 'all' ? true : filter === 'open' ? s.status === 'new' || s.status === 'accepted' : s.status === filter,
  );

  return (
    <section>
      <div className="page-head">
        <Typography.Title level={3} style={{ margin: 0 }}>Growth suggestions</Typography.Title>
        {status.data?.configured && (
          <Space wrap align="center">
            <BudgetMeter status={status.data} />
            <Button type="primary" icon={<BulbOutlined />} onClick={() => generate.mutate()} loading={generate.isPending} disabled={running} data-testid="generate">
              {running ? 'Analysing…' : all.length ? 'Refresh suggestions' : 'Generate suggestions'}
            </Button>
          </Space>
        )}
      </div>
      {status.isLoading ? (
        <Spin />
      ) : !status.data?.configured ? (
        <AiSetupCard />
      ) : (
        <>
          <AiError error={generate.error instanceof ApiError ? generate.error : null} />
          {running && (
            <Alert style={{ marginBottom: 16 }} type="info" showIcon message={<Thinking label={`${modelLabel(status.data)} is reviewing the last 28 days of analytics and your latest SEO audit… this usually takes under a minute.`} />} />
          )}
          {run?.status === 'failed' && <Alert style={{ marginBottom: 16 }} type="error" showIcon message="The last run failed" description={run.error} />}
          {run?.status === 'completed' && run.dropped.length > 0 && (
            <Alert
              style={{ marginBottom: 16 }}
              type="warning"
              showIcon
              message={
                <>
                  {run.dropped.length} suggestion{run.dropped.length > 1 ? 's were' : ' was'} discarded because their numbers did not match your data.{' '}
                  <Popover title="Discarded" content={<ul style={{ margin: 0, paddingLeft: 18, maxWidth: 420 }}>{run.dropped.map((d, i) => <li key={i}><b>{d.title}</b>: {d.reason}</li>)}</ul>}>
                    <a>Details</a>
                  </Popover>
                </>
              }
            />
          )}
          <Space wrap style={{ marginBottom: 12 }}>
            <Segmented
              value={filter}
              onChange={(v) => setFilter(v as Filter)}
              options={[
                { value: 'open', label: `Open (${all.filter((s) => s.status === 'new' || s.status === 'accepted').length})` },
                { value: 'done', label: `Done (${all.filter((s) => s.status === 'done').length})` },
                { value: 'dismissed', label: `Dismissed (${all.filter((s) => s.status === 'dismissed').length})` },
                { value: 'all', label: 'All' },
              ]}
            />
            {run?.finished_at && <Typography.Text type="secondary">Last analysis {timeAgo(run.finished_at)} · data {run.range_from} → {run.range_to}</Typography.Text>}
          </Space>
          {list.isLoading ? (
            <Spin />
          ) : shown.length ? (
            <div className="stack">{shown.map((s) => <SuggestionCard key={s.id} s={s} siteId={site.id} />)}</div>
          ) : (
            <Empty
              description={
                all.length
                  ? 'Nothing here.'
                  : 'No suggestions yet. Generate them to get prioritised SEO, content and marketing ideas based on your own data — run an SEO audit first for better SEO suggestions.'
              }
            />
          )}
        </>
      )}
    </section>
  );
}
