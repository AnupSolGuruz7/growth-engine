import { PlayCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  Alert, App, Button, Card, Descriptions, Drawer, Empty, Form, Input, InputNumber, List, Popover, Progress, Result,
  Segmented, Select, Space, Spin, Table, Tabs, Tag, Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { SeoAuditDto, SeoFindingDto, SeoPageRow, SeoSeverity } from '@growthos/shared-types';
import { api, ApiError } from '../api';
import { DraftFix, canDraft } from '../components/seo/DraftFix';
import { CATEGORY_LABEL, Evidence, SerpPreview, SeverityTag, scoreBand, shortUrl } from '../components/seo/SeoBits';
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
            {s.pagespeed.tested ? `${s.pagespeed.tested} pages tested` : <Typography.Text type="secondary">{s.pagespeed.skipped_reason === 'private_host' ? 'not available for local sites' : s.pagespeed.skipped_reason ?? '—'}</Typography.Text>}
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
            {canDraft(finding) && <DraftFix key={finding.id} finding={finding} />}
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

function FindingsTab({ audit }: { audit: SeoAuditDto }) {
  const { data, isLoading } = useQuery({ queryKey: ['seo-findings', audit.id], queryFn: () => api.seoFindings(audit.id) });
  const resolved = useQuery({
    queryKey: ['seo-compare', audit.id, audit.previous_audit_id],
    queryFn: () => api.seoCompare(audit.id, audit.previous_audit_id!),
    enabled: !!audit.previous_audit_id,
  });
  const [severity, setSeverity] = useState<SeoSeverity | 'all'>('all');
  const [category, setCategory] = useState<string>('all');
  const [open, setOpen] = useState<SeoFindingDto | null>(null);
  const rows = useMemo(
    () => (data ?? []).filter((f) => (severity === 'all' || f.severity === severity) && (category === 'all' || f.category === category)),
    [data, severity, category],
  );
  return (
    <>
      <Space wrap style={{ marginBottom: 12 }}>
        <Segmented
          size="small"
          value={severity}
          onChange={(v) => setSeverity(v as SeoSeverity | 'all')}
          options={[{ value: 'all', label: `All (${data?.length ?? 0})` }, ...SEV_ORDER.map((s) => ({ value: s, label: `${s[0]!.toUpperCase()}${s.slice(1)} (${(data ?? []).filter((f) => f.severity === s).length})` }))]}
        />
        <Select size="small" value={category} onChange={setCategory} style={{ width: 150 }} aria-label="Category"
          options={[{ value: 'all', label: 'All categories' }, ...Object.entries(CATEGORY_LABEL).map(([value, label]) => ({ value, label }))]} />
      </Space>
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
                <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{shortUrl(r.url)}</Typography.Text></div>
              </>
            ),
          },
          { title: 'Category', dataIndex: 'category', width: 110, render: (c: string) => CATEGORY_LABEL[c] },
          { title: 'Page views (28d)', dataIndex: 'pageviews_28d', width: 130, align: 'right', render: (v: number) => (v ? fmtNumber(v) : '—') },
          { title: 'Priority', dataIndex: 'priority', width: 90, align: 'right', render: (v: number) => v.toFixed(1) },
        ]}
      />
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

  if (!site) return null;
  return (
    <section>
      <div className="page-head">
        <Typography.Title level={3} style={{ margin: 0 }}>SEO audit</Typography.Title>
        <Space wrap>
          {list.filter((a) => a.status === 'completed').length > 1 && (
            <Select
              size="middle"
              style={{ width: 230 }}
              value={audit?.id}
              onChange={setSelected}
              aria-label="Audit"
              options={list.filter((a) => a.status === 'completed').map((a) => ({ value: a.id, label: `${new Date(a.finished_at!).toLocaleString()} · score ${a.score}` }))}
            />
          )}
          <Button icon={<ReloadOutlined />} onClick={() => audits.refetch()} aria-label="Refresh" />
          <RunAuditButton siteId={site.id} domain={site.domain} running={!!running} />
        </Space>
      </div>

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

