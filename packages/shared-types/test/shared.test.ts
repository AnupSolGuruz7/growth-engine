import { describe, expect, it } from 'vitest';
import {
  analyticsQuerySchema, batchEnvelopeSchema, classifyChannel, detectBot, deviceFromUserAgent,
  extractUtm, hostOf, incomingEventSchema, normalizePath, previousPeriod, rangeDays, sanitizeReferrer,
  sanitizeUrl, createSiteSchema,
} from '../src';

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

describe('url helpers', () => {
  it('keeps only utm_* params and drops hash/credentials', () => {
    expect(sanitizeUrl('https://user:pw@Ex.com/a/b?email=x@y.com&utm_source=nl&token=1#frag'))
      .toBe('https://ex.com/a/b?utm_source=nl');
    expect(sanitizeUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeUrl('not a url')).toBeNull();
  });
  it('sanitizes referrers to origin + path', () => {
    expect(sanitizeReferrer('https://www.google.com/search?q=secret')).toBe('https://www.google.com/search');
  });
  it('normalizes paths', () => {
    expect(normalizePath('/blog//post/?a=1#x')).toBe('/blog/post');
    expect(normalizePath('')).toBe('/');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('pricing')).toBe('/pricing');
    expect(normalizePath('/caf%C3%A9')).toBe('/café');
  });
  it('extracts utm and hosts', () => {
    expect(extractUtm('https://a.com/?utm_source=g&utm_medium=cpc&x=1')).toEqual({ utm_source: 'g', utm_medium: 'cpc' });
    expect(hostOf('https://WWW.Example.com/x')).toBe('example.com');
  });
});

describe('classifyChannel', () => {
  const cases: [Parameters<typeof classifyChannel>[0], string][] = [
    [{}, 'direct'],
    [{ referrer_host: 'www.google.com' }, 'organic_search'],
    [{ referrer_host: 'google.co.uk' }, 'organic_search'],
    [{ referrer_host: 'duckduckgo.com' }, 'organic_search'],
    [{ referrer_host: 'gemini.google.com' }, 'ai_assistant'],
    [{ referrer_host: 'chatgpt.com' }, 'ai_assistant'],
    [{ utm_source: 'chatgpt.com' }, 'ai_assistant'],
    [{ referrer_host: 't.co' }, 'social'],
    [{ referrer_host: 'news.ycombinator.com' }, 'social'],
    [{ referrer_host: 'blog.partner.io' }, 'referral'],
    [{ utm_source: 'google', utm_medium: 'cpc', referrer_host: 'google.com' }, 'paid'],
    [{ utm_medium: 'paid_social', utm_source: 'facebook' }, 'paid'],
    [{ utm_medium: 'email', utm_source: 'mailchimp' }, 'email'],
    [{ utm_source: 'newsletter' }, 'email'],
    [{ utm_source: 'linkedin', utm_medium: 'post' }, 'social'],
    [{ utm_source: 'google', utm_medium: 'organic' }, 'organic_search'],
    [{ utm_campaign: 'spring', utm_source: 'flyer' }, 'unknown'],
  ];
  it.each(cases)('%j -> %s', (input, expected) => {
    expect(classifyChannel(input)).toBe(expected);
  });
});

describe('bots and devices', () => {
  it('flags bots and automation', () => {
    expect(detectBot(CHROME)).toBeNull();
    expect(detectBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe('bot_user_agent');
    expect(detectBot('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/120.0 Safari/537.36')).toBe('bot_user_agent');
    expect(detectBot('curl/8.4.0')).toBe('bot_user_agent');
    expect(detectBot('')).toBe('empty_user_agent');
    expect(detectBot(CHROME, true)).toBe('automation_flag');
  });
  it('categorizes devices', () => {
    expect(deviceFromUserAgent(CHROME)).toBe('desktop');
    expect(deviceFromUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148')).toBe('mobile');
    expect(deviceFromUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('tablet');
    expect(deviceFromUserAgent('Mozilla/5.0 (Linux; Android 14; SM-X200) Safari/537.36')).toBe('tablet');
    expect(deviceFromUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36')).toBe('mobile');
  });
});

describe('schemas', () => {
  const ev = {
    event_id: '0b6c6f3e-7c51-4d0a-9d55-2a3b1d1e9f10',
    event_name: 'page_view',
    event_time: '2026-11-10T10:30:00Z',
    page_path: '/products/example',
    properties: { page_type: 'product' },
  };
  it('accepts a valid event and defaults consent', () => {
    const p = incomingEventSchema.parse(ev);
    expect(p.consent_state).toBe('pending');
  });
  it('rejects bad events', () => {
    expect(incomingEventSchema.safeParse({ ...ev, event_id: 'nope' }).success).toBe(false);
    expect(incomingEventSchema.safeParse({ ...ev, event_name: 'has space' }).success).toBe(false);
    expect(incomingEventSchema.safeParse({ ...ev, properties: { nested: { a: 1 } } }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`k${i}`, i]));
    expect(incomingEventSchema.safeParse({ ...ev, properties: many }).success).toBe(false);
  });
  it('limits batch size', () => {
    expect(batchEnvelopeSchema.safeParse({ site_id: 's', schema_version: 1, events: [] }).success).toBe(false);
    expect(batchEnvelopeSchema.safeParse({ site_id: 's', schema_version: 1, events: Array(51).fill(ev) }).success).toBe(false);
    expect(batchEnvelopeSchema.safeParse({ site_id: 's', schema_version: 2, events: [ev] }).success).toBe(false);
  });
  it('bounds analytics ranges', () => {
    const base = { site_id: '0b6c6f3e-7c51-4d0a-9d55-2a3b1d1e9f10' };
    expect(analyticsQuerySchema.safeParse({ ...base, from: '2026-01-01', to: '2026-01-31' }).success).toBe(true);
    expect(analyticsQuerySchema.safeParse({ ...base, from: '2026-01-31', to: '2026-01-01' }).success).toBe(false);
    expect(analyticsQuerySchema.safeParse({ ...base, from: '2025-01-01', to: '2026-03-01' }).success).toBe(false);
    expect(rangeDays('2026-01-01', '2026-01-07')).toBe(7);
    expect(previousPeriod('2026-01-08', '2026-01-14')).toEqual({ from: '2026-01-01', to: '2026-01-07' });
  });
  it('normalizes site input', () => {
    const s = createSiteSchema.parse({ name: 'Shop', domain: 'https://WWW.Shop.com/path' });
    expect(s).toEqual({ name: 'Shop', domain: 'shop.com', timezone: 'UTC' });
    expect(createSiteSchema.safeParse({ name: 'x', domain: 'x.com', timezone: 'Mars/Base' }).success).toBe(false);
  });
});
