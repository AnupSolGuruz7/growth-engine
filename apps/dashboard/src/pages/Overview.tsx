import {
  ArrowRightOutlined, ClockCircleOutlined, EyeOutlined, FileTextOutlined, LoginOutlined, RollbackOutlined, TeamOutlined,
} from '@ant-design/icons';
import { Alert, Card, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { DeviceDonut, MeterList, ProgressList, StatStrip } from '../components/home/Charts';
import {
  AskCard, GrowthCard, InsightsCard, KeyEventsCard, LiveNowCard, SeoHealthCard, computeInsights,
} from '../components/home/HomeCards';
import { ReportPage } from '../components/ReportPage';
import { TimeseriesChart } from '../components/TimeseriesChart';
import { fmtDate, fmtDuration, fmtNumber, fmtPct, timeAgo } from '../dates';
import { useCurrentSite, useRangeQuery, useReport } from '../hooks';
import { CHANNEL_LABELS } from '../labels';

const viewAll = (to: string) => (
  <Link to={to} className="card-link">
    View all <ArrowRightOutlined />
  </Link>
);

/**
 * Home dashboard: every feature in short — headline numbers, traffic trend, live visitors,
 * plain-language insights, key events, SEO health, AI suggestions, Ask AI, and where traffic
 * comes from and goes.
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
  const insights = computeInsights(data, pages.data, sources.data, devices.data, events.data);
  const last = detail.data?.last_event_received_at ?? null;
  const channelTotal = (sources.data?.channels ?? []).reduce((s, c) => s + c.sessions, 0);

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

      <StatStrip
        loading={isLoading}
        stats={[
          {
            key: 'visitors', icon: <TeamOutlined />, label: 'Visitors', value: m?.visitors, previous: p?.visitors, format: fmtNumber,
            hint: d.visitors, accent: true,
            footnote: m && m.estimated_visitors > 0 ? `incl. ${fmtNumber(m.estimated_visitors)} estimated` : undefined,
          },
          { key: 'sessions', icon: <LoginOutlined />, label: 'Sessions', value: m?.sessions, previous: p?.sessions, format: fmtNumber, hint: d.sessions },
          { key: 'page-views', icon: <EyeOutlined />, label: 'Page views', value: m?.pageviews, previous: p?.pageviews, format: fmtNumber, hint: d.pageviews },
          { key: 'bounce-rate', icon: <RollbackOutlined />, label: 'Bounce rate', value: m?.bounce_rate, previous: p?.bounce_rate, format: fmtPct, hint: d.bounce, lowerIsBetter: true },
          { key: 'avg-session', icon: <ClockCircleOutlined />, label: 'Avg. session', value: m?.avg_session_duration_s, previous: p?.avg_session_duration_s, format: fmtDuration, hint: 'Time from first to last event in a session.' },
          { key: 'pages-session', icon: <FileTextOutlined />, label: 'Pages / session', value: m?.pages_per_session, previous: p?.pages_per_session, format: (n) => n.toFixed(2) },
        ]}
      />

      <div className="home-row home-row-main">
        <Card
          size="small"
          className="home-card"
          title={
            <span>
              Traffic activity <span className="title-sub">daily, {data ? `${fmtDate(data.range.from)} – ${fmtDate(data.range.to)}` : 'selected period'}</span>
            </span>
          }
        >
          {data ? <TimeseriesChart current={data.timeseries} previous={data.previous?.timeseries} /> : <div style={{ height: 300 }} />}
        </Card>
        <LiveNowCard />
      </div>

      <div className="home-row home-row-insights">
        <InsightsCard insights={insights} loading={isLoading || pages.isLoading || sources.isLoading} />
        <KeyEventsCard q={q} />
      </div>

      <div className="home-row home-row-3">
        <Card size="small" className="home-card" title={<span>Top pages <span className="title-sub">page views</span></span>} extra={viewAll('/pages')}>
          <MeterList
            unit="page views"
            loading={pages.isLoading}
            rows={(pages.data?.top_pages ?? []).slice(0, 6).map((r) => ({ label: r.page_path, value: r.pageviews }))}
          />
        </Card>
        <Card size="small" className="home-card" title={<span>Channel performance <span className="title-sub">sessions</span></span>} extra={viewAll('/sources')}>
          <ProgressList
            total={channelTotal}
            loading={sources.isLoading}
            rows={(sources.data?.channels ?? []).slice(0, 5).map((r) => ({ label: CHANNEL_LABELS[r.channel] ?? r.channel, value: r.sessions }))}
          />
        </Card>
        <Card size="small" className="home-card" title={<span>Device usage <span className="title-sub">sessions</span></span>} extra={viewAll('/devices')}>
          <DeviceDonut loading={devices.isLoading} rows={devices.data?.devices ?? []} />
        </Card>
      </div>

      <div className="home-row home-row-3">
        <SeoHealthCard />
        <GrowthCard />
        <AskCard />
      </div>

      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 4 }}>
        Bounce = {d.bounce?.toLowerCase() ?? 'a session with exactly one page view and no other interaction event.'} Attribution:{' '}
        {d.attribution?.toLowerCase()}
      </Typography.Paragraph>
    </ReportPage>
  );
}
