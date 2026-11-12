import { Segmented } from 'antd';
import { useState } from 'react';
import { Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { TimeseriesPoint } from '@growthos/shared-types';
import { fmtDate, fmtNumber, fmtPct } from '../dates';
import { viz } from '../theme';

type Metric = 'visitors' | 'sessions' | 'pageviews' | 'bounce_rate';
const METRICS: { value: Metric; label: string }[] = [
  { value: 'visitors', label: 'Visitors' },
  { value: 'sessions', label: 'Sessions' },
  { value: 'pageviews', label: 'Page views' },
  { value: 'bounce_rate', label: 'Bounce rate' },
];

interface Props {
  current: TimeseriesPoint[];
  previous?: TimeseriesPoint[] | null;
}

/**
 * One measure at a time on one axis (no dual axes). The previous period is aligned by day index,
 * drawn dashed in the second categorical slot, and named in the legend.
 */
export function TimeseriesChart({ current, previous }: Props) {
  const [metric, setMetric] = useState<Metric>('visitors');
  const fmt = metric === 'bounce_rate' ? fmtPct : fmtNumber;
  const rows = current.map((p, i) => ({
    date: p.date,
    current: p[metric],
    previous: previous?.[i]?.[metric],
    previousDate: previous?.[i]?.date,
  }));
  const label = METRICS.find((m) => m.value === metric)!.label;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
        <Segmented size="small" options={METRICS} value={metric} onChange={(v) => setMetric(v as Metric)} />
      </div>
      <div style={{ width: '100%', height: 280 }} role="img" aria-label={`${label} per day`}>
        <ResponsiveContainer>
          <AreaChart data={rows} margin={{ top: 8, right: 28, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={viz.grid} />
            <XAxis
              dataKey="date"
              tickFormatter={fmtDate}
              tick={{ fill: viz.textSecondary, fontSize: 12 }}
              axisLine={{ stroke: viz.grid }}
              tickLine={false}
              minTickGap={24}
            />
            <YAxis
              tickFormatter={(v: number) => (metric === 'bounce_rate' ? `${Math.round(v * 100)}%` : fmtNumber(v))}
              tick={{ fill: viz.textSecondary, fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              width={48}
              allowDecimals={false}
              domain={metric === 'bounce_rate' ? [0, 1] : [0, 'auto']}
            />
            <Tooltip
              cursor={{ stroke: viz.axis, strokeWidth: 1 }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const r = payload[0]!.payload as (typeof rows)[number];
                return (
                  <div className="chart-tooltip">
                    <div className="tt-row">
                      <span className="tt-swatch" style={{ background: viz.series1 }} />
                      <span>{fmtDate(r.date)}</span>
                      <b>{fmt(r.current)}</b>
                    </div>
                    {r.previous !== undefined && r.previousDate && (
                      <div className="tt-row">
                        <span className="tt-swatch dashed" style={{ borderColor: viz.series2 }} />
                        <span>{fmtDate(r.previousDate)}</span>
                        <b>{fmt(r.previous)}</b>
                      </div>
                    )}
                  </div>
                );
              }}
            />
            {previous && (
              <Legend
                verticalAlign="top"
                align="right"
                height={28}
                iconType="plainline"
                formatter={(v) => <span style={{ color: viz.textSecondary, fontSize: 12 }}>{v}</span>}
              />
            )}
            <defs>
              <linearGradient id="fill-current" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={viz.series1} stopOpacity={0.35} />
                <stop offset="100%" stopColor={viz.series1} stopOpacity={0.04} />
              </linearGradient>
              <linearGradient id="fill-previous" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={viz.series2} stopOpacity={0.16} />
                <stop offset="100%" stopColor={viz.series2} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            {previous && (
              <Area
                type="monotone"
                name="Previous period"
                dataKey="previous"
                stroke={viz.series2}
                strokeWidth={2}
                strokeDasharray="5 4"
                fill="url(#fill-previous)"
                dot={false}
                activeDot={{ r: 4, strokeWidth: 2, stroke: viz.surface }}
                isAnimationActive={false}
              />
            )}
            <Area
              type="monotone"
              name={previous ? 'Selected period' : label}
              dataKey="current"
              stroke={viz.series1}
              strokeWidth={2}
              fill="url(#fill-current)"
              dot={rows.length <= 2 ? { r: 4 } : false}
              activeDot={{ r: 5, strokeWidth: 2, stroke: viz.surface }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
