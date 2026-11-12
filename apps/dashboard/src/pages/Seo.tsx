import { PlayCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  Alert, App, Button, Card, Collapse, Descriptions, Drawer, Empty, Form, Grid, Input, InputNumber, List, Popover, Progress,
  Result, Segmented, Select, Space, Spin, Table, Tabs, Tag, Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SeoAuditDto, SeoFindingDto, SeoPageRow, SeoSeverity } from '@growthos/shared-types';
import { api, ApiError } from '../api';
import { DraftFix, canDraft } from '../components/seo/DraftFix';
import { PageHeader } from '../components/PageHeader';
import { CATEGORY_LABEL, CHECK_LABEL, Evidence, SerpPreview, SeverityTag, scoreBand, shortUrl } from '../components/seo/SeoBits';
import { fmtNumber, timeAgo } from '../dates';
import { useCurrentSite } from '../hooks';

const SEV_ORDER: SeoSeverity[] = ['critical', 'high', 'medium', 'low'];

function RunAuditButton({ siteId, domain, running }: { siteId: string; domain: string; running: boolean }) {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [form] = Form.useForm<{ start_url?: string; max_pages?: number }>();
  const [open, setOpen] = useState(false);
  const start = useMutation({
    mutationFn: (v: { start_url?: string; max_pages?: number }) =>
      api.startSeoAudit({ site_id: siteId, start_url: v.start_url || undefined, max_pages: v.max_pages || undefined }),
    onSuccess: async () => {
      setOpen(false);
      message.success('Audit started');
      await qc.invalidateQueries({ queryKey: ['seo-audits', siteId] });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : 'Could not start the audit'),
  });
  return (
    <Space.Compact>
      <Button type="primary" icon={<PlayCircleOutlined />} loading={start.isPending} disabled={running} onClick={() => start.mutate({})} data-testid="run-audit">
        {running ? 'Audit running…' : 'Run audit'}
      </Button>
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger="click"
        placement="bottomRight"
        title="Audit options"
        content={
          <Form form={form} layout="vertical" style={{ width: 300 }} onFinish={(v) => start.mutate(v)}>
            <Form.Item name="start_url" label="Start URL" extra={`Must be on ${domain}. Defaults to the homepage.`}>
              <Input placeholder={`https://${domain}/`} />
            </Form.Item>
            <Form.Item name="max_pages" label="Max pages" initialValue={500}>
              <InputNumber min={1} max={500} style={{ width: '100%' }} />
            </Form.Item>
            <Button htmlType="submit" type="primary" block disabled={running} loading={start.isPending}>
              Start audit
            </Button>
          </Form>
        }
      >
        <Button disabled={running}>Options</Button>
      </Popover>
    </Space.Compact>
  );
}

function ScoreCard({ audit }: { audit: SeoAuditDto }) {
  const s = audit.summary!;
  const band = scoreBand(audit.score ?? 0);
  return (
    <div className="seo-summary">
      <Card size="small" className="seo-score">
        <Typography.Text type="secondary">SEO health score</Typography.Text>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '6px 0' }}>
          <span className="big-number" data-testid="seo-score">{audit.score}</span>
          <span style={{ color: band.color, fontWeight: 600 }}>{band.label}</span>
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {fmtNumber(s.pages.crawled)} pages crawled · {fmtNumber(s.pages.indexable)} indexable · finished {timeAgo(audit.finished_at)}
        </Typography.Text>
        {audit.comparison && (
          <div style={{ marginTop: 10, fontSize: 13 }}>
            vs previous audit: <b>{audit.comparison.new}</b> new · <b>{audit.comparison.resolved}</b> resolved · {audit.comparison.unchanged} unchanged
          </div>
        )}
      </Card>
      <Card size="small" title="Issues by severity">
        {SEV_ORDER.map((sev) => (
          <div key={sev} className="sev-row">
            <SeverityTag severity={sev} />
            <b>{s.by_severity[sev]}</b>
          </div>
        ))}
      </Card>
      <Card size="small" title="Site checks">
        <Descriptions size="small" column={1}>
          <Descriptions.Item label="robots.txt">{s.robots.found ? 'Found' : <Tag color="orange">Missing</Tag>}</Descriptions.Item>
          <Descriptions.Item label="Sitemap">
            {s.sitemap.found ? (s.sitemap.valid ? `${fmtNumber(s.sitemap.urls)} URLs` : <Tag color="red">Invalid</Tag>) : <Tag color="orange">Missing</Tag>}
          </Descriptions.Item>
          <Descriptions.Item label="Errors / redirects">{s.pages.errors} / {s.pages.redirects}</Descriptions.Item>
          <Descriptions.Item label="Blocked by robots">{s.pages.blocked_by_robots}</Descriptions.Item>
          <Descriptions.Item label="Core Web Vitals">
            {s.pagespeed.tested ? `${s.pagespeed.tested} pages tested` : <Typography.Text type="secondary">{s.pagespeed.skipped_reason === 'private_host' ? 'not available for local sites' : s.pagespeed.skipped_reason === 'disabled' ? 'turned off (PAGESPEED_ENABLED)' : s.pagespeed.skipped_reason === 'pagespeed_unavailable' ? 'Google PageSpeed did not respond. Add a free PAGESPEED_API_KEY.' : s.pagespeed.skipped_reason ?? '—'}</Typography.Text>}
          </Descriptions.Item>
        </Descriptions>
      </Card>
    </div>
  );
}

function FindingDrawer({ finding, onClose }: { finding: SeoFindingDto | null; onClose: () => void }) {
  return (
    <Drawer open={!!finding} onClose={onClose} width={Math.min(640, window.innerWidth)} title={finding?.title} destroyOnHidden>
      {finding && (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Space wrap>
            <SeverityTag severity={finding.severity} />
            <Tag bordered={false}>{CATEGORY_LABEL[finding.category]}</Tag>
            {finding.change === 'new' && <Tag color="blue">New since last audit</Tag>}
            <Typography.Text type="secondary">confidence {Math.round(finding.confidence * 100)}% · effort {['', 'minutes', 'hours', 'developer'][finding.effort]}</Typography.Text>
          </Space>
          <div>
            <Typography.Text type="secondary">Page</Typography.Text>
            <div>
              <a href={finding.url} target="_blank" rel="noopener noreferrer">{finding.url}</a>
              {finding.pageviews_28d > 0 && <Typography.Text type="secondary"> · {fmtNumber(finding.pageviews_28d)} page views in 28 days</Typography.Text>}
            </div>
          </div>
          <div>
            <Typography.Title level={5}>Why it matters</Typography.Title>
            <Typography.Paragraph>{finding.explanation}</Typography.Paragraph>
          </div>
          <div>
            <Typography.Title level={5}>Evidence</Typography.Title>
            <Evidence value={finding.evidence} />
          </div>
          <div>
            <Typography.Title level={5}>Suggested fix</Typography.Title>
            <Typography.Paragraph copyable={{ text: finding.suggested_fix }} className="fix">
              {finding.suggested_fix}
            </Typography.Paragraph>
            {canDraft(finding) ? (
              <DraftFix key={finding.id} finding={finding} />
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                AI drafts are available for title, meta description, heading, image alt text, structured data and thin-content issues.
              </Typography.Text>
            )}
          </div>
          {finding.limits && <Alert type="info" showIcon message={finding.limits} />}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Suggestions only — GrowthOS never changes your site. Apply the fix yourself, then re-run the audit to confirm.
          </Typography.Text>
        </Space>
      )}
    </Drawer>
  );
}

interface IssueGroup {
  check: string;
  label: string;
  severity: SeoSeverity;
  findings: SeoFindingDto[];
  pageviews: number;
  priority: number;
  isNew: number;
}

/** One group per issue type, highest-priority first (severity, then traffic affected). */
function groupFindings(findings: SeoFindingDto[]): IssueGroup[] {
  const by = new Map<string, SeoFindingDto[]>();
  for (const f of findings) by.set(f.check_id, [...(by.get(f.check_id) ?? []), f]);
  return [...by.entries()]
    .map(([check, fs]) => ({
      check,
      label: CHECK_LABEL[check] ?? fs[0]!.title,
      severity: SEV_ORDER.find((s) => fs.some((f) => f.severity === s))!,
      findings: fs,
      pageviews: fs.reduce((s, f) => s + f.pageviews_28d, 0),
      priority: fs.reduce((s, f) => s + f.priority, 0),
      isNew: fs.filter((f) => f.change === 'new').length,
    }))
    .sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity) || b.priority - a.priority);
}

function IssueGroups({ groups, loading, onOpen }: { groups: IssueGroup[]; loading: boolean; onOpen: (f: SeoFindingDto) => void }) {
  const [shown, setShown] = useState<Record<string, number>>({});
  if (loading) return <Spin style={{ display: 'block', margin: '40px auto' }} />;
  if (!groups.length) return <Empty description="No issues match — nice work" />;
  return (
    <Collapse
      className="issue-groups"
      expandIconPosition="end"
      items={groups.map((g) => {
        const limit = shown[g.check] ?? 10;
        const sample = g.findings[0]!;
        return {
          key: g.check,
          label: (
            <div className="issue-head">
              <SeverityTag severity={g.severity} />
              <div style={{ minWidth: 0 }}>
                <div className="issue-label">{g.label}</div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {g.findings.length === 1 ? shortUrl(sample.url) : `${g.findings.length} pages`}
                  {g.pageviews > 0 && ` · ${fmtNumber(g.pageviews)} page views affected`}
                  {g.isNew > 0 && ` · ${g.isNew} new`}
                </Typography.Text>
              </div>
              {canDraft(sample) && <Tag bordered={false} color="purple" className="issue-ai">AI draft</Tag>}
            </div>
          ),
          children: (
            <div>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 6 }}>{sample.explanation}</Typography.Paragraph>
              <Typography.Paragraph style={{ marginBottom: 10 }}><b>Fix:</b> {sample.suggested_fix}</Typography.Paragraph>
              <ul className="issue-pages">
                {g.findings.slice(0, limit).map((f) => (
                  <li key={f.id}>
                    <button type="button" onClick={() => onOpen(f)} className="linklike">
                      <span className="ellipsis-block">{shortUrl(f.url)}</span>
                      <Typography.Text type="secondary" style={{ fontSize: 12, flex: 'none' }}>
                        {f.title !== g.label && f.title !== sample.title ? f.title : ''}
                        {f.pageviews_28d ? ` ${fmtNumber(f.pageviews_28d)} views` : ''}
                      </Typography.Text>
                    </button>
                  </li>
                ))}
              </ul>
              {g.findings.length > limit && (
                <Button size="small" type="link" onClick={() => setShown({ ...shown, [g.check]: limit + 50 })}>
                  Show {Math.min(50, g.findings.length - limit)} more of {g.findings.length - limit}
                </Button>
              )}
            </div>
          ),
        };
      })}
    />
  );
}

function FindingsTab({ audit }: { audit: SeoAuditDto }) {
  const { data, isLoading } = useQuery({ queryKey: ['seo-findings', audit.id], queryFn: () => api.seoFindings(audit.id) });
  const resolved = useQuery({
    queryKey: ['seo-compare', audit.id, audit.previous_audit_id],
    queryFn: () => api.seoCompare(audit.id, audit.previous_audit_id!),
    enabled: !!audit.previous_audit_id,
  });
  const [severity, setSeverity] = useState<SeoSeverity | 'all'>('all');
  const [category, setCategory] = useState<string>('all');
  const [view, setView] = useState<'issues' | 'all'>('issues');
  const [open, setOpen] = useState<SeoFindingDto | null>(null);
  const screens = Grid.useBreakpoint();
  const rows = useMemo(
    () => (data ?? []).filter((f) => (severity === 'all' || f.severity === severity) && (category === 'all' || f.category === category)),
    [data, severity, category],
  );
  const groups = useMemo(() => groupFindings(rows), [rows]);
  const count = (s: SeoSeverity) => (data ?? []).filter((f) => f.severity === s).length;
  return (
    <>
      <div className="findings-toolbar">
        <Segmented
          value={view}
          onChange={(v) => setView(v as 'issues' | 'all')}
          options={[
            { value: 'issues', label: `By issue (${groupFindings(data ?? []).length})` },
            { value: 'all', label: `All findings (${data?.length ?? 0})` },
          ]}
        />
        <Space wrap size={8}>
          <Select
            value={severity}
            onChange={setSeverity}
            style={{ width: 150 }}
            aria-label="Severity"
            options={[{ value: 'all', label: 'All severities' }, ...SEV_ORDER.map((s) => ({ value: s, label: `${s[0]!.toUpperCase()}${s.slice(1)} (${count(s)})`, disabled: !count(s) }))]}
          />
          <Select value={category} onChange={setCategory} style={{ width: 150 }} aria-label="Category"
            options={[{ value: 'all', label: 'All categories' }, ...Object.entries(CATEGORY_LABEL).map(([value, label]) => ({ value, label }))]} />
        </Space>
      </div>

      {view === 'issues' ? (
        <IssueGroups groups={groups} loading={isLoading} onOpen={setOpen} />
      ) : !screens.md ? (
        <List
          loading={isLoading}
          dataSource={rows}
          pagination={rows.length > 20 ? { pageSize: 20, size: 'small', align: 'center' } : false}
          locale={{ emptyText: <Empty description="No issues match — nice work" /> }}
          renderItem={(r) => (
            <List.Item className="finding-item" onClick={() => setOpen(r)}>
              <div style={{ minWidth: 0, width: '100%' }}>
                <Space size={6} wrap>
                  <SeverityTag severity={r.severity} />
                  {r.change === 'new' && <Tag color="blue" bordered={false}>new</Tag>}
                  {canDraft(r) && <Tag bordered={false} color="purple">AI draft</Tag>}
                </Space>
                <div className="finding-title">{r.title}</div>
                <Typography.Text type="secondary" className="ellipsis-block" style={{ fontSize: 12 }}>
                  {shortUrl(r.url)}{r.pageviews_28d ? ` · ${fmtNumber(r.pageviews_28d)} views` : ''}
                </Typography.Text>
              </div>
            </List.Item>
          )}
        />
      ) : (
        <Table<SeoFindingDto>
          size="small"
          rowKey="id"
          loading={isLoading}
          dataSource={rows}
          scroll={{ x: 'max-content' }}
          pagination={{ pageSize: 25, size: 'small', showSizeChanger: false }}
          onRow={(r) => ({ onClick: () => setOpen(r), style: { cursor: 'pointer' } })}
          locale={{ emptyText: <Empty description="No issues match — nice work" /> }}
          columns={[
            { title: 'Severity', dataIndex: 'severity', width: 110, render: (s: SeoSeverity) => <SeverityTag severity={s} /> },
            {
              title: 'Issue',
              key: 'title',
              render: (_, r) => (
                <>
                  {r.title} {r.change === 'new' && <Tag color="blue" bordered={false}>new</Tag>}
                  {canDraft(r) && <Tag bordered={false} color="purple">AI draft</Tag>}
                  <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{shortUrl(r.url)}</Typography.Text></div>
                </>
              ),
            },
            { title: 'Category', dataIndex: 'category', width: 110, render: (c: string) => CATEGORY_LABEL[c] },
            { title: 'Page views (28d)', dataIndex: 'pageviews_28d', width: 130, align: 'right', render: (v: number) => (v ? fmtNumber(v) : '—') },
          ]}
        />
      )}
      {resolved.data && resolved.data.resolved.length > 0 && (
        <Card size="small" title={`Resolved since the previous audit (${resolved.data.counts.resolved})`} style={{ marginTop: 16 }}>
          <List
            size="small"
            dataSource={resolved.data.resolved.slice(0, 20)}
            renderItem={(f) => (
              <List.Item>
                <Space wrap>
                  <Tag color="green" bordered={false}>resolved</Tag>
                  {f.title} <Typography.Text type="secondary">{shortUrl(f.url)}</Typography.Text>
                </Space>
              </List.Item>
            )}
          />
        </Card>
      )}
      <FindingDrawer finding={open} onClose={() => setOpen(null)} />
    </>
  );
}

function PageDrawer({ auditId, url, onClose }: { auditId: string; url: string | null; onClose: () => void }) {
  const { data, isLoading } = useQuery({ queryKey: ['seo-page', auditId, url], queryFn: () => api.seoPage(auditId, url!), enabled: !!url });
  const [finding, setFinding] = useState<SeoFindingDto | null>(null);
  return (
    <Drawer open={!!url} onClose={onClose} width={Math.min(720, window.innerWidth)} title={url ? shortUrl(url) : ''} destroyOnHidden>
      {isLoading || !data ? (
        <Spin />
      ) : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <SerpPreview url={data.url} title={data.title} description={data.meta_description} />
          <Descriptions size="small" column={1} bordered labelStyle={{ width: 150 }}>
            <Descriptions.Item label="Status">{data.status ?? data.fetch_error ?? (data.blocked_by_robots ? 'blocked by robots.txt' : '—')}</Descriptions.Item>
            <Descriptions.Item label="Indexable">{data.indexable ? 'Yes' : 'No'}</Descriptions.Item>
            <Descriptions.Item label="Title">{data.title ?? <i>missing</i>} {data.title && <Typography.Text type="secondary">({data.title.length} chars)</Typography.Text>}</Descriptions.Item>
            <Descriptions.Item label="Meta description">{data.meta_description ?? <i>missing</i>} {data.meta_description && <Typography.Text type="secondary">({data.meta_description.length} chars)</Typography.Text>}</Descriptions.Item>
            <Descriptions.Item label="Canonical">{data.canonical ?? <i>none</i>}</Descriptions.Item>
            <Descriptions.Item label="Robots">{[data.robots_meta, data.x_robots_tag].filter(Boolean).join(' · ') || 'index, follow (default)'}</Descriptions.Item>
            <Descriptions.Item label="Language">{data.lang ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Words">{data.word_count ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Response">{data.response_ms ? `${data.response_ms} ms` : '—'}{data.bytes ? ` · ${Math.round(data.bytes / 1024)} KB` : ''}</Descriptions.Item>
            <Descriptions.Item label="Links">{data.internal_links} internal · {data.external_links} external · {data.inlinks} pages link here</Descriptions.Item>
            <Descriptions.Item label="Images">{data.images} ({data.images_missing_alt} without alt)</Descriptions.Item>
            <Descriptions.Item label="Structured data">
              {data.structured_data.length ? data.structured_data.map((s, i) => <Tag key={i} color={s.valid ? undefined : 'red'}>{s.valid ? s.types.join(', ') || 'JSON-LD' : 'invalid JSON-LD'}</Tag>) : 'none'}
            </Descriptions.Item>
            <Descriptions.Item label="Traffic">{fmtNumber(data.pageviews_28d)} page views (28 days)</Descriptions.Item>
            <Descriptions.Item label="In sitemap">{data.in_sitemap ? 'Yes' : 'No'}</Descriptions.Item>
          </Descriptions>
          {data.redirect_chain.length > 0 && (
            <Card size="small" title="Redirect chain">
              {data.redirect_chain.map((h, i) => <div key={i}><code>{h.status}</code> {h.url}</div>)}
            </Card>
          )}
          <Card size="small" title="Heading outline">
            {data.headings.length ? (
              <div className="outline">
                {data.headings.map((h, i) => (
                  <div key={i} style={{ paddingLeft: (h.level - 1) * 16 }}>
                    <Typography.Text type="secondary">H{h.level}</Typography.Text> {h.text || <i>(empty)</i>}
                  </div>
                ))}
              </div>
            ) : <Typography.Text type="secondary">No headings</Typography.Text>}
          </Card>
          <Card size="small" title={`Issues on this page (${data.issues.length})`}>
            <List
              size="small"
              dataSource={data.issues}
              locale={{ emptyText: 'No issues found' }}
              renderItem={(f) => (
                <List.Item onClick={() => setFinding(f)} style={{ cursor: 'pointer' }}>
                  <Space wrap><SeverityTag severity={f.severity} /> {f.title}</Space>
                </List.Item>
              )}
            />
          </Card>
        </Space>
      )}
      <FindingDrawer finding={finding} onClose={() => setFinding(null)} />
    </Drawer>
  );
}

function PagesTab({ audit }: { audit: SeoAuditDto }) {
  const { data, isLoading } = useQuery({ queryKey: ['seo-pages', audit.id], queryFn: () => api.seoPages(audit.id) });
  const [open, setOpen] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const rows = (data ?? []).filter((p) => !q || `${p.path} ${p.title ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <Input.Search placeholder="Filter by path or title" allowClear onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320, marginBottom: 12 }} />
      <Table<SeoPageRow>
        size="small"
        rowKey="url"
        loading={isLoading}
        dataSource={rows}
        scroll={{ x: 'max-content' }}
        pagination={{ pageSize: 25, size: 'small', showSizeChanger: false }}
        onRow={(r) => ({ onClick: () => setOpen(r.url), style: { cursor: 'pointer' } })}
        columns={[
          { title: 'Page', dataIndex: 'path', render: (p: string, r) => <><div>{p}</div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.title ?? 'no title'}</Typography.Text></> },
          { title: 'Status', dataIndex: 'status', width: 80, render: (s: number | null, r) => <Tag color={s === 200 ? undefined : s && s < 400 ? 'gold' : 'red'} bordered={false}>{s ?? (r.indexable ? '' : '—')}</Tag> },
          { title: 'Indexable', dataIndex: 'indexable', width: 90, render: (v: boolean) => (v ? 'Yes' : 'No') },
          { title: 'Title len', key: 'tl', width: 80, align: 'right', render: (_, r) => r.title?.length ?? '—' },
          { title: 'Desc len', key: 'dl', width: 80, align: 'right', render: (_, r) => r.meta_description?.length ?? '—' },
          { title: 'H1', key: 'h1', width: 60, align: 'right', render: (_, r) => r.h1.length },
          { title: 'Words', dataIndex: 'word_count', width: 80, align: 'right', render: (v: number | null) => v ?? '—' },
          { title: 'Inlinks', dataIndex: 'inlinks', width: 80, align: 'right' },
          { title: 'Page views (28d)', dataIndex: 'pageviews_28d', width: 130, align: 'right', render: (v: number) => (v ? fmtNumber(v) : '—') },
          { title: 'Issues', dataIndex: 'findings', width: 80, align: 'right' },
        ]}
      />
      <PageDrawer auditId={audit.id} url={open} onClose={() => setOpen(null)} />
    </>
  );
}

export function SeoPage() {
  const { site } = useCurrentSite();
  const [selected, setSelected] = useState<string | null>(null);
  const audits = useQuery({
    queryKey: ['seo-audits', site?.id],
    queryFn: () => api.seoAudits(site!.id),
    enabled: !!site,
    refetchInterval: (q) => (q.state.data?.some((a) => a.status === 'queued' || a.status === 'running') ? 2000 : false),
  });
  const list = audits.data ?? [];
  const running = list.find((a) => a.status === 'queued' || a.status === 'running');
  const audit = list.find((a) => a.id === selected) ?? list.find((a) => a.status === 'completed') ?? null;
  const [tipHidden, setTipHidden] = useState(() => {
    try {
      return localStorage.getItem('growthos-seo-tip') === 'hidden';
    } catch {
      return false;
    }
  });
  const hideTip = () => {
    setTipHidden(true);
    try {
      localStorage.setItem('growthos-seo-tip', 'hidden');
    } catch {
      /* per-browser convenience only */
    }
  };

  if (!site) return null;
  return (
    <section>
      <PageHeader
        title="SEO audit"
        description={`Crawls ${site.domain} like a search engine and lists what to fix, most important first. GrowthOS only reads pages; it never changes your site.`}
        extra={
        <Space wrap>
          {list.filter((a) => a.status === 'completed').length > 1 && (
            <Select
              size="middle"
              style={{ width: 230 }}
              value={audit?.id}
              onChange={setSelected}
              aria-label="Audit"
              options={list.filter((a) => a.status === 'completed').map((a) => ({ value: a.id, label: `${new Date(a.finished_at!).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · score ${a.score}` }))}
            />
          )}
          <Button icon={<ReloadOutlined />} onClick={() => audits.refetch()} aria-label="Refresh" />
          <RunAuditButton siteId={site.id} domain={site.domain} running={!!running} />
        </Space>
        }
      />

      {running && (
        <Alert
          style={{ marginBottom: 16 }}
          type="info"
          showIcon
          message={running.status === 'queued' ? 'Audit queued…' : `Crawling ${running.start_url}`}
          description={
            <Progress
              percent={Math.min(99, Math.round((running.pages_crawled / running.max_pages) * 100))}
              format={() => `${running.pages_crawled} pages`}
              status="active"
            />
          }
        />
      )}
      {list[0]?.status === 'failed' && <Alert style={{ marginBottom: 16 }} type="error" showIcon message="The last audit failed" description={list[0].error} />}

      {audits.isLoading ? (
        <Spin style={{ display: 'block', margin: '80px auto' }} />
      ) : !audit ? (
        !running && (
          <Result
            status="info"
            title="No audit yet"
            subTitle={`Run an audit to crawl ${site.domain}: robots.txt, sitemap, status codes, titles, descriptions, headings, images, structured data and Core Web Vitals. GrowthOS only reads pages — it never changes your site.`}
          />
        )
      ) : (
        <>
          {!tipHidden && <Alert
            style={{ marginBottom: 16 }}
            type="info"
            showIcon
            closable
            onClose={hideTip}
            message={
              <>
                Open a finding for its fix — title, description, heading and alt-text issues have a <b>Draft fix with AI</b> button. For
                prioritised SEO and marketing ideas based on this audit plus your traffic, see <Link to="/growth">Growth suggestions</Link>.
              </>
            }
          />}
          <ScoreCard audit={audit} />
          <Card size="small">
            <Tabs
              items={[
                { key: 'findings', label: 'Findings', children: <FindingsTab audit={audit} /> },
                { key: 'pages', label: 'Pages', children: <PagesTab audit={audit} /> },
              ]}
            />
          </Card>
        </>
      )}
    </section>
  );
}

