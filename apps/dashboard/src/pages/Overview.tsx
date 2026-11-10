import { Alert, Card, Typography } from 'antd';
import { api } from '../api';
import { KpiCard } from '../components/KpiCard';
import { ReportPage } from '../components/ReportPage';
import { TimeseriesChart } from '../components/TimeseriesChart';
import { fmtDate, fmtDuration, fmtNumber, fmtPct } from '../dates';
import { useReport } from '../hooks';

export function OverviewPage() {
  const { data, isLoading, error } = useReport('overview', api.overview);
  const m = data?.metrics;
  const p = data?.previous?.metrics;
  const d = data?.definitions ?? {};

  return (
    <ReportPage title="Overview">
      {error && <Alert type="error" showIcon message={(error as Error).message} style={{ marginBottom: 16 }} />}
      {data && (
        <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
          {fmtDate(data.range.from)} – {fmtDate(data.range.to)} · days in {data.range.timezone}
          {data.previous && <> · compared with {fmtDate(data.previous.range.from)} – {fmtDate(data.previous.range.to)}</>}
        </Typography.Paragraph>
      )}
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
      <Card title="Traffic over time" size="small">
        {data ? (
          <TimeseriesChart current={data.timeseries} previous={data.previous?.timeseries} />
        ) : (
          <div style={{ height: 300 }} />
        )}
      </Card>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
        Bounce = {d.bounce?.toLowerCase() ?? 'a session with exactly one page view and no other interaction event.'} Attribution:{' '}
        {d.attribution?.toLowerCase()}
      </Typography.Paragraph>
    </ReportPage>
  );
}
