import type { NormalizedEvent } from '@growthos/db';
import {
  UTM_KEYS,
  deviceFromUserAgent,
  extractUtm,
  hostOf,
  normalizeHost,
  normalizePath,
  sanitizeReferrer,
  sanitizeUrl,
  type ParsedEvent,
} from '@growthos/shared-types';

export interface NormalizeContext {
  siteDomain: string;
  userAgent: string;
  schemaVersion: number;
  sdkVersion: string | null;
}

const clean = (v: string | null | undefined, max = 256): string | null => {
  const t = (v ?? '').trim();
  return t ? t.slice(0, max) : null;
};

/**
 * Server-side normalisation. The SDK already sanitises, but every client is untrusted:
 * - page_url: origin + path + utm_* only; page_path normalised (from page_url if missing)
 * - utm_*: explicit fields, else taken from page_url
 * - referrer: origin + path; dropped entirely when internal (same site / same page host)
 * - persistent ids dropped unless consent is granted (spec §4.3)
 */
export function normalizeEvent(e: ParsedEvent, ctx: NormalizeContext): NormalizedEvent {
  const pageUrl = sanitizeUrl(e.page_url);
  const pageHost = hostOf(pageUrl);
  let path = e.page_path ?? null;
  if (!path && pageUrl) path = new URL(pageUrl).pathname;
  const utmFromUrl = extractUtm(pageUrl);
  const utm = Object.fromEntries(UTM_KEYS.map((k) => [k, clean(e[k]) ?? utmFromUrl[k] ?? null])) as Record<
    (typeof UTM_KEYS)[number],
    string | null
  >;

  let referrer = sanitizeReferrer(e.referrer);
  let referrerHost = hostOf(referrer);
  const siteHost = normalizeHost(ctx.siteDomain.replace(/:\d+$/, ''));
  if (referrerHost && (referrerHost === siteHost || referrerHost.endsWith('.' + siteHost) || referrerHost === pageHost)) {
    referrer = null;
    referrerHost = null;
  }

  const granted = e.consent_state === 'granted';
  return {
    event_id: e.event_id.toLowerCase(),
    event_name: e.event_name,
    event_time: new Date(e.event_time).toISOString(),
    visitor_id: granted ? clean(e.visitor_id, 64) : null,
    session_id: granted ? clean(e.session_id, 64) : null,
    ephemeral_id: clean(e.ephemeral_id, 64),
    page_url: pageUrl,
    page_path: path || pageUrl ? normalizePath(path) : null,
    page_title: clean(e.page_title, 512),
    referrer,
    referrer_host: referrerHost,
    ...utm,
    device_category: e.device_category ?? deviceFromUserAgent(ctx.userAgent),
    consent_state: e.consent_state,
    schema_version: ctx.schemaVersion,
    sdk_version: ctx.sdkVersion,
    properties: e.properties ?? {},
  };
}
