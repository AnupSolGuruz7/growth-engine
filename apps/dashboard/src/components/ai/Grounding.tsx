import { BookOutlined, WarningOutlined } from '@ant-design/icons';
import { Tooltip } from 'antd';
import { Link } from 'react-router-dom';
import type { RuleFlagDto, SourceRef } from '@growthos/shared-types';

/** Knowledge-base passages an AI answer drew on. */
export function Sources({ refs, label = 'From your knowledge base' }: { refs?: SourceRef[]; label?: string }) {
  if (!refs?.length) return null;
  return (
    <div className="ai-sources">
      <BookOutlined /> {label} (<Link to="/knowledge">view</Link>):
      <ul>
        {refs.map((r) => (
          <li key={r.cite}>{r.cite}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Content rules from the knowledge source that the AI's text breaks. Shown, never hidden: the text
 * may legitimately quote a banned phrase (e.g. "avoid saying 'fully compliant'"), so a person decides.
 */
export function RuleFlags({ flags }: { flags?: RuleFlagDto[] }) {
  if (!flags?.length) return null;
  const block = flags.some((f) => f.severity === 'block');
  return (
    <div className="rule-flags" role="note">
      <WarningOutlined /> <b>{block ? 'Check before using:' : 'Style notes:'}</b> this text matches {flags.length === 1 ? 'a rule' : `${flags.length} rules`} from your
      knowledge base{block ? ' (it may only be quoting what to avoid)' : ''}.
      <ul>
        {flags.map((f) => (
          <li key={f.kind + f.rule_id}>
            <Tooltip title={f.why || undefined}>
              <span style={{ borderBottom: f.why ? '1px dotted currentColor' : undefined }}>“{f.quoted}”</span>
            </Tooltip>{' '}
            — {f.kind === 'word' ? 'banned word' : 'banned claim'} <code>{f.rule_id}</code>
            {f.severity === 'warn' && ' (advisory)'}
          </li>
        ))}
      </ul>
    </div>
  );
}
