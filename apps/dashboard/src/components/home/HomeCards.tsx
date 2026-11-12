import {
  ArrowDownOutlined, ArrowRightOutlined, ArrowUpOutlined, BulbOutlined, CommentOutlined, FireOutlined, SearchOutlined,
  SendOutlined, ThunderboltOutlined,
} from '@ant-design/icons';
import { Button, Card, Input, Progress, Skeleton, Space, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type {
  DevicesResponse, EventsResponse, OverviewResponse, PagesResponse, SeoSeverity, SourcesResponse,
} from '@growthos/shared-types';
import { api, type RangeQuery } from '../../api';
import { fmtNumber, fmtPct, previousRange, timeAgo } from '../../dates';
import { useCurrentSite } from '../../hooks';
import { CHANNEL_LABELS } from '../../labels';
import { viz } from '../../theme';
import { useAiStatus } from '../ai/AiBits';
import { CHECK_LABEL, SeverityTag, scoreBand } from '../seo/SeoBits';

// ------------------------------------------------------------------ sparkline

/** Tiny single-series trend line (no axes; the card's number is the value, this is only the shape). */
export function Sparkline({ values, color = viz.series1, label }: { values: number[]; color?: string; label: string }) {
  if (values.length < 2 || values.every((v) => v === 0)) return null;
  const w = 120;
  const h = 30;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 2 - ((v - min) / span) * (h - 4)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label={`${label} trend over the selected period`}>
      <path d={`${line} L${w},${h} L0,${h} Z`} fill={color} opacity={0.08} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.75} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

function CardLink({ to, children = 'Open' }: { to: string; children?: React.ReactNode }) {
  return (
    <Link to={to} className="card-link">
      {children} <ArrowRightOutlined />
    </Link>
  );
}

// ------------------------------------------------------------------ live now

export function LiveNowCard() {
  const { site } = useCurrentSite();
  const { data, isLoading } = useQuery({
    queryKey: ['realtime', site?.id],
    queryFn: () => api.realtime(site!.id),
    enabled: !!site,
    refetchInterval: 15_000,
  });
  return (
    <Card size="small" className="home-card" title={<span><span className="pulse" aria-hidden /> Live now</span>} extra={<CardLink to="/realtime">Realtime</CardLink>}>
      {isLoading || !data ? (
        <Skeleton active paragraph={{ rows: 3 }} title={false} />
      ) : (
        <>
          <div className="live-row">
            <span className="big-number" data-testid="home-active">{data.active_visitors}</span>
            <Typography.Text type="secondary">
              visitor{data.active_visitors === 1 ? '' : 's'} in the last {data.window_minutes} min · {data.pageviews_last_window} page views
            </Typography.Text>
          </div>
          {data.top_active_pages.length > 0 && (
            <div className="mini-list">
              {data.top_active_pages.slice(0, 3).map((p) => (
                <div key={p.page_path}>
                  <span className="ellipsis-block">{p.page_path}</span>
                  <b>{p.visitors}</b>
                </div>
              ))}
            </div>
          )}
          {data.latest_events.length > 0 ? (
            <>
              <div className="sugg-label" style={{ marginTop: 6 }}>Latest events</div>
              <div className="mini-list live-events">
                {data.latest_events.slice(0, 6).map((e) => (
                  <div key={e.event_id}>
                    <span className="ellipsis-block">
                      <Typography.Text code style={{ fontSize: 12 }}>{e.event_name}</Typography.Text>{' '}
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{e.page_path ?? ''}</Typography.Text>
                    </span>
                    <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{timeAgo(e.received_at)}</Typography.Text>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              No events in the last 24 hours. Latest event received {timeAgo(data.last_event_received_at)}.
            </Typography.Text>
          )}
        </>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ deterministic insights

export interface Insight {
  icon: React.ReactNode;
  text: React.ReactNode;
  to: string;
  tone: 'up' | 'down' | 'neutral';
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/**
 * Plain-language observations computed directly from the reports (no AI, no cost). Each one is a
 * fact with its numbers and a link to the report it comes from.
 */
export function computeInsights(
  ov: OverviewResponse | undefined,
  pages: PagesResponse | undefined,
  sources: SourcesResponse | undefined,
  devices: DevicesResponse | undefined,
  events: EventsResponse | undefined,
): Insight[] {
  const out: Insight[] = [];
  if (ov && ov.timeseries.length >= 14) {
    const ts = ov.timeseries.map((p) => p.sessions);
    const last = sum(ts.slice(-7));
    const before = sum(ts.slice(-14, -7));
    if (before > 0) {
      const ch = (last - before) / before;
      if (Math.abs(ch) >= 0.05) {
        out.push({
          icon: ch > 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />,
          tone: ch > 0 ? 'up' : 'down',
          to: '/',
          text: <>Sessions are <b>{ch > 0 ? 'up' : 'down'} {Math.abs(ch * 100).toFixed(0)}%</b> in the last 7 days ({fmtNumber(last)}) compared with the 7 days before ({fmtNumber(before)}).</>,
        });
      }
    }
  }
  if (sources?.channels.length) {
    const total = sum(sources.channels.map((c) => c.sessions));
    const top = sources.channels[0]!;
    if (total > 0) {
      out.push({
        icon: <SearchOutlined />,
        tone: 'neutral',
        to: '/sources',
        text: <><b>{CHANNEL_LABELS[top.channel] ?? top.channel}</b> brings the most visits: {fmtPct(top.sessions / total)} of sessions ({fmtNumber(top.sessions)}).</>,
      });
    }
  }
  if (pages?.landing_pages.length && ov) {
    const total = sum(pages.landing_pages.map((p) => p.sessions));
    const avg = ov.metrics.bounce_rate;
    const worst = pages.landing_pages
      .filter((p) => p.sessions >= Math.max(20, total * 0.03))
      .sort((a, b) => b.bounce_rate - a.bounce_rate)[0];
    if (worst && worst.bounce_rate - avg >= 0.05) {
      out.push({
        icon: <FireOutlined />,
        tone: 'down',
        to: '/pages',
        text: <><b>{worst.page_path}</b> bounces at {fmtPct(worst.bounce_rate)} on {fmtNumber(worst.sessions)} entries, above the site average of {fmtPct(avg)}. A clearer next step there could keep more visitors.</>,
      });
    }
  }
  if (devices?.devices.length) {
    const mob = devices.devices.find((d) => d.device_category === 'mobile');
    const desk = devices.devices.find((d) => d.device_category === 'desktop');
    if (mob && desk && mob.sessions >= 20) {
      const gap = mob.bounce_rate - desk.bounce_rate;
      out.push({
        icon: <ThunderboltOutlined />,
        tone: gap >= 0.05 ? 'down' : 'neutral',
        to: '/devices',
        text:
          gap >= 0.05 ? (
            <>Mobile visitors bounce more: <b>{fmtPct(mob.bounce_rate)}</b> vs {fmtPct(desk.bounce_rate)} on desktop, on {fmtPct(mob.share)} of sessions.</>
          ) : (
            <>Mobile is <b>{fmtPct(mob.share)}</b> of sessions and engages about as well as desktop ({fmtPct(mob.bounce_rate)} vs {fmtPct(desk.bounce_rate)} bounce).</>
          ),
      });
    }
  }
  const custom = events?.events.filter((e) => e.event_name !== 'page_view' && e.event_name !== 'outbound_click') ?? [];
  if (custom.length) {
    const top = custom[0]!;
    out.push({
      icon: <BulbOutlined />,
      tone: 'neutral',
      to: '/events',
      text: <><b>{top.event_name}</b> is the most frequent custom event ({fmtNumber(top.count)} times).</>,
    });
  } else if (events && events.events.length) {
    out.push({
      icon: <BulbOutlined />,
      tone: 'neutral',
      to: '/sites',
      text: <>No custom events yet. Track signups or enquiries with <code>GrowthOS.track('signup')</code> to see what visitors actually do.</>,
    });
  }
  if (ov && ov.metrics.visitors > 0 && ov.metrics.estimated_visitors / ov.metrics.visitors >= 0.3) {
    out.push({
      icon: <CommentOutlined />,
      tone: 'neutral',
      to: '/sites',
      text: <>{fmtPct(ov.metrics.estimated_visitors / ov.metrics.visitors)} of visitors browse without analytics consent, so they are counted once per visit (estimated).</>,
    });
  }
  return out;
}

export function InsightsCard({ insights, loading }: { insights: Insight[]; loading: boolean }) {
  return (
    <Card size="small" className="home-card" title="Insights" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>from your data · no AI</Typography.Text>}>
      {loading ? (
        <Skeleton active paragraph={{ rows: 4 }} title={false} />
      ) : insights.length ? (
        <ul className="insights">
          {insights.map((i, n) => (
            <li key={n} className={`tone-${i.tone}`}>
              <span className="insight-icon" aria-hidden>{i.icon}</span>
              <span>
                {i.text} <Link to={i.to} className="insight-link" aria-label="Open report"><ArrowRightOutlined /></Link>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Typography.Text type="secondary">Insights appear once there is enough traffic in this period.</Typography.Text>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ SEO health

const SEV: SeoSeverity[] = ['critical', 'high', 'medium', 'low'];

export function SeoHealthCard() {
  const { site } = useCurrentSite();
  const audits = useQuery({ queryKey: ['seo-audits', site?.id], queryFn: () => api.seoAudits(site!.id), enabled: !!site });
  const audit = audits.data?.find((a) => a.status === 'completed');
  const running = audits.data?.find((a) => a.status === 'queued' || a.status === 'running');
  const findings = useQuery({ queryKey: ['seo-findings', audit?.id], queryFn: () => api.seoFindings(audit!.id), enabled: !!audit });
  const groups = new Map<string, { label: string; severity: SeoSeverity; n: number }>();
  for (const f of findings.data ?? []) {
    const g = groups.get(f.check_id);
    if (g) g.n++;
    else groups.set(f.check_id, { label: CHECK_LABEL[f.check_id] ?? f.title, severity: f.severity, n: 1 });
  }
  const top = [...groups.values()].sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity) || b.n - a.n).slice(0, 3);
  const band = audit?.score != null ? scoreBand(audit.score) : null;

  return (
    <Card size="small" className="home-card" title={<span><SearchOutlined /> SEO health</span>} extra={<CardLink to="/seo">SEO audit</CardLink>}>
      {audits.isLoading ? (
        <Skeleton active paragraph={{ rows: 4 }} title={false} />
      ) : !audit ? (
        <div>
          <Typography.Paragraph type="secondary">
            {running ? `An audit is running (${running.pages_crawled} pages so far).` : 'No audit yet. Crawl the site to find title, description, link and speed issues.'}
          </Typography.Paragraph>
          {!running && <Link to="/seo"><Button type="primary" size="small">Run an audit</Button></Link>}
        </div>
      ) : (
        <>
          <div className="score-row">
            <Progress
              type="circle"
              size={64}
              percent={audit.score ?? 0}
              strokeColor={band!.color}
              format={(p) => <span style={{ color: '#0b0b0b', fontWeight: 600 }}>{p}</span>}
            />
            <div>
              <div style={{ color: band!.color, fontWeight: 600 }}>{band!.label}</div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {audit.pages_crawled} pages · {timeAgo(audit.finished_at)}
                {audit.comparison && ` · ${audit.comparison.resolved} fixed, ${audit.comparison.new} new`}
              </Typography.Text>
              <div className="sev-inline">
                {SEV.filter((s) => (audit.summary?.by_severity[s] ?? 0) > 0).map((s) => (
                  <span key={s}><SeverityTag severity={s} /> {audit.summary!.by_severity[s]}</span>
                ))}
              </div>
            </div>
          </div>
          <div className="mini-list">
            {top.map((g) => (
              <div key={g.label}>
                <span className="ellipsis-block">{g.label}</span>
                <Typography.Text type="secondary">{g.n} {g.n === 1 ? 'page' : 'pages'}</Typography.Text>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ growth suggestions

export function GrowthCard() {
  const { site } = useCurrentSite();
  const status = useAiStatus(site?.id);
  const list = useQuery({ queryKey: ['suggestions', site?.id], queryFn: () => api.suggestions(site!.id), enabled: !!site && !!status.data?.configured });
  const open = (list.data?.suggestions ?? []).filter((s) => s.status === 'new' || s.status === 'accepted');
  const done = (list.data?.suggestions ?? []).filter((s) => s.status === 'done').length;
  return (
    <Card size="small" className="home-card" title={<span><BulbOutlined /> Growth suggestions</span>} extra={<CardLink to="/growth">All</CardLink>}>
      {status.isLoading || list.isLoading ? (
        <Skeleton active paragraph={{ rows: 4 }} title={false} />
      ) : !status.data?.configured ? (
        <Typography.Paragraph type="secondary">Add an AI provider key to get prioritised, evidence-checked ideas. <Link to="/growth">How</Link></Typography.Paragraph>
      ) : !open.length ? (
        <div>
          <Typography.Paragraph type="secondary">
            {done ? `All caught up: ${done} done.` : 'No suggestions yet. AI reviews your traffic and SEO audit and proposes what to do next.'}
          </Typography.Paragraph>
          <Link to="/growth"><Button type="primary" size="small">Generate suggestions</Button></Link>
        </div>
      ) : (
        <>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {open.length} open{done ? ` · ${done} done` : ''}
          </Typography.Text>
          <ul className="sugg-mini">
            {open.slice(0, 3).map((s) => (
              <li key={s.id}>
                <span className={`prio prio-${s.priority}`}>{s.priority}</span>
                <span className="ellipsis-2">{s.title}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ ask AI

const QUICK = ['Which pages should I improve first?', 'Where do my best visitors come from?', 'What changed in the last 7 days?'];

export function AskCard() {
  const { site } = useCurrentSite();
  const status = useAiStatus(site?.id);
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const go = (question: string) => question.trim().length > 1 && navigate('/ask', { state: { question: question.trim() } });
  return (
    <Card size="small" className="home-card" title={<span><CommentOutlined /> Ask AI</span>} extra={<CardLink to="/ask">Chat</CardLink>}>
      {!status.data?.configured && !status.isLoading ? (
        <Typography.Paragraph type="secondary">Add an AI provider key to ask questions about your data. <Link to="/ask">How</Link></Typography.Paragraph>
      ) : (
        <>
          <Space.Compact style={{ width: '100%' }}>
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onPressEnter={() => go(q)}
              placeholder="Ask about your traffic or SEO…"
              aria-label="Ask AI a question"
            />
            <Button type="primary" icon={<SendOutlined />} onClick={() => go(q)} aria-label="Ask" />
          </Space.Compact>
          <div className="quick-qs">
            {QUICK.map((x) => (
              <Tag key={x} className="quick-q" onClick={() => go(x)} bordered={false}>{x}</Tag>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ key events

export function KeyEventsCard({ q }: { q: RangeQuery | null }) {
  const prev = q ? previousRange(q.from, q.to) : null;
  const cur = useQuery({ queryKey: ['events', q], queryFn: () => api.events(q!), enabled: !!q });
  const before = useQuery({
    queryKey: ['events', q && prev ? { ...q, ...prev } : null],
    queryFn: () => api.events({ ...q!, ...prev! }),
    enabled: !!q && !!prev && q.compare === 'previous',
  });
  const prevCount = new Map((before.data?.events ?? []).map((e) => [e.event_name, e.count]));
  const rows = (cur.data?.events ?? []).filter((e) => e.event_name !== 'page_view').slice(0, 5);
  return (
    <Card size="small" className="home-card" title={<span><FireOutlined /> Key events</span>} extra={<CardLink to="/events">Events</CardLink>}>
      {cur.isLoading ? (
        <Skeleton active paragraph={{ rows: 4 }} title={false} />
      ) : !rows.length ? (
        <Typography.Paragraph type="secondary">
          No custom events in this period. Add <code>GrowthOS.track('enquiry_submitted')</code> where visitors convert.
        </Typography.Paragraph>
      ) : (
        <div className="mini-list">
          {rows.map((e) => {
            const p = prevCount.get(e.event_name);
            const ch = p ? (e.count - p) / p : null;
            return (
              <div key={e.event_name}>
                <span className="ellipsis-block">{e.event_name}</span>
                <span className="ev-num">
                  <b>{fmtNumber(e.count)}</b>
                  {ch !== null && Math.abs(ch) >= 0.01 && (
                    <span style={{ color: ch > 0 ? viz.good : viz.critical, fontSize: 12, marginLeft: 6 }}>
                      {ch > 0 ? <ArrowUpOutlined /> : <ArrowDownOutlined />}{Math.abs(ch * 100).toFixed(0)}%
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
