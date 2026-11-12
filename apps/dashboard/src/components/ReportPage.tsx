import { Alert, Result, Spin } from 'antd';
import type { ReactNode } from 'react';
import { useCurrentSite } from '../hooks';
import { NoDataYet } from './InstallSnippet';
import { PageHeader } from './PageHeader';

/**
 * Wraps every report: handles "API unreachable", "no sites yet" and "site never received an event"
 * (install snippet + verify) before rendering the report body.
 */
export function ReportPage({ title, description, extra, children }: { title: string; description?: ReactNode; extra?: ReactNode; children: ReactNode }) {
  const { site, detail, isLoading, error, sites } = useCurrentSite();
  let body: ReactNode = children;
  if (error) body = <Alert type="error" showIcon message="Could not load sites" description={(error as Error).message} />;
  else if (isLoading) body = <Spin style={{ display: 'block', margin: '80px auto' }} />;
  else if (!sites?.length || !site)
    body = <Result status="info" title="No sites yet" subTitle='Use "Add site" in the header to register your first website.' />;
  else if (detail.data && !detail.data.last_event_received_at) body = <NoDataYet site={detail.data} />;

  return (
    <section>
      <PageHeader title={title} description={description} extra={site && detail.data?.last_event_received_at ? extra : undefined} />
      {body}
    </section>
  );
}
