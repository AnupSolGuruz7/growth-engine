import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, sanitizeUrl } from '../src/client';

type Body = { site_id: string; schema_version: number; events: Record<string, unknown>[] };

let client: ReturnType<typeof createClient>;
let fetchMock: ReturnType<typeof vi.fn>;
const sent = (): Body[] => fetchMock.mock.calls.map((c) => JSON.parse(c[1].body as string));
const events = () => sent().flatMap((b) => b.events);

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  // happy-dom really follows clicked links, so reset the page URL before every test
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL('https://shop.example.com/');
  fetchMock = vi.fn(async () => new Response('{}', { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
  client = createClient();
});

afterEach(() => {
  client._destroy();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const init = (over: Record<string, unknown> = {}) =>
  client.init({ siteId: 'gos_test', endpoint: 'https://api.example.com', ...over });

describe('init + page views', () => {
  it('sends an automatic page_view after the batch interval', async () => {
    init();
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/events/batch');
    expect(opts).toMatchObject({ method: 'POST', keepalive: true, credentials: 'omit' });
    const body = sent()[0]!;
    expect(body).toMatchObject({ site_id: 'gos_test', schema_version: 1 });
    expect(body.events[0]).toMatchObject({ event_name: 'page_view', page_path: '/', consent_state: 'pending', device_category: 'desktop' });
    expect(body.events[0]!.event_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('respects autoPageviews=false and ignores a missing siteId', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    client.init({ siteId: '' });
    expect(warn).toHaveBeenCalled();
    init({ autoPageviews: false });
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a non-https endpoint except localhost', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    init({ endpoint: 'http://api.example.com' });
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('batching', () => {
  it('flushes immediately at 10 events', async () => {
    init({ autoPageviews: false });
    for (let i = 0; i < 10; i++) client.track('click_cta', { i });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events()).toHaveLength(10);
  });

  it('flushes every 5 seconds otherwise, and flush() sends right away', async () => {
    init({ autoPageviews: false });
    client.track('a');
    await vi.advanceTimersByTimeAsync(4999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    client.track('b');
    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses sendBeacon with a text/plain blob on pagehide', async () => {
    const beacon = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
    init();
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, blob] = beacon.mock.calls[0] as unknown as [string, Blob];
    expect(url).toBe('https://api.example.com/v1/events/batch');
    expect(blob.type).toBe('text/plain');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('validates custom events and their properties', async () => {
    init({ autoPageviews: false });
    client.track('bad name!');
    client.track('enquiry_submitted', { form: 'contact', n: 2, ok: true, nil: null, obj: { a: 1 } as never, fn: (() => 1) as never, long: 'x'.repeat(600) });
    await client.flush();
    expect(events()).toHaveLength(1);
    expect(events()[0]!.properties).toEqual({ form: 'contact', n: 2, ok: true, nil: null, long: 'x'.repeat(512) });
  });
});

describe('consent', () => {
  it('writes no persistent identifiers unless consent is granted', async () => {
    init();
    client.track('a');
    await client.flush();
    expect(localStorage.getItem('gos_vid')).toBeNull();
    expect(localStorage.getItem('gos_sid')).toBeNull();
    const e = events()[0]!;
    expect(e.visitor_id).toBeUndefined();
    expect(e.session_id).toBeUndefined();
    expect(e.ephemeral_id).toBeTruthy();
    expect(Object.keys(localStorage)).toEqual([]);
  });

  it('adds visitor and session ids after setConsent(granted) and removes them on denial', async () => {
    init({ autoPageviews: false });
    client.setConsent('granted');
    client.track('a');
    client.track('b');
    await client.flush();
    const [a, b] = events();
    expect(a!.consent_state).toBe('granted');
    expect(a!.visitor_id).toBe(localStorage.getItem('gos_vid'));
    expect(a!.visitor_id).toBe(b!.visitor_id);
    expect(a!.session_id).toBe(b!.session_id);
    client.setConsent('denied');
    expect(localStorage.getItem('gos_vid')).toBeNull();
    expect(localStorage.getItem('gos_sid')).toBeNull();
    client.track('c');
    await client.flush();
    expect(events()[2]).toMatchObject({ consent_state: 'denied' });
    expect(events()[2]!.visitor_id).toBeUndefined();
  });

  it('rotates the session after 30 minutes of inactivity', async () => {
    init({ autoPageviews: false, consent: 'granted' });
    client.track('a');
    vi.setSystemTime(Date.now() + 31 * 60_000);
    client.track('b');
    await client.flush();
    const [a, b] = events();
    expect(a!.visitor_id).toBe(b!.visitor_id);
    expect(a!.session_id).not.toBe(b!.session_id);
  });

  it('optOut stops all tracking until optIn', async () => {
    init({ autoPageviews: false, consent: 'granted' });
    client.track('a');
    client.optOut();
    client.track('b');
    await vi.advanceTimersByTimeAsync(6000);
    await client.flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem('gos_vid')).toBeNull();
    client.optIn();
    client.track('c');
    await client.flush();
    expect(events().map((e) => e.event_name)).toEqual(['c']);
  });
});

describe('SPA navigation + outbound clicks', () => {
  it('tracks pushState / popstate route changes but not same-path replaceState', async () => {
    init();
    history.pushState({}, '', '/pricing?plan=pro#top');
    history.replaceState({}, '', '/pricing?tab=2');
    history.pushState({}, '', '/docs');
    history.back = () => {};
    history.replaceState({}, '', '/pricing'); // simulate the browser moving back
    window.dispatchEvent(new PopStateEvent('popstate'));
    await client.flush();
    expect(events().filter((e) => e.event_name === 'page_view').map((e) => e.page_path)).toEqual(['/', '/pricing', '/docs', '/pricing']);
  });

  it('records outbound clicks with host and path only', async () => {
    init({ autoPageviews: false });
    document.body.innerHTML = `
      <a id="out" href="https://apps.apple.com/us/app/x/id123?ref=secret#frag"><span id="inner">Get app</span></a>
      <a id="in" href="/contact">Contact</a>`;
    document.querySelectorAll('a').forEach((a) => a.addEventListener('click', (e) => e.preventDefault()));
    document.getElementById('inner')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.getElementById('in')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await client.flush();
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ event_name: 'outbound_click', properties: { host: 'apps.apple.com', path: '/us/app/x/id123' } });
  });
});

describe('URL sanitising', () => {
  it('keeps origin, path and utm_* only', async () => {
    history.replaceState(null, '', '/landing?email=a%40b.com&token=abc&utm_source=newsletter&utm_campaign=nov#section');
    init();
    await client.flush();
    const e = events()[0]!;
    expect(e.page_url).toBe('https://shop.example.com/landing?utm_source=newsletter&utm_campaign=nov');
    expect(e).toMatchObject({ utm_source: 'newsletter', utm_campaign: 'nov' });
    expect(JSON.stringify(e)).not.toContain('a@b.com');
    expect(JSON.stringify(e)).not.toContain('abc');
    expect(sanitizeUrl('javascript:alert(1)')).toBeUndefined();
    expect(sanitizeUrl('https://u:p@x.com/a?b=1', false)).toBe('https://x.com/a');
  });

  it('never reads form values', async () => {
    document.body.innerHTML = '<form><input id="pw" type="password" value="hunter2"><input value="me@x.com"></form>';
    init();
    client.track('form_view');
    await client.flush();
    const all = JSON.stringify(sent());
    expect(all).not.toContain('hunter2');
    expect(all).not.toContain('me@x.com');
  });
});

describe('failure isolation', () => {
  it('never throws when the network fails and keeps events for retry', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    init();
    client.track('a');
    await expect(client.flush()).resolves.toBeUndefined();
    const stored = JSON.parse(localStorage.getItem('gos_q')!);
    expect(stored.map((e: { event_name: string }) => e.event_name)).toEqual(['page_view', 'a']);
    // without consent, persisted retries carry no identifier at all
    expect(stored.every((e: Record<string, unknown>) => !e.ephemeral_id && !e.visitor_id)).toBe(true);

    // next attempt waits for the backoff, then delivers the stored events
    fetchMock.mockResolvedValue(new Response('{}', { status: 202 }));
    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1); // still backing off
    vi.setSystemTime(Date.now() + 60_000);
    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).events).toHaveLength(2);
    expect(localStorage.getItem('gos_q')).toBeNull();
  });

  it('caps the retry queue at 100 events', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    init({ autoPageviews: false });
    for (let r = 0; r < 12; r++) {
      vi.setSystemTime(Date.now() + 600_000);
      for (let i = 0; i < 10; i++) client.track('e', { r, i });
      await client.flush();
    }
    expect(JSON.parse(localStorage.getItem('gos_q')!)).toHaveLength(100);
  });

  it('survives storage and crypto being unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      throw new Error('no');
    });
    expect(() => init({ consent: 'granted' })).not.toThrow();
    expect(() => client.track('a', { x: 1 })).not.toThrow();
    await client.flush();
    expect(events().length).toBe(2);
    expect(events()[0]!.event_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('public methods are safe before init and with bad input', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => client.track('a')).not.toThrow();
    expect(() => client.page()).not.toThrow();
    expect(() => client.setConsent('maybe' as never)).not.toThrow();
    expect(() => client.init(undefined as never)).not.toThrow();
    await expect(client.flush()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('a throwing host click handler path does not break tracking', async () => {
    init({ autoPageviews: false });
    const weird = document.createElement('div');
    Object.defineProperty(weird, 'closest', { value: () => { throw new Error('boom'); } });
    document.body.appendChild(weird);
    expect(() => weird.dispatchEvent(new MouseEvent('click', { bubbles: true }))).not.toThrow();
    client.track('still_works');
    await client.flush();
    expect(events().map((e) => e.event_name)).toEqual(['still_works']);
  });
});

describe('bundle size', () => {
  // plain path: inside happy-dom the global URL is not Node's
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'growthos.iife.js');
  it.skipIf(!existsSync(file))('script-tag bundle is under 5 KB gzipped', () => {
    expect(gzipSync(readFileSync(file), { level: 9 }).length).toBeLessThan(5 * 1024);
  });
});
