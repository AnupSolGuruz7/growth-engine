import { Card, Tag, Typography } from 'antd';
import { useState } from 'react';
import type { EventRow, PropertyBreakdownRow } from '@growthos/shared-types';
import { api } from '../api';
import { BarTable } from '../components/BarTable';
import { ExportButton } from '../components/ExportButton';
import { ReportPage } from '../components/ReportPage';
import { fmtPct } from '../dates';
import { useReport } from '../hooks';

const AUTO = new Set(['page_view', 'outbound_click']);

export function EventsPage() {
  const [selected, setSelected] = useState<string | undefined>();
  const { data, isLoading } = useReport('events', (q) => api.events(q, selected), [selected]);
  return (
    <ReportPage title="Events" description="Custom events and clicks. Select an event to break it down by its properties." extra={<ExportButton report="events" />}>
      <div className="grid-2">
        <Card size="small" title="All events" extra={<Typography.Text type="secondary">Click a row for its properties</Typography.Text>}>
          <BarTable<EventRow>
            rows={data?.events ?? []}
            rowKey={(r) => r.event_name}
            loading={isLoading}
            selectedKey={selected}
            onRowClick={(r) => setSelected(r.event_name === selected ? undefined : r.event_name)}
            label={{
              title: 'Event',
              render: (r) => (
                <>
                  {r.event_name} {AUTO.has(r.event_name) && <Tag bordered={false}>automatic</Tag>}
                </>
              ),
            }}
            value={{ title: 'Count', get: (r) => r.count }}
            extra={[{ title: 'Share', key: 'share', align: 'right', width: 90, render: (_, r) => fmtPct(r.share) }]}
          />
        </Card>
        <Card size="small" title={selected ? `Properties of ${selected}` : 'Properties'}>
          {selected ? (
            <BarTable<PropertyBreakdownRow>
              rows={data?.properties ?? []}
              rowKey={(r) => `${r.key}=${r.value}`}
              loading={isLoading}
              empty="This event has no properties in this period"
              label={{ title: 'Property = value', render: (r) => <><Typography.Text type="secondary">{r.key}</Typography.Text> = {r.value}</> }}
              value={{ title: 'Events', get: (r) => r.count }}
            />
          ) : (
            <Typography.Paragraph type="secondary">Select an event to break it down by its custom properties.</Typography.Paragraph>
          )}
        </Card>
      </div>
    </ReportPage>
  );
}
