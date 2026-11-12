import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons';
import { Skeleton, Tooltip, Typography } from 'antd';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip as RTooltip } from 'recharts';
import { fmtNumber, fmtPct } from '../../dates';
import { viz } from '../../theme';

// ------------------------------------------------------------------ KPI strip

export interface Stat {
  key: string;
  icon: React.ReactNode;
  label: string;
  value: number | undefined;
  format: (n: number) => string;
  previous?: number | null;
  /** A decrease is the good direction (bounce rate). */
  lowerIsBetter?: boolean;
  hint?: string;
  /** Draw the value in the accent colour (one headline metric). */
  accent?: boolean;
  footnote?: string;
}

/** One strip of headline numbers separated by rules, each with its change vs the previous period. */
export function StatStrip({ stats, loading }: { stats: Stat[]; loading: boolean }) {
  return (
    <div className="stat-strip" role="list">
      {stats.map((s) => {
        let delta: { pct: number; good: boolean } | null = null;
        if (s.value !== undefined && s.previous && s.previous > 0) {
          const pct = (s.value - s.previous) / s.previous;
          if (Math.abs(pct) >= 0.0005) delta = { pct, good: s.lowerIsBetter ? pct < 0 : pct > 0 };
        }
        return (
          <div className="stat-tile" role="listitem" key={s.key} data-testid={`kpi-${s.key}`}>
            <Tooltip title={s.hint}>
              <div className="stat-label">
                {s.icon} {s.label}
              </div>
            </Tooltip>
            {loading && s.value === undefined ? (
              <Skeleton.Input active size="small" style={{ marginTop: 10, width: 90 }} />
            ) : (
              <div className={`stat-value kpi-value ${s.accent ? 'accent' : ''}`}>{s.value === undefined ? '—' : s.format(s.value)}</div>
            )}
            <div className="stat-change">
              {delta ? (
                <>
                  <span style={{ color: delta.good ? viz.good : viz.critical, fontWeight: 600 }}>
                    {delta.pct > 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />} {Math.abs(delta.pct * 100).toFixed(1)}%
                  </span>{' '}
                  from previous period
                  <span className="sr-only">{delta.good ? ' (better)' : ' (worse)'}</span>
                </>
              ) : (
                s.footnote ?? <span>&nbsp;</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ device donut

const DEVICE_COLOR: Record<string, string> = { desktop: viz.series1, mobile: viz.series2, tablet: viz.series3, unknown: viz.other };
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** Donut + legend table. Slices are few (≤4) and always labelled with name and share. */
export function DeviceDonut({ rows, loading }: { rows: { device_category: string; sessions: number; share: number }[]; loading: boolean }) {
  if (loading) return <Skeleton active paragraph={{ rows: 4 }} title={false} />;
  if (!rows.length) return <Typography.Text type="secondary">No data for this period</Typography.Text>;
  const total = rows.reduce((s, r) => s + r.sessions, 0);
  return (
    <div className="donut-wrap">
      <div className="donut" role="img" aria-label={rows.map((r) => `${cap(r.device_category)} ${fmtPct(r.share)}`).join(', ')}>
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={rows}
              dataKey="sessions"
              nameKey="device_category"
              innerRadius="58%"
              outerRadius="92%"
              paddingAngle={2}
              stroke={viz.surface}
              strokeWidth={2}
              isAnimationActive={false}
            >
              {rows.map((r) => (
                <Cell key={r.device_category} fill={DEVICE_COLOR[r.device_category] ?? viz.other} />
              ))}
            </Pie>
            <RTooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const r = payload[0]!.payload as (typeof rows)[number];
                return (
                  <div className="chart-tooltip">
                    <b>{cap(r.device_category)}</b>: {fmtNumber(r.sessions)} sessions ({fmtPct(r.share)})
                  </div>
                );
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="donut-center">
          <b>{fmtNumber(total)}</b>
          <span>sessions</span>
        </div>
      </div>
      <table className="donut-legend">
        <thead>
          <tr>
            <th>Device</th>
            <th style={{ textAlign: 'right' }}>Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.device_category}>
              <td>
                <span className="swatch" style={{ background: DEVICE_COLOR[r.device_category] ?? viz.other }} aria-hidden /> {cap(r.device_category)}
              </td>
              <td style={{ textAlign: 'right' }}>{fmtPct(r.share)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ bar lists

export interface Meter {
  label: string;
  value: number;
  display?: string;
}

/** Label · bar · value rows (one series, so no legend; the value is printed on every row). */
export function MeterList({ rows, loading, unit }: { rows: Meter[]; loading: boolean; unit: string }) {
  if (loading) return <Skeleton active paragraph={{ rows: 4 }} title={false} />;
  if (!rows.length) return <Typography.Text type="secondary">No data for this period</Typography.Text>;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="meter-list">
      {rows.map((r) => (
        <div className="meter-row" key={r.label} title={`${r.label}: ${fmtNumber(r.value)} ${unit}`}>
          <span className="meter-label">{r.label}</span>
          <span className="meter-track">
            <span className="meter-fill" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
          </span>
          <span className="meter-value">{r.display ?? fmtNumber(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

/** Label above a progress bar, share on the right (campaign-performance style). */
export function ProgressList({ rows, loading, total }: { rows: Meter[]; loading: boolean; total: number }) {
  if (loading) return <Skeleton active paragraph={{ rows: 4 }} title={false} />;
  if (!rows.length) return <Typography.Text type="secondary">No data for this period</Typography.Text>;
  return (
    <div className="progress-list">
      {rows.map((r) => (
        <div key={r.label}>
          <div className="progress-head">
            <span>{r.label}</span>
            <span>
              {fmtNumber(r.value)} <Typography.Text type="secondary">· {total ? fmtPct(r.value / total) : '—'}</Typography.Text>
            </span>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${total ? Math.max(1, (r.value / total) * 100) : 0}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
