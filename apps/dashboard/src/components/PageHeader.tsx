import { Typography } from 'antd';
import type { ReactNode } from 'react';

/** Title + one-line description of what the page answers, with actions on the right. */
export function PageHeader({ title, description, extra }: { title: string; description?: ReactNode; extra?: ReactNode }) {
  return (
    <div className="page-head">
      <div style={{ minWidth: 0 }}>
        <Typography.Title level={3} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        {description && <div className="page-sub">{description}</div>}
      </div>
      {extra && <div className="page-actions">{extra}</div>}
    </div>
  );
}
