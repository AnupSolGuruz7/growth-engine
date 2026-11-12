import { ArrowDownOutlined, ArrowUpOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { Card, Skeleton, Tooltip, Typography } from 'antd';
import { viz } from '../theme';
import { Sparkline } from './home/HomeCards';

interface Props {
  title: string;
  value: number | undefined;
  format: (n: number) => string;
  previous?: number | null;
  /** true when a decrease is the good direction (bounce rate). */
  lowerIsBetter?: boolean;
  hint?: string;
  footnote?: string;
  loading?: boolean;
  /** Daily values for a trend sparkline. */
  spark?: number[];
}

/** Stat tile: one headline number, optional change vs the previous period (arrow + text, never colour alone). */
export function KpiCard({ title, value, format, previous, lowerIsBetter, hint, footnote, loading, spark }: Props) {
  let delta: { pct: number; up: boolean; good: boolean } | null = null;
  if (value !== undefined && previous !== undefined && previous !== null && previous > 0) {
    const pct = (value - previous) / previous;
    if (Math.abs(pct) >= 0.0005) delta = { pct, up: pct > 0, good: lowerIsBetter ? pct < 0 : pct > 0 };
  }
  return (
    <Card size="small" className="kpi" data-testid={`kpi-${title.toLowerCase().replace(/\W+/g, '-')}`}>
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
        {title}{' '}
        {hint && (
          <Tooltip title={hint}>
            <InfoCircleOutlined style={{ fontSize: 12 }} aria-label={`About ${title}`} />
          </Tooltip>
        )}
      </Typography.Text>
      {loading && value === undefined ? (
        <Skeleton.Input active size="small" style={{ marginTop: 8 }} />
      ) : (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginTop: 4 }}>
          <span className="kpi-value">{value === undefined ? '—' : format(value)}</span>
          {delta && (
            <span style={{ color: delta.good ? viz.good : viz.critical, fontSize: 13, fontWeight: 500 }}>
              {delta.up ? <ArrowUpOutlined /> : <ArrowDownOutlined />} {Math.abs(delta.pct * 100).toFixed(1)}%
              <span className="sr-only">{delta.good ? ' (better)' : ' (worse)'} vs previous period</span>
            </span>
          )}
        </div>
      )}
      {spark && <Sparkline values={spark} label={title} />}
      {footnote && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {footnote}
        </Typography.Text>
      )}
    </Card>
  );
}
