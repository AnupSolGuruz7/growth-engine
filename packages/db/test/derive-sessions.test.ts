import { describe, expect, it } from 'vitest';
import { deriveSessions } from '../src/processing';

const at = (iso: string) => new Date(iso);
const ev = (id: string, time: string, over: Record<string, unknown> = {}) => ({
  event_id: id, event_name: 'page_view', event_time: at(time), page_path: '/', referrer_host: null,
  utm_source: null, utm_medium: null, utm_campaign: null, device_category: 'desktop', ...over,
});

describe('deriveSessions', () => {
  it('splits on more than 30 minutes of inactivity', () => {
    const s = deriveSessions('site', 'v:1', [
      ev('a', '2026-11-10T10:00:00Z'),
      ev('b', '2026-11-10T10:30:00Z', { page_path: '/x' }), // exactly 30 min -> same session
      ev('c', '2026-11-10T11:00:01Z', { page_path: '/y' }), // 30m01s -> new session
    ]);
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ pageviews: 2, landing_path: '/', exit_path: '/x', duration_s: 1800, is_bounce: false });
    expect(s[1]).toMatchObject({ pageviews: 1, is_bounce: true, landing_path: '/y' });
  });

  it('counts a single page view with an interaction as not a bounce', () => {
    const [s] = deriveSessions('site', 'v:1', [
      ev('a', '2026-11-10T10:00:00Z'),
      ev('b', '2026-11-10T10:00:10Z', { event_name: 'outbound_click' }),
    ]);
    expect(s).toMatchObject({ pageviews: 1, interactions: 1, is_bounce: false });
  });

  it('attributes to the last non-direct touch, UTM over referrer', () => {
    const [s] = deriveSessions('site', 'v:1', [
      ev('a', '2026-11-10T10:00:00Z', { referrer_host: 'google.com' }),
      ev('b', '2026-11-10T10:01:00Z'),
      ev('c', '2026-11-10T10:02:00Z', { utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'nov', referrer_host: 'mail.google.com' }),
      ev('d', '2026-11-10T10:03:00Z'),
    ]);
    expect(s).toMatchObject({ channel: 'email', source: 'newsletter', medium: 'email', campaign: 'nov' });
  });

  it('is deterministic', () => {
    const input = [ev('a', '2026-11-10T10:00:00Z')];
    expect(deriveSessions('site', 'v:1', input)[0]!.session_id).toBe(deriveSessions('site', 'v:1', input)[0]!.session_id);
    expect(deriveSessions('site', 'v:1', input)[0]!.session_id).not.toBe(deriveSessions('site', 'v:2', input)[0]!.session_id);
  });
});
