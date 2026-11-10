import type {
  CreateSiteInput,
  DevicesResponse,
  EventsResponse,
  ExportReport,
  OverviewResponse,
  PagesResponse,
  RealtimeResponse,
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
