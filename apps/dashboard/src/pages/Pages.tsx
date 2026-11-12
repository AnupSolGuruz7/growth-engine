import { Card, Tabs } from 'antd';
import type { EntryExitRow, PageRow } from '@growthos/shared-types';
import { api } from '../api';
import { BarTable } from '../components/BarTable';
import { ExportButton } from '../components/ExportButton';
import { ReportPage } from '../components/ReportPage';
import { fmtDuration, fmtNumber, fmtPct } from '../dates';
import { useReport } from '../hooks';

const entryCols = [
  { title: 'Bounce rate', key: 'br', align: 'right' as const, width: 110, render: (_: unknown, r: EntryExitRow) => fmtPct(r.bounce_rate) },
  { title: 'Avg. session', key: 'dur', align: 'right' as const, width: 110, render: (_: unknown, r: EntryExitRow) => fmtDuration(r.avg_session_duration_s) },
];

export function PagesPage() {
  const { data, isLoading } = useReport('pages', api.pages);
  const path = (r: { page_path: string }) => r.page_path;
  return (
    <ReportPage title="Pages" description="Which pages people view, enter the site on, and leave from." extra={<ExportButton report="pages" />}>
      <Card size="small">
        <Tabs
          items={[
            {
              key: 'top',
              label: 'Top pages',
              children: (
                <BarTable<PageRow>
                  rows={data?.top_pages ?? []}
                  rowKey={path}
                  loading={isLoading}
                  label={{ title: 'Page', render: path }}
                  value={{ title: 'Page views', get: (r) => r.pageviews }}
                  extra={[
                    { title: 'Entrances', key: 'en', align: 'right', width: 100, render: (_, r) => fmtNumber(r.entrances) },
                    { title: 'Exits', key: 'ex', align: 'right', width: 90, render: (_, r) => fmtNumber(r.exits) },
                  ]}
                />
              ),
            },
            {
              key: 'landing',
              label: 'Landing pages',
              children: (
                <BarTable<EntryExitRow>
                  rows={data?.landing_pages ?? []}
                  rowKey={path}
                  loading={isLoading}
                  label={{ title: 'Landing page', render: path }}
                  value={{ title: 'Sessions', get: (r) => r.sessions }}
                  extra={entryCols}
                />
              ),
            },
            {
              key: 'exit',
              label: 'Exit pages',
              children: (
                <BarTable<EntryExitRow>
                  rows={data?.exit_pages ?? []}
                  rowKey={path}
                  loading={isLoading}
                  label={{ title: 'Exit page', render: path }}
                  value={{ title: 'Sessions', get: (r) => r.sessions }}
                  extra={entryCols}
                />
              ),
            },
          ]}
        />
      </Card>
    </ReportPage>
  );
}
