import { DownloadOutlined } from '@ant-design/icons';
import { App, Button } from 'antd';
import { useState } from 'react';
import type { ExportReport } from '@growthos/shared-types';
import { api } from '../api';
import { useRangeQuery } from '../hooks';

/** Exports exactly the site + date range on screen. */
export function ExportButton({ report }: { report: ExportReport }) {
  const q = useRangeQuery();
  const [busy, setBusy] = useState(false);
  const { message } = App.useApp();
  return (
    <Button
      icon={<DownloadOutlined />}
      size="small"
      loading={busy}
      disabled={!q}
      onClick={async () => {
        setBusy(true);
        try {
          await api.downloadCsv(report, q!);
        } catch (e) {
          message.error((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      Export CSV
    </Button>
  );
}
