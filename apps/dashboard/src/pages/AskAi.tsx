import { MessageOutlined, PlusOutlined, SendOutlined } from '@ant-design/icons';
import { Button, Card, Empty, Input, List, Space, Tag, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { AskTurn, ConversationDto } from '@growthos/shared-types';
import { api } from '../api';
import { RuleFlags, Sources } from '../components/ai/Grounding';
import { AiError, AiMarkdown, AiSetupCard, Thinking, modelLabel, useAiStatus } from '../components/ai/AiBits';
import { timeAgo } from '../dates';
import { useCurrentSite } from '../hooks';
import { PageHeader } from '../components/PageHeader';

const STARTERS = [
  'How did traffic change in the last 28 days compared with the 28 days before?',
  'Which landing pages get traffic but have a high bounce rate?',
  'Which channels bring the most engaged visitors?',
  'What are the most important SEO issues on pages that get traffic?',
  'Which pages lead to signups or enquiries, and which ones never do?',
];

const TOOL_LABEL: Record<string, string> = {
  get_overview: 'Overview', get_top_pages: 'Top pages', get_landing_pages: 'Landing pages', get_traffic_sources: 'Sources',
  get_event_breakdown: 'Events', get_devices: 'Devices', compare_periods: 'Period comparison', get_seo_findings: 'SEO audit',
  search_knowledge: 'Knowledge base', get_search_console: 'Search Console',
};

function Turn({ turn }: { turn: AskTurn }) {
  if (turn.role === 'user') return <div className="chat-user">{turn.text}</div>;
  return (
    <div className="chat-ai">
      <AiMarkdown text={turn.text} />
      {!!turn.tools?.length && (
        <div className="chat-tools">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>Looked at: </Typography.Text>
          {turn.tools.map((t, i) => (
            <Tag key={i} bordered={false} style={{ fontSize: 11 }}>
              {TOOL_LABEL[t.name] ?? t.name}
              {t.input.from ? ` ${t.input.from} → ${t.input.to}` : ''}
              {typeof t.input.query === 'string' ? `: ${t.input.query}` : ''}
            </Tag>
          ))}
        </div>
      )}
      <Sources refs={turn.sources} />
      <RuleFlags flags={turn.rule_flags} />
    </div>
  );
}

export function AskAiPage() {
  const { site } = useCurrentSite();
  const qc = useQueryClient();
  const status = useAiStatus(site?.id);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const conversations = useQuery({ queryKey: ['conversations', site?.id], queryFn: () => api.conversations(site!.id), enabled: !!site && !!status.data?.configured });
  const conversation = useQuery({ queryKey: ['conversation', conversationId], queryFn: () => api.conversation(conversationId!), enabled: !!conversationId });
  const ask = useMutation({
    mutationFn: (q: string) => api.ask(site!.id, q, conversationId),
    onMutate: (q) => setPending(q),
    onSuccess: (c: ConversationDto) => {
      setConversationId(c.id);
      qc.setQueryData(['conversation', c.id], c);
      qc.invalidateQueries({ queryKey: ['conversations', site!.id] });
      qc.invalidateQueries({ queryKey: ['ai-status', site!.id] });
      setQuestion('');
    },
    onSettled: () => setPending(null),
  });
  // Block bodies: an effect must return nothing or a cleanup function, and in recent browsers
  // scrollIntoView() returns a Promise, which React would try to call on unmount.
  useEffect(() => {
    void bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [conversation.data, pending]);
  useEffect(() => {
    setConversationId(undefined);
  }, [site?.id]);
  // a question handed over from the home dashboard: ask it once, then clear it from history
  const location = useLocation();
  const navigate = useNavigate();
  const handed = (location.state as { question?: string } | null)?.question;
  useEffect(() => {
    if (handed && site && status.data?.configured) {
      ask.mutate(handed);
      navigate(location.pathname, { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handed, site?.id, status.data?.configured]);

  if (!site) return null;
  const send = (q: string) => q.trim().length > 1 && !ask.isPending && ask.mutate(q.trim());
  const turns = conversationId ? conversation.data?.transcript ?? [] : [];

  return (
    <section>
      <PageHeader
        title="Ask AI"
        description={`Ask anything about ${site.domain}'s traffic, pages, sources, events or SEO. Answers use this site's data only.`}
        extra={status.data?.configured && (
          <Typography.Text type="secondary">{status.data.asks_today} of {status.data.ask_daily_limit} questions today</Typography.Text>
        )}
      />
      {!status.isLoading && !status.data?.configured ? (
        <AiSetupCard />
      ) : (
        <div className="chat-layout">
          <Card size="small" className="chat-history" title="Conversations" extra={<Button size="small" icon={<PlusOutlined />} onClick={() => setConversationId(undefined)}>New</Button>}>
            <List
              size="small"
              dataSource={conversations.data ?? []}
              locale={{ emptyText: 'No conversations yet' }}
              renderItem={(c) => (
                <List.Item onClick={() => setConversationId(c.id)} className={c.id === conversationId ? 'row-selected' : ''} style={{ cursor: 'pointer', paddingInline: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="ellipsis"><MessageOutlined /> {c.title}</div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{timeAgo(c.updated_at)}</Typography.Text>
                  </div>
                </List.Item>
              )}
            />
          </Card>
          <Card size="small" className="chat-main">
            <div className="chat-scroll" data-testid="chat">
              {!turns.length && !pending && (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={
                    <Space direction="vertical">
                      <span>Ask anything about {site.domain}'s traffic, pages, sources, events or SEO.</span>
                      <Space wrap style={{ justifyContent: 'center' }}>
                        {STARTERS.map((s) => (
                          <Button key={s} size="small" className="starter-btn" onClick={() => send(s)}>{s}</Button>
                        ))}
                      </Space>
                    </Space>
                  }
                />
              )}
              {turns.map((t, i) => <Turn key={i} turn={t} />)}
              {pending && (
                <>
                  <div className="chat-user">{pending}</div>
                  <div className="chat-ai"><Thinking label="Looking at your data…" /></div>
                </>
              )}
              <AiError error={ask.error} />
              <div ref={bottom} />
            </div>
            <Space.Compact style={{ width: '100%', marginTop: 12 }}>
              <Input.TextArea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onPressEnter={(e) => {
                  if (!e.shiftKey) {
                    e.preventDefault();
                    send(question);
                  }
                }}
                autoSize={{ minRows: 1, maxRows: 5 }}
                placeholder="e.g. Which landing pages get traffic but no enquiries?"
                maxLength={2000}
                aria-label="Question"
              />
              <Button type="primary" icon={<SendOutlined />} onClick={() => send(question)} loading={ask.isPending} aria-label="Send">Ask</Button>
            </Space.Compact>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Answers are generated by {modelLabel(status.data)} from your analytics through read-only tools. Check important numbers in the linked reports.
            </Typography.Text>
          </Card>
        </div>
      )}
    </section>
  );
}
