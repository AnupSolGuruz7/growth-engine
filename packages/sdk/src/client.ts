// GrowthOS tracking SDK — zero dependencies, never throws into the host page.
// Only types come from shared-types (erased at build time).
import type { ConsentState, IncomingEvent } from '@growthos/shared-types';

declare const __SDK_VERSION__: string;
export const VERSION: string = typeof __SDK_VERSION__ === 'string' ? __SDK_VERSION__ : '0.0.0-dev';

export type { ConsentState };
export type EventProperties = Record<string, string | number | boolean | null>;

export interface GrowthOSConfig {
  siteId: string;
  endpoint?: string;
  autoPageviews?: boolean;
  spa?: boolean;
  consent?: ConsentState;
  debug?: boolean;
}

export interface GrowthOSClient {
  init(config: GrowthOSConfig): void;
  track(eventName: string, properties?: EventProperties): void;
  page(): void;
  setConsent(state: ConsentState): void;
  optOut(): void;
  optIn(): void;
  flush(): Promise<void>;
  readonly version: string;
}

type Ev = IncomingEvent;

const K_VID = 'gos_vid';
const K_SID = 'gos_sid';
const K_OPT = 'gos_optout';
const K_Q = 'gos_q';
const K_QT = 'gos_qt';
const UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/;
const BATCH = 10;
const INTERVAL = 5000;
const MAX_QUEUE = 100;
const SESSION_MS = 30 * 60_000;

const ls = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string): void {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage full or blocked */
    }
  },
  del(k: string): void {
    try {
      localStorage.removeItem(k);
    } catch {
      /* blocked */
    }
  },
};

export function uuid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    const b = new Uint8Array(16);
    try {
      crypto.getRandomValues(b);
    } catch {
      for (let i = 0; i < 16; i++) b[i] = (Math.random() * 256) | 0;
    }
    b[6] = (b[6]! & 15) | 64;
    b[8] = (b[8]! & 63) | 128;
    const h = Array.from(b, (x) => (x + 256).toString(16).slice(1)).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
}

/** origin + path + utm_* only. Drops every other query parameter, the hash and credentials. */
export function sanitizeUrl(href: string, keepUtm = true): string | undefined {
  try {
    const u = new URL(href);
    if (!/^https?:$/.test(u.protocol)) return;
    let out = u.origin + u.pathname;
    if (keepUtm) {
      const q = UTM.filter((k) => u.searchParams.get(k)).map(
        (k) => `${k}=${encodeURIComponent(u.searchParams.get(k)!.slice(0, 256))}`,
      );
      if (q.length) out += '?' + q.join('&');
    }
    return out.slice(0, 2048);
  } catch {
    return;
  }
}

export function deviceCategory(): 'desktop' | 'mobile' | 'tablet' {
  const ua = navigator.userAgent;
  if (/iPad|Tablet|PlayBook|Silk|Kindle/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return 'tablet'; // iPadOS desktop UA
  if (/Mobi|iPhone|iPod|Android|Windows Phone|Opera Mini/i.test(ua)) return 'mobile';
  return 'desktop';
}

function cleanProps(p: unknown): EventProperties {
  const out: EventProperties = {};
  if (!p || typeof p !== 'object') return out;
  let n = 0;
  for (const k of Object.keys(p)) {
    const v = (p as Record<string, unknown>)[k];
    if (n >= 25 || !k || k.length > 64) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 512);
    else if ((typeof v === 'number' && isFinite(v)) || typeof v === 'boolean' || v === null) out[k] = v;
    else continue;
    n++;
  }
  return out;
}

export function createClient(): GrowthOSClient & { _destroy(): void } {
  let cfg: Required<GrowthOSConfig> | null = null;
  let consent: ConsentState = 'pending';
  let queue: Ev[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastPath: string | undefined;
  let firstView = true;
  // In-memory only: groups one cookieless page lifetime / SPA visit; never written to storage.
  const ephemeral = uuid();
  const cleanups: (() => void)[] = [];

  const log = (...a: unknown[]) => {
    if (cfg?.debug) console.info('[GrowthOS]', ...a);
  };
  const optedOut = () => ls.get(K_OPT) === '1';
  const granted = () => consent === 'granted';

  const visitorId = () => {
    let v = ls.get(K_VID);
    if (!v) ls.set(K_VID, (v = uuid()));
    return v;
  };
  const sessionId = () => {
    const now = Date.now();
    const [id, t] = (ls.get(K_SID) ?? '').split('.');
    const sid = id && now - Number(t) < SESSION_MS ? id : uuid().replace(/-/g, '');
    ls.set(K_SID, `${sid}.${now}`);
    return sid;
  };
  const forgetIds = () => {
    ls.del(K_VID);
    ls.del(K_SID);
  };

  function build(name: string, props?: unknown): Ev {
    const ev: Ev = {
      event_id: uuid(),
      event_name: name,
      event_time: new Date().toISOString(),
      page_url: sanitizeUrl(location.href),
      page_path: location.pathname,
      device_category: deviceCategory(),
      consent_state: consent,
      ephemeral_id: ephemeral,
      properties: cleanProps(props),
    };
    if (granted()) {
      ev.visitor_id = visitorId();
      ev.session_id = sessionId();
    }
    if (name === 'page_view') {
      const q = new URLSearchParams(location.search);
      for (const k of UTM) {
        const v = q.get(k);
        if (v) ev[k] = v.slice(0, 256);
      }
      if (firstView && document.referrer) {
        try {
          if (new URL(document.referrer).host !== location.host) ev.referrer = sanitizeUrl(document.referrer, false);
        } catch {
          /* ignore */
        }
      }
      firstView = false;
    }
    return ev;
  }

  // Checked BEFORE building an event: building may create ids, which must not happen once opted out.
  const active = () => !!cfg && !optedOut();

  function enqueue(ev: Ev) {
    queue.push(ev);
    log('queued', ev.event_name, ev);
    if (queue.length >= BATCH) void flushNow(false);
    else if (!timer) timer = setTimeout(() => void flushNow(false), INTERVAL);
  }

  const url = () => cfg!.endpoint + '/v1/events/batch';
  const body = (events: Ev[]) =>
    JSON.stringify({
      site_id: cfg!.siteId,
      schema_version: 1,
      sdk_version: VERSION,
      sent_at: new Date().toISOString(),
      automation: navigator.webdriver || undefined,
      events,
    });

  /** Failed batches are kept (capped, newest wins) with exponential backoff. */
  function persistRetry(events: Ev[]) {
    let stored: Ev[] = [];
    try {
      stored = JSON.parse(ls.get(K_Q) ?? '[]');
    } catch {
      /* corrupt */
    }
    // Without consent nothing identifying is persisted: drop ids before writing to storage.
    const safe = events.map((e) => (e.consent_state === 'granted' ? e : { ...e, ephemeral_id: undefined }));
    const all = stored.concat(safe).slice(-MAX_QUEUE);
    ls.set(K_Q, JSON.stringify(all));
    const [, n = '0'] = (ls.get(K_QT) ?? '').split('.');
    const attempt = Math.min(Number(n) + 1, 6);
    ls.set(K_QT, `${Date.now() + 5000 * 2 ** attempt}.${attempt}`);
    log('send failed, kept for retry', events.length);
  }

  function takeRetry(): Ev[] {
    const [at] = (ls.get(K_QT) ?? '0').split('.');
    if (Date.now() < Number(at)) return [];
    let stored: Ev[] = [];
    try {
      stored = JSON.parse(ls.get(K_Q) ?? '[]');
    } catch {
      /* corrupt */
    }
    ls.del(K_Q);
    return Array.isArray(stored) ? stored : [];
  }

  async function send(events: Ev[], beacon: boolean): Promise<void> {
    for (let i = 0; i < events.length; i += 50) {
      const chunk = events.slice(i, i + 50);
      const b = body(chunk);
      if (beacon && navigator.sendBeacon) {
        let ok = false;
        try {
          ok = navigator.sendBeacon(url(), new Blob([b], { type: 'text/plain' }));
        } catch {
          /* fall through */
        }
        if (ok) continue;
      }
      try {
        const res = await fetch(url(), {
          method: 'POST',
          body: b,
          keepalive: true,
          credentials: 'omit',
          headers: { 'Content-Type': 'text/plain' },
        });
        if (res.status === 429 || res.status >= 500) persistRetry(chunk);
        else if (res.ok) ls.del(K_QT);
        else log('batch rejected', res.status);
      } catch {
        persistRetry(chunk);
      }
    }
  }

  async function flushNow(beacon: boolean): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    if (!cfg || optedOut()) return;
    const events = takeRetry().concat(queue);
    queue = [];
    if (events.length) await send(events, beacon);
  }

  function pageview() {
    if (!active()) return;
    lastPath = location.pathname;
    enqueue(build('page_view'));
  }

  function onNavigate() {
    if (location.pathname !== lastPath) pageview();
  }

  function onClick(e: Event) {
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a) return;
    const u = new URL(a.href, location.href);
    if (active() && /^https?:$/.test(u.protocol) && u.host !== location.host) {
      enqueue(build('outbound_click', { host: u.hostname, path: u.pathname }));
    }
  }

  function listen(t: EventTarget, type: string, fn: (e: Event) => void, capture = false) {
    const h = (e: Event) => safe(() => fn(e))();
    t.addEventListener(type, h, capture);
    cleanups.push(() => t.removeEventListener(type, h, capture));
  }

  function patchHistory() {
    for (const m of ['pushState', 'replaceState'] as const) {
      const orig = history[m];
      history[m] = function (this: History, ...args: Parameters<History['pushState']>) {
        const r = orig.apply(this, args);
        safe(onNavigate)();
        return r;
      };
      cleanups.push(() => {
        history[m] = orig;
      });
    }
    listen(window, 'popstate', onNavigate);
  }

  function safe<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R | undefined {
    return (...a: A) => {
      try {
        return fn(...a);
      } catch (e) {
        log('internal error', e);
        return undefined;
      }
    };
  }

  const client = {
    version: VERSION,

    init: safe((c: GrowthOSConfig) => {
      if (cfg) return log('already initialised');
      if (!c || typeof c.siteId !== 'string' || !c.siteId) return console.warn('[GrowthOS] init: siteId is required');
      const endpoint = (c.endpoint || location.origin).replace(/\/+$/, '');
      const host = new URL(endpoint).hostname;
      if (!endpoint.startsWith('https:') && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(host)) {
        return console.warn('[GrowthOS] endpoint must use https');
      }
      cfg = {
        siteId: c.siteId,
        endpoint,
        autoPageviews: c.autoPageviews !== false,
        spa: c.spa !== false,
        consent: c.consent ?? 'pending',
        debug: !!c.debug,
      };
      consent = cfg.consent;
      // 'pending' must not wipe ids: a consent manager usually restores 'granted' right after init.
      // Pending simply neither reads nor writes them; only an explicit denial deletes them.
      if (consent === 'denied') forgetIds();
      log('init', VERSION, cfg);
      listen(document, 'click', onClick, true);
      listen(document, 'auxclick', onClick, true);
      listen(window, 'pagehide', () => void flushNow(true));
      listen(document, 'visibilitychange', () => {
        if (document.visibilityState === 'hidden') void flushNow(true);
      });
      if (cfg.spa) patchHistory();
      if (cfg.autoPageviews) pageview();
      // deliver anything left over from a previous page
      if (ls.get(K_Q)) timer ??= setTimeout(() => void flushNow(false), INTERVAL);
    }),

    track: safe((name: string, props?: EventProperties) => {
      if (!cfg) return console.warn('[GrowthOS] call init() before track()');
      if (typeof name !== 'string' || !NAME_RE.test(name)) return log('invalid event name', name);
      if (active()) enqueue(build(name, props));
    }),

    page: safe(() => pageview()),

    setConsent: safe((state: ConsentState) => {
      if (state !== 'granted' && state !== 'denied' && state !== 'pending') return log('invalid consent', state);
      consent = state;
      if (state === 'denied') forgetIds();
      log('consent', state);
    }),

    optOut: safe(() => {
      ls.set(K_OPT, '1');
      queue = [];
      clearTimeout(timer);
      timer = undefined;
      forgetIds();
      ls.del(K_Q);
      ls.del(K_QT);
    }),

    optIn: safe(() => ls.del(K_OPT)),

    flush: async () => {
      try {
        await flushNow(false);
      } catch (e) {
        log('flush failed', e);
      }
    },

    _destroy: () => {
      clearTimeout(timer);
      cleanups.splice(0).forEach((f) => f());
      cfg = null;
    },
  };
  return client as GrowthOSClient & { _destroy(): void };
}
