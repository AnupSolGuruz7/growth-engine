import {
  BookOutlined, CloudSyncOutlined, DatabaseOutlined, FileTextOutlined, FolderOpenOutlined, GoogleOutlined, SafetyCertificateOutlined, SearchOutlined,
} from '@ant-design/icons';
import { Alert, App, Button, Card, Empty, Form, Input, Popconfirm, Progress, Segmented, Space, Table, Tag, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { GscSummaryDto, KnowledgeHit, KnowledgeResponse, KnowledgeSourceDto } from '@growthos/shared-types';
import { api, ApiError } from '../api';
import { StatStrip } from '../components/home/Charts';
import { PageHeader } from '../components/PageHeader';
import { fmtNumber, timeAgo } from '../dates';
import { useCurrentSite } from '../hooks';
import { viz } from '../theme';

const STATUS: Record<KnowledgeSourceDto['status'], { color: string; label: string }> = {
  idle: { color: 'default', label: 'Not synced' },
  queued: { color: 'processing', label: 'Queued' },
  syncing: { color: 'processing', label: 'Syncing' },
  ready: { color: 'success', label: 'Ready' },
  failed: { color: 'error', label: 'Sync failed' },
};
const busy = (s: KnowledgeSourceDto | null | undefined) => s?.status === 'queued' || s?.status === 'syncing';
const fmtBytes = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : (e as Error).message);
/** Passages are Markdown; show them as plain text (quote markers, heading hashes, emphasis, link URLs removed). */
const plain = (md: string) =>
  md
    .replace(/^\s*>\s?/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

function ConnectForm({ siteId, data, initial, onDone }: { siteId: string; data: KnowledgeResponse; initial?: KnowledgeSourceDto; onDone?: () => void }) {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const connect = useMutation({
    mutationFn: (v: { name: string; root_path: string }) => api.connectKnowledge(siteId, v),
    onSuccess: () => {
      message.success('Connected — syncing now');
      void qc.invalidateQueries({ queryKey: ['knowledge', siteId] });
      void qc.invalidateQueries({ queryKey: ['sites'] });
      onDone?.();
    },
  });
  if (!data.allowed_roots.length) {
    return (
      <Alert
        type="info"
        showIcon
        message="Knowledge folders are not enabled on this server"
        description={
          <>
            Add <code>KNOWLEDGE_ALLOWED_ROOTS=&lt;folder&gt;</code> to the root <code>.env</code> (the folder or folders knowledge may be read
            from) and restart the API. GrowthOS never reads folders outside that list.
          </>
        }
      />
    );
  }
  return (
    <Form
      layout="vertical"
      initialValues={{ name: initial?.name ?? 'Growth knowledge', root_path: initial?.root_path ?? '' }}
      onFinish={(v) => connect.mutate(v)}
      requiredMark={false}
    >
      <Form.Item name="name" label="Name" rules={[{ required: true, message: 'Give it a name' }]}>
        <Input placeholder="e.g. Growth engine repo" maxLength={120} />
      </Form.Item>
      <Form.Item
        name="root_path"
        label="Folder on this machine"
        extra={<>Allowed under: {data.allowed_roots.map((r) => <code key={r} style={{ marginRight: 6 }}>{r}</code>)}</>}
        rules={[{ required: true, message: 'Enter the folder path' }]}
      >
        <Input placeholder={`${data.allowed_roots[0]}/my-growth-repo`} prefix={<FolderOpenOutlined />} />
      </Form.Item>
      {connect.error && <Alert type="error" showIcon message={errMsg(connect.error)} style={{ marginBottom: 12 }} />}
      <Space>
        <Button type="primary" htmlType="submit" loading={connect.isPending} icon={<CloudSyncOutlined />}>
          {initial ? 'Save and re-sync' : 'Connect and sync'}
        </Button>
        {onDone && <Button onClick={onDone}>Cancel</Button>}
      </Space>
    </Form>
  );
}

function SearchBox({ siteId }: { siteId: string }) {
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const res = useQuery({
    queryKey: ['knowledge-search', siteId, submitted],
    queryFn: () => api.searchKnowledge(siteId, submitted),
    enabled: submitted.length >= 2,
  });
  const examples = ['What must we never claim?', 'Pricing plans', 'Pages to build for investors'];
  return (
    <Card size="small" title={<span>Try a search <span className="title-sub">what the AI would read</span></span>} className="home-card">
      <Input.Search
        placeholder="Ask the knowledge base…"
        enterButton={<SearchOutlined />}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onSearch={(v) => setSubmitted(v.trim())}
        loading={res.isFetching}
        aria-label="Search the knowledge base"
      />
      {!submitted && (
        <div className="kb-examples">
          {examples.map((e) => (
            <Button key={e} size="small" onClick={() => (setQ(e), setSubmitted(e))}>
              {e}
            </Button>
          ))}
        </div>
      )}
      {res.error && <Alert type="error" showIcon message={errMsg(res.error)} style={{ marginTop: 12 }} />}
      {res.data && res.data.length === 0 && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No matching passages" />}
      <ol className="kb-hits">
        {(res.data ?? []).slice(0, 5).map((h: KnowledgeHit) => (
          <li key={h.id}>
            <div className="kb-hit-cite">
              <FileTextOutlined /> <span title={h.cite}>{h.cite}</span>
              <Tag bordered={false} color={h.match === 'both' ? 'green' : h.match === 'keyword' ? 'blue' : 'default'}>
                {h.match === 'both' ? 'meaning + words' : h.match === 'keyword' ? 'exact words' : 'meaning'}
              </Tag>
            </div>
            <Typography.Paragraph className="kb-hit-text" ellipsis={{ rows: 4, expandable: true, symbol: 'more' }}>
              {plain(h.content)}
            </Typography.Paragraph>
          </li>
        ))}
      </ol>
    </Card>
  );
}

type GscView = 'opportunities' | 'queries' | 'pages';

function GscCard({ siteId }: { siteId: string }) {
  const [view, setView] = useState<GscView>('opportunities');
  const { data, isLoading } = useQuery({ queryKey: ['gsc', siteId], queryFn: () => api.gscSummary(siteId) });
  if (!isLoading && (!data || data.totals.queries === 0) && !data?.top_pages.length) return null;
  const rows: (GscSummaryDto['top_queries'][number] & { key: string })[] =
    view === 'pages'
      ? (data?.top_pages ?? []).map((p) => {
          let path = p.page;
          try {
            path = new URL(p.page).pathname;
          } catch {
            /* keep */
          }
          return { ...p, query: path, key: p.page };
        })
      : (view === 'queries' ? data?.top_queries ?? [] : data?.opportunities ?? []).map((r) => ({ ...r, key: r.query }));
  const period = view === 'pages' ? data?.page_days : data?.query_days;
  return (
    <Card
      size="small"
      className="home-card"
      title={
        <span>
          <GoogleOutlined /> Search Console snapshot <span className="title-sub">imported{period ? `, last ${period} days before export` : ''} · not live</span>
        </span>
      }
    >
      {data && data.monthly.length > 1 && (
        <div style={{ width: '100%', height: 150, marginBottom: 12 }} role="img" aria-label="Google clicks per month">
          <ResponsiveContainer>
            <BarChart data={data.monthly} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke={viz.grid} />
              <XAxis dataKey="month" tick={{ fill: viz.textSecondary, fontSize: 11 }} tickLine={false} axisLine={{ stroke: viz.grid }} minTickGap={16} />
              <YAxis tick={{ fill: viz.textSecondary, fontSize: 11 }} tickLine={false} axisLine={false} width={36} allowDecimals={false} />
              <Tooltip
                cursor={{ fill: viz.barTrack }}
                content={({ active, payload }) =>
                  active && payload?.length ? (
                    <div className="chart-tooltip">
                      <div className="tt-row">
                        <span className="tt-swatch" style={{ background: viz.series1 }} />
                        <span>{(payload[0]!.payload as { month: string }).month}</span>
                        <b>{fmtNumber(payload[0]!.value as number)} clicks</b>
                      </div>
                      <div className="tt-row" style={{ color: viz.textSecondary }}>
                        {fmtNumber((payload[0]!.payload as { impressions: number }).impressions)} impressions
                      </div>
                    </div>
                  ) : null
                }
              />
              <Bar dataKey="clicks" name="Clicks" fill={viz.series1} radius={[6, 6, 0, 0]} maxBarSize={28} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
      <Segmented<GscView>
        size="small"
        value={view}
        onChange={setView}
        options={[
          { value: 'opportunities', label: 'Near page 1' },
          { value: 'queries', label: 'Top queries' },
          { value: 'pages', label: 'Top pages' },
        ]}
        style={{ marginBottom: 8 }}
      />
      {view === 'opportunities' && (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '0 0 6px' }}>
          Queries ranking 4–20 with at least 20 impressions — the closest search wins.
        </Typography.Paragraph>
      )}
      <Table
        size="small"
        loading={isLoading}
        rowKey="key"
        pagination={false}
        dataSource={rows}
        scroll={{ x: 460 }}
        columns={[
          { title: view === 'pages' ? 'Page' : 'Query', dataIndex: 'query', ellipsis: true },
          { title: 'Impr.', dataIndex: 'impressions', align: 'right', width: 80, render: fmtNumber },
          { title: 'Clicks', dataIndex: 'clicks', align: 'right', width: 70, render: fmtNumber },
          { title: 'Position', dataIndex: 'position', align: 'right', width: 80, render: (v: number | null) => (v === null ? '—' : v.toFixed(1)) },
        ]}
      />
    </Card>
  );
}

/**
 * Knowledge base: connect a local folder (a growth / content-strategy repo), sync it into a vector
 * index, and see exactly what the AI can draw on — documents, content rules, Search Console data.
 */
export function KnowledgePage() {
  const { site } = useCurrentSite();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [editing, setEditing] = useState(false);
  const [filter, setFilter] = useState('');
  const { data, isLoading, error } = useQuery({
    queryKey: ['knowledge', site?.id],
    queryFn: () => api.knowledge(site!.id),
    enabled: !!site,
    refetchInterval: (q) => (busy(q.state.data?.source) ? 2000 : false),
  });
  const sync = useMutation({
    mutationFn: () => api.syncKnowledge(site!.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['knowledge', site?.id] }),
    onError: (e) => message.error(errMsg(e)),
  });
  const disconnect = useMutation({
    mutationFn: () => api.disconnectKnowledge(site!.id),
    onSuccess: () => {
      message.success('Knowledge source removed');
      void qc.invalidateQueries({ queryKey: ['knowledge', site?.id] });
      void qc.invalidateQueries({ queryKey: ['gsc', site?.id] });
    },
  });
  if (!site) return null;
  const src = data?.source ?? null;
  const st = src?.stats;
  const docs = (data?.documents ?? []).filter((d) => !filter || d.path.toLowerCase().includes(filter.toLowerCase()) || d.title.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div>
      <PageHeader
        title="Knowledge base"
        description={
          <>
            Your own plans, brand facts and content rules for <b>{site.name}</b>. Growth suggestions, Ask AI and SEO fix drafts read them before
            answering, cite them, and check their copy against your rules.
          </>
        }
        extra={
          src && (
            <Button type="primary" icon={<CloudSyncOutlined />} loading={sync.isPending || busy(src)} onClick={() => sync.mutate()} data-testid="kb-sync">
              {busy(src) ? 'Syncing…' : 'Sync now'}
            </Button>
          )
        }
      />
      {error && <Alert type="error" showIcon message={errMsg(error)} style={{ marginBottom: 16 }} />}

      {!isLoading && data && (!src || editing) && (
        <Card size="small" title={src ? 'Change folder' : 'Connect a knowledge folder'} style={{ maxWidth: 720, marginBottom: 16 }}>
          {!src && (
            <Typography.Paragraph type="secondary">
              Point GrowthOS at a folder of Markdown — a growth repo, content plans, brand guidelines, research. It is split into passages and
              embedded <b>on this machine</b> (free, no API key) into a vector index. Search Console exports (JSON) and rule files (
              <code>rules/*.mjs</code>, read as text, never run) are imported too. Folders such as <code>.git</code>, <code>node_modules</code>,{' '}
              <code>secrets</code> and <code>.env</code> files are always skipped.
            </Typography.Paragraph>
          )}
          <ConnectForm siteId={site.id} data={data} initial={src ?? undefined} onDone={src ? () => setEditing(false) : undefined} />
        </Card>
      )}

      {src && (
        <>
          <Card size="small" className="kb-source" style={{ marginBottom: 16 }}>
            <div className="kb-source-row">
              <div style={{ minWidth: 0 }}>
                <div className="kb-source-name">
                  <BookOutlined /> {src.name} <Tag color={STATUS[src.status].color}>{STATUS[src.status].label}</Tag>
                </div>
                <Typography.Text type="secondary" className="kb-path" title={src.root_path}>
                  <FolderOpenOutlined /> {src.root_path}
                </Typography.Text>
                <div className="kb-meta">
                  {src.last_synced_at ? <>Last synced {timeAgo(src.last_synced_at)}</> : 'Not synced yet'}
                  {st && <> · {(st.duration_ms / 1000).toFixed(st.duration_ms < 10_000 ? 1 : 0)} s{st.embedded ? `, ${fmtNumber(st.embedded)} passages embedded` : ', nothing changed'}</>}
                  {src.embedding_model && <> · embeddings: {src.embedding_model.split('/').pop()} (local)</>}
                </div>
              </div>
              <Space wrap>
                <Button size="small" onClick={() => setEditing((v) => !v)} disabled={busy(src)}>
                  Change folder
                </Button>
                <Popconfirm
                  title="Remove this knowledge source?"
                  description="Deletes its passages, rules and Search Console snapshot from GrowthOS. Your folder is not touched."
                  okText="Remove"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => disconnect.mutate()}
                >
                  <Button size="small" danger disabled={busy(src)}>
                    Remove
                  </Button>
                </Popconfirm>
              </Space>
            </div>
            {busy(src) && (
              <div style={{ marginTop: 12 }}>
                <Progress
                  percent={src.progress?.total ? Math.round((src.progress.done / src.progress.total) * 100) : 0}
                  status="active"
                  strokeColor={viz.series1}
                  format={() => (src.progress?.total ? `${fmtNumber(src.progress.done)} / ${fmtNumber(src.progress.total)}` : '')}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {src.progress?.phase === 'embedding'
                    ? 'Embedding passages on this machine — the first sync of a large folder takes a few minutes; later syncs only redo changed files.'
                    : src.progress?.phase === 'importing'
                      ? 'Importing rules and Search Console data…'
                      : 'Reading the folder…'}
                </Typography.Text>
              </div>
            )}
            {src.status === 'failed' && <Alert type="error" showIcon message="Sync failed" description={src.error} style={{ marginTop: 12 }} />}
          </Card>

          <StatStrip
            loading={isLoading}
            stats={[
              { key: 'kb-docs', icon: <FileTextOutlined />, label: 'Documents', value: st?.documents, format: fmtNumber, accent: true, footnote: st ? `${fmtNumber(st.files)} files scanned` : undefined },
              { key: 'kb-chunks', icon: <DatabaseOutlined />, label: 'Passages', value: st?.chunks, format: fmtNumber, footnote: st ? `≈${fmtNumber(Math.round(st.tokens / 1000))}k tokens` : undefined },
              { key: 'kb-words', icon: <SafetyCertificateOutlined />, label: 'Banned words', value: st?.rules.words, format: fmtNumber, footnote: 'checked in AI copy' },
              { key: 'kb-claims', icon: <SafetyCertificateOutlined />, label: 'Claim rules', value: st?.rules.claims, format: fmtNumber, footnote: 'checked in AI copy' },
              { key: 'kb-gsc-q', icon: <GoogleOutlined />, label: 'Search queries', value: st?.gsc.queries, format: fmtNumber, footnote: 'Search Console snapshot' },
              { key: 'kb-gsc-p', icon: <GoogleOutlined />, label: 'Search pages', value: st?.gsc.pages, format: fmtNumber, footnote: st?.gsc.months ? `${st.gsc.months} months of trend` : 'Search Console snapshot' },
            ]}
          />

          <div className="home-row kb-row">
            <SearchBox siteId={site.id} />
            <GscCard siteId={site.id} />
          </div>

          <Card
            size="small"
            title={<span>Documents <span className="title-sub">{fmtNumber(data?.documents.length ?? 0)} indexed</span></span>}
            extra={<Input size="small" allowClear placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 180 }} aria-label="Filter documents" />}
          >
            <Table
              size="small"
              rowKey="path"
              dataSource={docs}
              pagination={{ pageSize: 12, hideOnSinglePage: true, showSizeChanger: false }}
              scroll={{ x: 640 }}
              columns={[
                {
                  title: 'Document',
                  dataIndex: 'path',
                  render: (p: string, d) => (
                    <div style={{ minWidth: 0 }}>
                      <div className="kb-doc-title">{d.title}</div>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{p}</Typography.Text>
                    </div>
                  ),
                },
                { title: 'Passages', dataIndex: 'chunk_count', align: 'right', width: 100, render: fmtNumber },
                { title: 'Size', dataIndex: 'bytes', align: 'right', width: 90, render: fmtBytes },
                { title: 'Modified', dataIndex: 'modified_at', align: 'right', width: 170, render: (v: string | null) => (v ? timeAgo(v) : '—') },
              ]}
            />
          </Card>
        </>
      )}
    </div>
  );
}
