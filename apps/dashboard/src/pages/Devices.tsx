import { Card } from 'antd';
import type { DeviceRow } from '@growthos/shared-types';
import { api } from '../api';
import { BarTable } from '../components/BarTable';
import { ReportPage } from '../components/ReportPage';
import { fmtNumber, fmtPct } from '../dates';
import { useReport } from '../hooks';

const LABEL: Record<string, string> = { desktop: 'Desktop', mobile: 'Mobile', tablet: 'Tablet', unknown: 'Unknown' };

export function DevicesPage() {
  const { data, isLoading } = useReport('devices', api.devices);
  return (
    <ReportPage title="Devices">
      <Card size="small" title="Device category">
        <BarTable<DeviceRow>
          rows={data?.devices ?? []}
          rowKey={(r) => r.device_category}
          loading={isLoading}
          label={{ title: 'Device', render: (r) => LABEL[r.device_category] ?? r.device_category }}
          value={{ title: 'Sessions', get: (r) => r.sessions }}
          extra={[
            { title: 'Share', key: 'share', align: 'right', width: 90, render: (_, r) => fmtPct(r.share) },
            { title: 'Visitors', key: 'v', align: 'right', width: 100, render: (_, r) => fmtNumber(r.visitors) },
            { title: 'Bounce rate', key: 'br', align: 'right', width: 110, render: (_, r) => fmtPct(r.bounce_rate) },
          ]}
        />
      </Card>
    </ReportPage>
  );
}
