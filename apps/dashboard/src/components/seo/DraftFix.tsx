import { ThunderboltOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Space, Typography } from 'antd';
import { useMutation } from '@tanstack/react-query';
import type { DraftDto, SeoFindingDto } from '@growthos/shared-types';
import { api } from '../../api';
import { AiError, Thinking } from '../ai/AiBits';
import { RuleFlags, Sources } from '../ai/Grounding';

// Mirrors DRAFTABLE_CHECKS in shared-types (the dashboard imports types only).
const DRAFTABLE = new Set([
  'title_missing', 'title_length', 'title_duplicate', 'meta_description_missing', 'meta_description_length',
  'meta_description_duplicate', 'h1_missing', 'h1_multiple', 'images_missing_alt', 'bold_as_heading',
  'structured_data_missing', 'thin_content',
]);
const FIELD: Record<string, string> = {
  title: 'Title', meta_description: 'Meta description', h1: 'H1', heading: 'Heading', alt_text: 'Alt text',
  structured_data: 'Structured data (JSON-LD)', content_outline: 'Content outline',
};
const LIMIT: Record<string, [number, number]> = { title: [30, 60], meta_description: [70, 160] };

export const canDraft = (f: SeoFindingDto) => DRAFTABLE.has(f.check_id);

/** "Draft fix with AI": ready-to-paste copy for one finding. The client applies it themselves. */
export function DraftFix({ finding }: { finding: SeoFindingDto }) {
  const draft = useMutation({ mutationFn: (regenerate: boolean) => api.draftFix(finding.id, regenerate) });
  const d: DraftDto | undefined = draft.data;
  return (
    <div>
      {!d && !draft.isPending && (
        <Button icon={<ThunderboltOutlined />} onClick={() => draft.mutate(false)} data-testid="draft-fix">Draft fix with AI</Button>
      )}
      {draft.isPending && <Thinking label="Writing copy from the page content…" />}
      <AiError error={draft.error} />
      {d && (
        <Card size="small" title="AI draft — review before using" extra={<Button size="small" type="link" onClick={() => draft.mutate(true)}>Regenerate</Button>}>
          <Space direction="vertical" style={{ width: '100%' }}>
            {d.drafts.map((x, i) => {
              const lim = LIMIT[x.field];
              const off = lim && (x.length < lim[0] || x.length > lim[1]);
              return (
                <div key={i}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {FIELD[x.field] ?? x.field} · {x.length} chars{off ? ` (aim for ${lim![0]}–${lim![1]})` : ''}
                  </Typography.Text>
                  <Typography.Paragraph copyable={{ text: x.value }} className="fix" style={{ marginBottom: 2 }}>{x.value}</Typography.Paragraph>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{x.note}</Typography.Text>
                  <RuleFlags flags={d.rule_flags?.find((r) => r.index === i)?.flags} />
                </div>
              );
            })}
            {d.caution && <Alert type="warning" showIcon message={d.caution} />}
            <Sources refs={d.sources} label='Brand context used' />
          </Space>
        </Card>
      )}
    </div>
  );
}
