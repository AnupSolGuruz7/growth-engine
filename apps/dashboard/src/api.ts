import type {
  AgentResponse,
  AiStatusDto,
  ConversationDto,
  DraftDto,
  GscSummaryDto,
  KnowledgeHit,
  KnowledgeResponse,
  KnowledgeSourceDto,
  SuggestionDto,
  SuggestionRunDto,
  SuggestionStatus,
  SuggestionsResponse,
  CreateAuditInput,
  CreateSiteInput,
  DevicesResponse,
  EventsResponse,
  ExportReport,
  OverviewResponse,
  PagesResponse,
  RealtimeResponse,
  SeoAuditDto,
  SeoComparisonDto,
  SeoFindingDto,
  SeoPageDetail,
  SeoPageRow,
  SiteDetailDto,
  SiteDto,
  SourcesResponse,
  UpdateSiteInput,
} from '@growthos/shared-types';

const BASE = (import.meta.env.VITE_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
// Testing-phase only: the dev key is baked into the bundle from env (spec §3). Never deploy publicly.
const KEY = import.meta.env.VITE_DEV_KEY ?? '';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      ...init,
      headers: { 'X-Dev-Key': KEY, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    });
  } catch {
    throw new ApiError(0, `Cannot reach the API at ${BASE}. Is it running?`);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg = (body as { message?: string } | null)?.message ?? res.statusText;
    throw new ApiError(res.status, res.status === 401 ? 'Invalid VITE_DEV_KEY — it must match DEV_KEY in .env' : msg, body);
  }
  return res;
}

const json = async <T>(path: string, init?: RequestInit) => (await request(path, init)).json() as Promise<T>;

export interface RangeQuery {
  site_id: string;
  from: string;
  to: string;
  compare?: 'previous' | 'none';
}

const qs = (q: Record<string, string | number | undefined>) =>
  '?' +
  new URLSearchParams(
    Object.entries(q).filter((e): e is [string, string | number] => e[1] !== undefined).map(([k, v]) => [k, String(v)]),
  ).toString();

export const api = {
  baseUrl: BASE,
  sites: () => json<SiteDto[]>('/v1/sites'),
  site: (id: string) => json<SiteDetailDto>(`/v1/sites/${id}`),
  createSite: (input: CreateSiteInput) => json<SiteDetailDto>('/v1/sites', { method: 'POST', body: JSON.stringify(input) }),
  updateSite: (id: string, input: UpdateSiteInput) =>
    json<SiteDetailDto>(`/v1/sites/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  rotatePublicId: (id: string) => json<SiteDetailDto>(`/v1/sites/${id}/rotate-public-id`, { method: 'POST' }),

  overview: (q: RangeQuery) => json<OverviewResponse>('/v1/analytics/overview' + qs({ ...q })),
  pages: (q: RangeQuery) => json<PagesResponse>('/v1/analytics/pages' + qs({ ...q, compare: undefined })),
  sources: (q: RangeQuery) => json<SourcesResponse>('/v1/analytics/sources' + qs({ ...q, compare: undefined })),
  events: (q: RangeQuery, eventName?: string) =>
    json<EventsResponse>('/v1/analytics/events' + qs({ ...q, compare: undefined, event_name: eventName })),
  devices: (q: RangeQuery) => json<DevicesResponse>('/v1/analytics/devices' + qs({ ...q, compare: undefined })),
  realtime: (siteId: string) => json<RealtimeResponse>('/v1/analytics/realtime' + qs({ site_id: siteId })),

  seoAudits: (siteId: string) => json<SeoAuditDto[]>('/v1/seo/audits' + qs({ site_id: siteId })),
  seoAudit: (id: string) => json<SeoAuditDto>(`/v1/seo/audits/${id}`),
  startSeoAudit: (input: CreateAuditInput) => json<SeoAuditDto>('/v1/seo/audits', { method: 'POST', body: JSON.stringify(input) }),
  seoFindings: (id: string) => json<SeoFindingDto[]>(`/v1/seo/audits/${id}/findings`),
  seoPages: (id: string) => json<SeoPageRow[]>(`/v1/seo/audits/${id}/pages`),
  seoPage: (id: string, url: string) => json<SeoPageDetail>(`/v1/seo/audits/${id}/page` + qs({ url })),
  seoCompare: (id: string, prevId: string) => json<SeoComparisonDto>(`/v1/seo/audits/${id}/compare/${prevId}`),

  aiStatus: (siteId: string) => json<AiStatusDto>('/v1/ai/status' + qs({ site_id: siteId })),
  suggestions: (siteId: string) => json<SuggestionsResponse>('/v1/suggestions' + qs({ site_id: siteId })),
  generateSuggestions: (siteId: string) => json<SuggestionRunDto>('/v1/suggestions/generate', { method: 'POST', body: JSON.stringify({ site_id: siteId }) }),
  updateSuggestion: (id: string, status: SuggestionStatus) => json<SuggestionDto>(`/v1/suggestions/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
  ask: (siteId: string, question: string, conversationId?: string) =>
    json<ConversationDto>('/v1/ai/ask', { method: 'POST', body: JSON.stringify({ site_id: siteId, question, conversation_id: conversationId }) }),
  conversations: (siteId: string) => json<Omit<ConversationDto, 'transcript'>[]>('/v1/ai/conversations' + qs({ site_id: siteId })),
  conversation: (id: string) => json<ConversationDto>(`/v1/ai/conversations/${id}`),
  agent: (siteId: string) => json<AgentResponse>('/v1/agent' + qs({ site_id: siteId })),
  knowledge: (siteId: string) => json<KnowledgeResponse>(`/v1/sites/${siteId}/knowledge`),
  connectKnowledge: (siteId: string, input: { name: string; root_path: string }) =>
    json<KnowledgeSourceDto>(`/v1/sites/${siteId}/knowledge`, { method: 'PUT', body: JSON.stringify(input) }),
  syncKnowledge: (siteId: string) => json<KnowledgeSourceDto>(`/v1/sites/${siteId}/knowledge/sync`, { method: 'POST' }),
  disconnectKnowledge: (siteId: string) => request(`/v1/sites/${siteId}/knowledge`, { method: 'DELETE' }),
  searchKnowledge: (siteId: string, q: string) => json<KnowledgeHit[]>(`/v1/sites/${siteId}/knowledge/search` + qs({ q, limit: '8' })),
  gscSummary: (siteId: string) => json<GscSummaryDto>(`/v1/sites/${siteId}/knowledge/gsc`),

  draftFix: (findingId: string, regenerate = false) => json<DraftDto>(`/v1/seo/findings/${findingId}/draft`, { method: 'POST', body: JSON.stringify({ regenerate }) }),

  /** Fetches the CSV with the dev key header and hands it to the browser as a file. */
  async downloadCsv(report: ExportReport, q: RangeQuery): Promise<void> {
    const res = await request('/v1/analytics/export.csv' + qs({ ...q, compare: undefined, report }));
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `growthos-${report}-${q.from}_${q.to}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};
