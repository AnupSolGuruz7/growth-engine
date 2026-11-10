import { Card, Tag } from 'antd';
import type { CampaignRow, ChannelRow, ReferrerRow } from '@growthos/shared-types';
import { api } from '../api';
import { BarTable } from '../components/BarTable';
import { ExportButton } from '../components/ExportButton';
import { ReportPage } from '../components/ReportPage';
import { fmtNumber, fmtPct } from '../dates';
import { useReport } from '../hooks';
import { CHANNEL_LABELS } from '../labels';

const bounceCol = <T extends { bounce_rate: number }>() => ({
  title: 'Bounce rate',
  key: 'br',
  align: 'right' as const,
  width: 110,
  render: (_: unknown, r: T) => fmtPct(r.bounce_rate),
});

export function SourcesPage() {
  const { data, isLoading } = useReport('sources', api.sources);
  return (
    <ReportPage title="Sources" extra={<ExportButton report="sources" />}>
      <div className="stack">
        <Card size="small" title="Channels">
          <BarTable<ChannelRow>
            rows={data?.channels ?? []}
            rowKey={(r) => r.channel}
            loading={isLoading}
            label={{ title: 'Channel', render: (r) => CHANNEL_LABELS[r.channel] ?? r.channel }}
            value={{ title: 'Sessions', get: (r) => r.sessions }}
            extra={[
              { title: 'Visitors', key: 'v', align: 'right', width: 100, render: (_, r) => fmtNumber(r.visitors) },
              bounceCol<ChannelRow>(),
            ]}
          />
        </Card>
        <div className="grid-2">
          <Card size="small" title="Referrers">
            <BarTable<ReferrerRow>
              rows={data?.referrers ?? []}
              rowKey={(r) => `${r.referrer_host}|${r.channel}`}
              loading={isLoading}
              label={{
                title: 'Referrer',
                render: (r) => (
                  <>
                    {r.referrer_host} <Tag bordered={false}>{CHANNEL_LABELS[r.channel]}</Tag>
                  </>
                ),
              }}
              value={{ title: 'Sessions', get: (r) => r.sessions }}
              extra={[bounceCol<ReferrerRow>()]}
            />
          </Card>
          <Card size="small" title="UTM campaigns">
            <BarTable<CampaignRow>
              rows={data?.campaigns ?? []}
              rowKey={(r) => `${r.source}|${r.medium}|${r.campaign}`}
              loading={isLoading}
              empty="No tagged (utm_*) traffic in this period"
              label={{ title: 'Campaign · source / medium', render: (r) => `${r.campaign || '(none)'} · ${r.source || '—'} / ${r.medium || '—'}` }}
              value={{ title: 'Sessions', get: (r) => r.sessions }}
              extra={[bounceCol<CampaignRow>()]}
            />
          </Card>
        </div>
      </div>
    </ReportPage>
  );
}
