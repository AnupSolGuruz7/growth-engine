import { App, Button, Form, Input, Modal, Select, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { SiteDetailDto } from '@growthos/shared-types';
import { api, ApiError } from '../api';
import { useDashboard } from '../store';
import { InstallSnippet, VerifyInstall } from './InstallSnippet';

const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export function AddSiteModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [form] = Form.useForm<{ name: string; domain: string; timezone: string }>();
  const [created, setCreated] = useState<SiteDetailDto | null>(null);
  const qc = useQueryClient();
  const setSite = useDashboard((s) => s.setSite);
  const { message } = App.useApp();
  // live view of the new site, so Verify installation re-renders with the latest event time
  const live = useQuery({ queryKey: ['site', created?.id], queryFn: () => api.site(created!.id), enabled: !!created });
  const timezones = useMemo(() => {
    const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
    return ['UTC', ...all.filter((z) => z !== 'UTC')].map((z) => ({ value: z, label: z }));
  }, []);

  const create = useMutation({
    mutationFn: api.createSite,
    onSuccess: async (site) => {
      setCreated(site);
      setSite(site.id);
      qc.setQueryData(['site', site.id], site);
      await qc.invalidateQueries({ queryKey: ['sites'] });
    },
    onError: (e) => message.error(e instanceof ApiError ? e.message : 'Could not create the site'),
  });

  const close = () => {
    form.resetFields();
    setCreated(null);
    onClose();
  };

  return (
    <Modal
      title={created ? `Install GrowthOS on ${created.domain}` : 'Add a site'}
      open={open}
      onCancel={close}
      destroyOnHidden
      footer={created ? <Button onClick={close}>Done</Button> : undefined}
      onOk={() => form.submit()}
      okText="Create site"
      confirmLoading={create.isPending}
      width={640}
    >
      {created ? (
        <>
          <Typography.Paragraph>
            Public site id: <Typography.Text code copyable>{created.public_id}</Typography.Text>{' '}
            <Typography.Text type="secondary">(not a secret)</Typography.Text>
          </Typography.Paragraph>
          <InstallSnippet site={created} />
          <VerifyInstall site={live.data ?? created} />
        </>
      ) : (
        <Form form={form} layout="vertical" initialValues={{ timezone: browserTz }} onFinish={(v) => create.mutate(v)} requiredMark={false}>
          <Form.Item name="name" label="Name" rules={[{ required: true, message: 'Give the site a name' }]}>
            <Input placeholder="Marketing site" autoFocus />
          </Form.Item>
          <Form.Item name="domain" label="Domain" rules={[{ required: true, message: 'Enter the domain' }]} extra="e.g. example.com â€” used to recognise internal referrers">
            <Input placeholder="example.com" />
          </Form.Item>
          <Form.Item name="timezone" label="Reporting timezone" extra="Days in every report start at midnight in this timezone.">
            <Select showSearch options={timezones} />
          </Form.Item>
        </Form>
      )}
    </Modal>
  );
}
