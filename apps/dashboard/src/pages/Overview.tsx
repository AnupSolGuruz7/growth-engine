import { ArrowRightOutlined, BulbOutlined, SearchOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Skeleton, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { KpiCard } from '../components/KpiCard';
import { ReportPage } from '../components/ReportPage';
import { SeverityTag } from '../components/seo/SeoBits';
import { TimeseriesChart } from '../components/TimeseriesChart';
import { fmtDate, fmtDuration, fmtNumber, fmtPct } from '../dates';
import { useCurrentSite, useReport } from '../hooks';
import { CHANNEL_LABELS } from '../labels';
import { viz } from '../theme';

/** Compact ranked list with proportional bars (one series, so no legend) and a link to the full report. */
function GlanceList({ title, to, rows, loading }: { title: string; to: string; rows: { label: string; value: number; hint?: string }[]; loading: boolean }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <Card
      size="small"
      title={title}
      extra={<Link to={to} aria-label={`Open ${title}`}>View all <ArrowRightOutlined /></Link>}
      className="glance"
    >
      {loading ? (
        <Skeleton active paragraph={{ rows: 4 }} title={false} />
      ) : rows.length ? (
        <ul className="glance-list">
          {rows.map((r) => (
            <li key={r.label} title={r.hint}>
              <div className="glance-bar" style={{ width: `${(r.value / max) * 100}%`, background: viz.barTrack, borderLeft: `3px solid ${viz.series1}` }} />
              <span className="glance-label">{r.label}</span>
              <span className="glance-value">{fmtNumber(r.value)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <Typography.Text type="secondary">No data for this period</Typography.Text>
      )}
    </Card>
  );
}

/** The single most useful thing to do next: top open AI suggestion, else top SEO issue, else run an audit. */
function NextAction() {
  const { site } = useCurrentSite();
  const suggestions = useQuery({ queryKey: ['suggestions', site?.id], queryFn: () => api.suggestions(site!.id), enabled: !!site });
  const audits = useQuery({ queryKey: ['seo-audits', site?.id], queryFn: () => api.seoAudits(site!.id), enabled: !!site });
  const audit = audits.data?.find((a) => a.status === 'completed');
  const findings = useQuery({ queryKey: ['seo-findings', audit?.id], queryFn: () => api.seoFindings(audit!.id), enabled: !!audit });
  const top = suggestions.data?.suggestions.find((s) => s.status === 'new' || s.status === 'accepted');
  const finding = findings.data?.[0];

  if (suggestions.isLoading || audits.isLoading) return null;
  let body: React.ReactNode;
  if (top) {
    body = (
      <>
        <div className="next-kicker"><BulbOutlined /> Top growth suggestion</div>
        <div className="next-title">{top.title}</div>
        <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ marginBottom: 8 }}>{top.action}</Typography.Paragraph>
        <Link to="/growth"><Button type="primary" size="small">See suggestions <ArrowRightOutlined /></Button></Link>
      </>
    );
  } else if (finding) {
    body = (
      <>
        <div className="next-kicker"><SearchOutlined /> Top SEO issue · score {audit!.score}/100</div>
        <div className="next-title"><SeverityTag severity={finding.severity} /> {finding.title}</div>
        <Typography.Paragraph type="secondary" ellipsis={{ rows: 2 }} style={{ marginBottom: 8 }}>{finding.suggested_fix}</Typography.Paragraph>
        <Link to="/seo"><Button type="primary" size="small">Open SEO audit <ArrowRightOutlined /></Button></Link>
      </>
    );
  } else {
    body = (
      <>
        <div className="next-kicker"><SearchOutlined /> Next step</div>
        <div className="next-title">Run an SEO audit</div>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          Crawl your site for title, description, link and speed issues, then get AI suggestions based on the results and your traffic.
        </Typography.Paragraph>
        <Link to="/seo"><Button type="primary" size="small">Go to SEO audit <ArrowRightOutlined /></Button></Link>
      </>
    );
  }
  return <Card size="small" className="next-action">{body}</Card>;
}

export function OverviewPage() {
  const { data, isLoading, error } = useReport('overview', api.overview);
  const pages = useReport('pages', api.pages);
  const sources = useReport('sources', api.sources);
  const devices = useReport('devices', api.devices);
  const m = data?.metrics;
  const p = data?.previous?.metrics;
  const d = data?.definitions ?? {};

  const range = data && (
    <>
      {fmtDate(data.range.from)} – {fmtDate(data.range.to)} · days in {data.range.timezone}
      {data.previous && <> · compared with {fmtDate(data.previous.range.from)} – {fmtDate(data.previous.range.to)}</>}
      {data.previous && data.previous.metrics.sessions === 0 && data.metrics.sessions > 0 && <> (no data in that period yet)</>}
    </>
  );

  return (
    <ReportPage title="Overview" description={range ?? 'How much traffic the site gets and how engaged visitors are.'}>
      {error && <Alert type="error" showIcon message={(error as Error).message} style={{ marginBottom: 16 }} />}
      <div className="kpi-grid">
        <KpiCard
          title="Visitors"
          value={m?.visitors}
          previous={p?.visitors}
          format={fmtNumber}
          hint={d.visitors}
          footnote={m && m.estimated_visitors > 0 ? `incl. ${fmtNumber(m.estimated_visitors)} estimated (no consent)` : undefined}
          loading={isLoading}
        />
        <KpiCard title="Sessions" value={m?.sessions} previous={p?.sessions} format={fmtNumber} hint={d.sessions} loading={isLoading} />
        <KpiCard title="Page views" value={m?.pageviews} previous={p?.pageviews} format={fmtNumber} hint={d.pageviews} loading={isLoading} />
        <KpiCard title="Bounce rate" value={m?.bounce_rate} previous={p?.bounce_rate} format={fmtPct} hint={d.bounce} lowerIsBetter loading={isLoading} />
        <KpiCard title="Avg. session" value={m?.avg_session_duration_s} previous={p?.avg_session_duration_s} format={fmtDuration} hint="Time from first to last event in a session." loading={isLoading} />
        <KpiCard title="Pages / session" value={m?.pages_per_session} previous={p?.pages_per_session} format={(n) => n.toFixed(2)} loading={isLoading} />
      </div>
      <div className="overview-main">
        <Card title="Traffic over time" size="small">
          {data ? <TimeseriesChart current={data.timeseries} previous={data.previous?.timeseries} /> : <div style={{ height: 300 }} />}
        </Card>
        <NextAction />
      </div>
      <div className="glance-grid">
        <GlanceList
          title="Top pages"
          to="/pages"
          loading={pages.isLoading}
          rows={(pages.data?.top_pages ?? []).slice(0, 5).map((r) => ({ label: r.page_path, value: r.pageviews, hint: 'page views' }))}
        />
        <GlanceList
          title="Top channels"
          to="/sources"
          loading={sources.isLoading}
          rows={(sources.data?.channels ?? []).slice(0, 5).map((r) => ({ label: CHANNEL_LABELS[r.channel] ?? r.channel, value: r.sessions, hint: 'sessions' }))}
        />
        <GlanceList
          title="Devices"
          to="/devices"
          loading={devices.isLoading}
          rows={(devices.data?.devices ?? []).map((r) => ({ label: r.device_category[0]!.toUpperCase() + r.device_category.slice(1), value: r.sessions, hint: 'sessions' }))}
        />
      </div>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
        Bounce = {d.bounce?.toLowerCase() ?? 'a session with exactly one page view and no other interaction event.'} Attribution:{' '}
        {d.attribution?.toLowerCase()}
      </Typography.Paragraph>
    </ReportPage>
  );
}
