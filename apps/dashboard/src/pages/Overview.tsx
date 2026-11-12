import { ArrowRightOutlined } from '@ant-design/icons';
import { Alert, Card, Skeleton, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { api } from '../api';
import {
  AskCard, GrowthCard, InsightsCard, KeyEventsCard, LiveNowCard, SeoHealthCard, computeInsights,
} from '../components/home/HomeCards';
import { KpiCard } from '../components/KpiCard';
import { ReportPage } from '../components/ReportPage';
import { TimeseriesChart } from '../components/TimeseriesChart';
import { fmtDate, fmtDuration, fmtNumber, fmtPct, timeAgo } from '../dates';
import { useCurrentSite, useRangeQuery, useReport } from '../hooks';
import { CHANNEL_LABELS } from '../labels';
import { viz } from '../theme';

/** Compact ranked list with proportional bars (one series, so no legend) and a link to the full report. */
function GlanceList({ title, to, rows, loading }: { title: string; to: string; rows: { label: string; value: number; hint?: string }[]; loading: boolean }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <Card size="small" title={title} extra={<Link to={to} className="card-link">View all <ArrowRightOutlined /></Link>} className="home-card">
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

/**
 * Home dashboard: every feature in short — traffic KPIs with trends, live visitors, plain-language
 * insights, key events, SEO health, AI suggestions, Ask AI, and top pages/channels/devices.
 */
export function OverviewPage() {
  const { detail } = useCurrentSite();
  const q = useRangeQuery();
  const { data, isLoading, error } = useReport('overview', api.overview);
  const pages = useReport('pages', api.pages);
  const sources = useReport('sources', api.sources);
  const devices = useReport('devices', api.devices);
  const events = useReport('events', (rq) => api.events(rq));
  const m = data?.metrics;
  const p = data?.previous?.metrics;
  const d = data?.definitions ?? {};
  const ts = data?.timeseries ?? [];
  const insights = computeInsights(data, pages.data, sources.data, devices.data, events.data);
  const last = detail.data?.last_event_received_at ?? null;

  const description = data ? (
    <>
      {fmtDate(data.range.from)} – {fmtDate(data.range.to)} · days in {data.range.timezone}
      {data.previous && <> · compared with {fmtDate(data.previous.range.from)} – {fmtDate(data.previous.range.to)}</>}
      {data.previous && data.previous.metrics.sessions === 0 && data.metrics.sessions > 0 && <> (no data in that period yet)</>}
      {last && <> · latest event {timeAgo(last)}</>}
    </>
  ) : (
    'Your site at a glance: traffic, live visitors, insights, SEO health and AI suggestions.'
  );

  return (
    <ReportPage title="Dashboard" description={description}>
      {error && <Alert type="error" showIcon message={(error as Error).message} style={{ marginBottom: 16 }} />}

      <div className="kpi-grid">
        <KpiCard
          title="Visitors"
          value={m?.visitors}
          previous={p?.visitors}
          format={fmtNumber}
          hint={d.visitors}
          spark={ts.map((x) => x.visitors)}
          footnote={m && m.estimated_visitors > 0 ? `incl. ${fmtNumber(m.estimated_visitors)} estimated` : undefined}
          loading={isLoading}
        />
        <KpiCard title="Sessions" value={m?.sessions} previous={p?.sessions} format={fmtNumber} hint={d.sessions} spark={ts.map((x) => x.sessions)} loading={isLoading} />
        <KpiCard title="Page views" value={m?.pageviews} previous={p?.pageviews} format={fmtNumber} hint={d.pageviews} spark={ts.map((x) => x.pageviews)} loading={isLoading} />
        <KpiCard title="Bounce rate" value={m?.bounce_rate} previous={p?.bounce_rate} format={fmtPct} hint={d.bounce} lowerIsBetter spark={ts.map((x) => x.bounce_rate)} loading={isLoading} />
        <KpiCard title="Avg. session" value={m?.avg_session_duration_s} previous={p?.avg_session_duration_s} format={fmtDuration} hint="Time from first to last event in a session." loading={isLoading} />
        <KpiCard title="Pages / session" value={m?.pages_per_session} previous={p?.pages_per_session} format={(n) => n.toFixed(2)} loading={isLoading} />
      </div>

      <div className="home-row home-row-main">
        <Card title="Traffic over time" size="small" className="home-card">
          {data ? <TimeseriesChart current={data.timeseries} previous={data.previous?.timeseries} /> : <div style={{ height: 300 }} />}
        </Card>
        <LiveNowCard />
      </div>

      <div className="home-row home-row-insights">
        <InsightsCard insights={insights} loading={isLoading || pages.isLoading || sources.isLoading} />
        <KeyEventsCard q={q} />
      </div>

      <Typography.Title level={5} className="home-section">Grow</Typography.Title>
      <div className="home-row home-row-3">
        <SeoHealthCard />
        <GrowthCard />
        <AskCard />
      </div>

      <Typography.Title level={5} className="home-section">Where traffic goes and comes from</Typography.Title>
      <div className="home-row home-row-3">
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
