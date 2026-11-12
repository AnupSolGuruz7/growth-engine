import { App, Button, Card, Descriptions, Popconfirm, Space, Switch, Table, Tag, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { SiteDto } from '@growthos/shared-types';
import { api } from '../api';
import { InstallSnippet, VerifyInstall } from '../components/InstallSnippet';
import { timeAgo } from '../dates';
import { useDashboard } from '../store';
import { useSites } from '../hooks';
import { PageHeader } from '../components/PageHeader';

function SiteDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { data: site } = useQuery({ queryKey: ['site', id], queryFn: () => api.site(id) });
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['sites'] });
    await qc.invalidateQueries({ queryKey: ['site', id] });
  };
  const rotate = useMutation({
    mutationFn: () => api.rotatePublicId(id),
    onSuccess: async () => {
      await refresh();
      message.success('New public id issued — update the snippet on the site');
    },
  });
  const status = useMutation({
    mutationFn: (active: boolean) => api.updateSite(id, { status: active ? 'active' : 'inactive' }),
    onSuccess: refresh,
  });
  if (!site) return null;
  return (
    <Card size="small" title={site.name}>
      <Descriptions size="small" column={{ xs: 1, md: 2 }} style={{ marginBottom: 12 }}>
        <Descriptions.Item label="Domain">{site.domain}</Descriptions.Item>
        <Descriptions.Item label="Timezone">{site.timezone}</Descriptions.Item>
        <Descriptions.Item label="Public id">
          <Typography.Text code copyable>{site.public_id}</Typography.Text>
        </Descriptions.Item>
        <Descriptions.Item label="Latest event">{timeAgo(site.last_event_received_at)}</Descriptions.Item>
        <Descriptions.Item label="Accepting events">
          <Switch size="small" checked={site.status === 'active'} loading={status.isPending} onChange={(v) => status.mutate(v)} />
        </Descriptions.Item>
      </Descriptions>
      <InstallSnippet site={site} />
      <Space wrap align="start" style={{ width: '100%', justifyContent: 'space-between' }}>
        <VerifyInstall site={site} />
        <Popconfirm
          title="Rotate the public id?"
          description="The old id stops working immediately. You must update the snippet on the site."
          onConfirm={() => rotate.mutate()}
          okText="Rotate"
        >
          <Button danger loading={rotate.isPending}>Rotate public id</Button>
        </Popconfirm>
      </Space>
    </Card>
  );
}

export function SitesPage() {
  const { data: sites, isLoading } = useSites();
  const { siteId, setSite } = useDashboard();
  const [open, setOpen] = useState<string | null>(siteId);
  const current = open ?? sites?.[0]?.id ?? null;
  return (
    <section>
      <PageHeader title="Sites & install" description="Your websites, their tracking snippet, and whether events are arriving." />
      <div className="stack">
        <Card size="small">
          <Table<SiteDto>
            size="small"
            rowKey="id"
            loading={isLoading}
            dataSource={sites ?? []}
            pagination={false}
            scroll={{ x: 'max-content' }}
            onRow={(r) => ({ onClick: () => setOpen(r.id), style: { cursor: 'pointer' } })}
            rowClassName={(r) => (r.id === current ? 'row-selected' : '')}
            columns={[
              { title: 'Name', dataIndex: 'name' },
              { title: 'Domain', dataIndex: 'domain' },
              { title: 'Timezone', dataIndex: 'timezone' },
              { title: 'Status', dataIndex: 'status', render: (s: string) => <Tag color={s === 'active' ? 'blue' : undefined}>{s}</Tag> },
              {
                title: '',
                key: 'view',
                render: (_, r) => (
                  <Button size="small" type="link" onClick={(e) => { e.stopPropagation(); setSite(r.id); }}>
                    {r.id === siteId ? 'Viewing' : 'View reports'}
                  </Button>
                ),
              },
            ]}
          />
        </Card>
        {current && <SiteDetail key={current} id={current} />}
      </div>
    </section>
  );
}
