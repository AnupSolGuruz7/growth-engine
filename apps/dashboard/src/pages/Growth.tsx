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
import { PageHeader } from '../components/PageHeader';

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

const PRIORITY: Record<string, { label: string; cls: string }> = {
  high: { label: 'High priority', cls: 'prio-high' },
  medium: { label: 'Medium priority', cls: 'prio-medium' },
  low: { label: 'Low priority', cls: 'prio-low' },
};

function SuggestionCard({ s, siteId, defaultOpen }: { s: SuggestionDto; siteId: string; defaultOpen?: boolean }) {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [open, setOpen] = useState(!!defaultOpen);
  const set = useMutation({
    mutationFn: (status: SuggestionStatus) => api.updateSuggestion(s.id, status),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['suggestions', siteId] }),
    onError: (e) => message.error((e as Error).message),
  });
  const p = PRIORITY[s.priority]!;
  return (
    <Card size="small" className={`suggestion status-${s.status}`} data-testid="suggestion">
      <div className="sugg-meta">
        <span className={`prio ${p.cls}`}>{p.label}</span>
        <Tag color={AREA[s.area]!.color} bordered={false} style={{ margin: 0 }}>{AREA[s.area]!.label}</Tag>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>effort {s.effort} · confidence {s.confidence}</Typography.Text>
        {s.status !== 'new' && (
          <Tag style={{ marginLeft: 'auto' }} color={s.status === 'done' ? 'green' : s.status === 'accepted' ? 'blue' : undefined}>{s.status}</Tag>
        )}
      </div>
      <div className="sugg-title">{s.title}</div>
      <Typography.Paragraph style={{ marginBottom: 8 }}>{s.action}</Typography.Paragraph>
      {s.copy && (
        <Typography.Paragraph copyable={{ text: s.copy }} className="fix">
          {s.copy}
        </Typography.Paragraph>
      )}
      {s.result && <Result s={s} />}
      <button type="button" className="sugg-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Hide' : 'Why'} &amp; how to measure <span aria-hidden>{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="sugg-details">
          <div>
            <div className="sugg-label">Evidence · checked against your data</div>
            <Evidence items={s.evidence} />
          </div>
          <div>
            <div className="sugg-label">Expected outcome</div>
            <div>{s.expected_outcome}</div>
            <div className="sugg-label" style={{ marginTop: 10 }}>How to measure</div>
            <div>
              Watch <Link to={s.evidence.find((e) => e.ref === s.measurement.metric_ref)?.link ?? '/'}>{humanLabel(s.measurement.label)}</Link>. It should{' '}
              {s.measurement.direction} over {s.measurement.window_days} days (now {fmtValue(s.measurement.metric_ref, s.measurement.baseline)}).
            </div>
            {s.assumptions && (
              <>
                <div className="sugg-label" style={{ marginTop: 10 }}>Assumption</div>
                <Typography.Text type="secondary">{s.assumptions}</Typography.Text>
              </>
            )}
          </div>
        </div>
      )}
      <div className="sugg-actions">
        {s.status !== 'done' && <Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => set.mutate('done')} loading={set.isPending}>Mark done</Button>}
        {s.status === 'new' && <Button size="small" icon={<LikeOutlined />} onClick={() => set.mutate('accepted')} loading={set.isPending}>Accept</Button>}
        {s.status !== 'dismissed' && s.status !== 'done' && <Button size="small" type="text" icon={<CloseOutlined />} onClick={() => set.mutate('dismissed')} loading={set.isPending}>Dismiss</Button>}
        {(s.status === 'dismissed' || s.status === 'done') && <Button size="small" type="link" onClick={() => set.mutate('new')}>Reopen</Button>}
        <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 'auto' }}>suggested {timeAgo(s.created_at)}</Typography.Text>
      </div>
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
      <PageHeader
        title="Growth suggestions"
        description="Prioritised SEO, content and marketing ideas from your last 28 days of traffic and your latest SEO audit. Every number is checked against your data."
        extra={status.data?.configured && (
          <Space wrap align="center">
            <BudgetMeter status={status.data} />
            <Button type="primary" icon={<BulbOutlined />} onClick={() => generate.mutate()} loading={generate.isPending} disabled={running} data-testid="generate">
              {running ? 'Analysing…' : all.length ? 'Refresh suggestions' : 'Generate suggestions'}
            </Button>
          </Space>
        )}
      />
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
            <div className="stack">{shown.map((s, i) => <SuggestionCard key={s.id} s={s} siteId={site.id} defaultOpen={i === 0} />)}</div>
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
