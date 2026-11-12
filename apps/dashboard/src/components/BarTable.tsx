import { Table, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { fmtNumber } from '../dates';
import { viz } from '../theme';

interface Props<T> {
  rows: T[];
  rowKey: (r: T) => string;
  /** Label column (rendered over a bar sized by `value`). */
  label: { title: string; render: (r: T) => React.ReactNode };
  value: { title: string; get: (r: T) => number };
  extra?: ColumnsType<T>;
  loading?: boolean;
  empty?: string;
  onRowClick?: (r: T) => void;
  selectedKey?: string;
  pageSize?: number;
}

/**
 * A ranked breakdown: the table is the chart. Each row carries a single-colour bar proportional to
 * its value (one series, so no legend), with the exact number in ink next to it.
 */
export function BarTable<T extends object>({ rows, rowKey, label, value, extra = [], loading, empty, onRowClick, selectedKey, pageSize = 10 }: Props<T>) {
  const max = Math.max(1, ...rows.map(value.get));
  const total = rows.reduce((s, r) => s + value.get(r), 0);
  const columns: ColumnsType<T> = [
    {
      title: label.title,
      key: 'label',
      render: (_, r) => {
        const v = value.get(r);
        return (
          <Tooltip title={`${fmtNumber(v)} ${value.title.toLowerCase()} · ${total ? ((v / total) * 100).toFixed(1) : 0}%`} placement="topLeft">
            <div className="bar-cell">
              <div className="bar-fill" style={{ width: `${(v / max) * 100}%`, background: viz.barTrack, boxShadow: `inset 3px 0 0 ${viz.series1}` }} />
              <span className="bar-label">{label.render(r)}</span>
            </div>
          </Tooltip>
        );
      },
    },
    { title: value.title, key: 'value', align: 'right', width: 110, render: (_, r) => fmtNumber(value.get(r)) },
    ...extra,
  ];
  return (
    <Table<T>
      size="small"
      rowKey={rowKey}
      columns={columns}
      dataSource={rows}
      loading={loading}
      pagination={rows.length > pageSize ? { pageSize, size: 'small', showSizeChanger: false } : false}
      locale={{ emptyText: empty ?? 'No data for this period' }}
      scroll={{ x: 'max-content' }}
      onRow={onRowClick ? (r) => ({ onClick: () => onRowClick(r), style: { cursor: 'pointer' } }) : undefined}
      rowClassName={(r) => (selectedKey && rowKey(r) === selectedKey ? 'row-selected' : '')}
    />
  );
}
