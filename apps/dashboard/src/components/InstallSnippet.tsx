import { CheckCircleFilled, ClockCircleOutlined } from '@ant-design/icons';
import { Alert, Button, Space, Tabs, Typography } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { SiteDetailDto } from '@growthos/shared-types';
import { api } from '../api';
import { timeAgo } from '../dates';

/** Copy-paste install code for a site (script tag + npm). */
export function InstallSnippet({ site }: { site: SiteDetailDto }) {
  return (
    <Tabs
      size="small"
      items={[
        {
          key: 'script',
          label: 'Script tag',
          children: (
            <>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                Paste into the <code>&lt;head&gt;</code> of every page.
              </Typography.Paragraph>
              <Typography.Paragraph copyable={{ text: site.install.script_tag }} className="snippet">
                <pre>{site.install.script_tag}</pre>
              </Typography.Paragraph>
            </>
          ),
        },
        {
          key: 'npm',
          label: 'npm / SPA',
          children: (
            <Typography.Paragraph copyable={{ text: site.install.npm }} className="snippet">
              <pre>{site.install.npm}</pre>
            </Typography.Paragraph>
          ),
        },
      ]}
    />
  );
}

/** "Verify install": re-reads the site's latest received event time from the API. */
export function VerifyInstall({ site }: { site: SiteDetailDto }) {
  const qc = useQueryClient();
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const verify = async () => {
    setChecking(true);
    try {
      const fresh = await api.site(site.id);
      qc.setQueryData(['site', site.id], fresh);
      if (fresh.last_event_received_at) await qc.invalidateQueries();
    } finally {
      setChecking(false);
      setChecked(true);
    }
  };
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Button type="primary" onClick={verify} loading={checking} data-testid="verify-install">
        Verify installation
      </Button>
      {site.last_event_received_at ? (
        <Alert
          type="success"
          showIcon
          icon={<CheckCircleFilled />}
          message={`Receiving events — latest received ${timeAgo(site.last_event_received_at)}`}
        />
      ) : (
        checked && (
          <Alert
            type="warning"
            showIcon
            icon={<ClockCircleOutlined />}
            message="No events received yet"
            description="Load a page that has the snippet, wait a few seconds, then check again. Ad blockers and the site's CSP (connect-src) can block the request."
          />
        )
      )}
    </Space>
  );
}

/** Shown instead of reports while a site has never received an event. */
export function NoDataYet({ site }: { site: SiteDetailDto }) {
  return (
    <div className="empty-state" data-testid="no-data-yet">
      <Typography.Title level={4} style={{ marginTop: 0 }}>
        No data yet — install the snippet
      </Typography.Title>
      <Typography.Paragraph type="secondary">
        Add GrowthOS to <b>{site.domain}</b>. Reports appear here as soon as the first events are processed (usually within a few
        seconds).
      </Typography.Paragraph>
      <InstallSnippet site={site} />
      <VerifyInstall site={site} />
    </div>
  );
}
