import { Card, Table, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { RealtimeEvent } from '@growthos/shared-types';
import { api } from '../api';
import { BarTable } from '../components/BarTable';
import { ReportPage } from '../components/ReportPage';
import { timeAgo } from '../dates';
import { useCurrentSite } from '../hooks';

export function RealtimePage() {
  const { site } = useCurrentSite();
  const { data, isLoading, dataUpdatedAt } = useQuery({
    queryKey: ['realtime', site?.id],
    queryFn: () => api.realtime(site!.id),
    enabled: !!site,
    refetchInterval: 10_000,
  });
  return (
    <ReportPage title="Realtime">
      <div className="grid-2" style={{ marginBottom: 16 }}>
        <Card size="small">
          <Typography.Text type="secondary">
            <span className="pulse" aria-hidden />
            Active visitors · last {data?.window_minutes ?? 5} minutes
          </Typography.Text>
          <div className="big-number" data-testid="active-visitors" style={{ margin: '12px 0 6px' }}>
            {data?.active_visitors ?? '—'}
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {data ? `${data.pageviews_last_window} page views · latest event received ${timeAgo(data.last_event_received_at)}` : ' '}
            {dataUpdatedAt ? ` · refreshed ${new Date(dataUpdatedAt).toLocaleTimeString()}` : ''}
          </Typography.Text>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8, marginBottom: 0 }}>
            Read from raw events (not rollups). Visitors without consent are counted per page visit, so this is an estimate.
          </Typography.Paragraph>
        </Card>
        <Card size="small" title="Active pages">
          <BarTable
            rows={data?.top_active_pages ?? []}
            rowKey={(r) => r.page_path}
            loading={isLoading}
            empty="Nobody on the site right now"
            label={{ title: 'Page', render: (r) => r.page_path }}
            value={{ title: 'Visitors', get: (r) => r.visitors }}
            pageSize={5}
          />
        </Card>
      </div>
      <Card size="small" title="Latest events">
        <Table<RealtimeEvent>
          size="small"
          rowKey="event_id"
          loading={isLoading}
          dataSource={data?.latest_events ?? []}
          pagination={false}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: 'No events in the last 24 hours' }}
          columns={[
            { title: 'Received', dataIndex: 'received_at', render: (v: string) => timeAgo(v), width: 120 },
            { title: 'Event', dataIndex: 'event_name', render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
            { title: 'Page', dataIndex: 'page_path' },
            { title: 'Device', dataIndex: 'device_category' },
            {
              title: 'Consent',
              dataIndex: 'consent_state',
              render: (v: string) => <Tag bordered={false} color={v === 'granted' ? 'blue' : undefined}>{v}</Tag>,
            },
          ]}
        />
      </Card>
    </ReportPage>
  );
}
