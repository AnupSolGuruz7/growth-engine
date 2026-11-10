import type { DeviceCategory } from './events';
import { normalizeHost } from './url';

// ---------------------------------------------------------------- bots

const BOT_UA_RE = new RegExp(
  [
    'bot\\b', 'bot/', 'crawler', 'crawling', 'spider', 'slurp', 'mediapartners', 'bingpreview',
    'facebookexternalhit', 'embedly', 'quora link preview', 'whatsapp', 'telegrambot', 'discordbot',
    'headlesschrome', 'phantomjs', 'puppeteer', 'playwright', 'selenium', 'webdriver', 'electron/',
    'lighthouse', 'pagespeed', 'gtmetrix', 'pingdom', 'uptimerobot', 'statuscake', 'site24x7',
    'datadogsynthetics', 'newrelicpinger', 'checkly', 'ahrefs', 'semrush', 'mj12', 'dotbot', 'petalbot',
    'bytespider', 'gptbot', 'claudebot', 'ccbot', 'perplexitybot', 'amazonbot', 'applebot', 'yandex',
    'baiduspider', 'duckduckbot', 'curl/', 'wget/', 'python-requests', 'python-urllib', 'aiohttp',
    'httpx', 'axios/', 'node-fetch', 'undici', 'go-http-client', 'java/', 'okhttp', 'libwww-perl',
    'scrapy', 'httpclient', 'postmanruntime', 'insomnia',
  ].join('|'),
  'i',
);

export type BotReason = 'empty_user_agent' | 'bot_user_agent' | 'automation_flag';

/** Returns why a request looks automated, or null when it looks like a real browser. */
export function detectBot(userAgent: string | null | undefined, automationFlag?: boolean): BotReason | null {
  if (automationFlag) return 'automation_flag';
  const ua = (userAgent ?? '').trim();
  if (ua.length < 10) return 'empty_user_agent';
  if (BOT_UA_RE.test(ua)) return 'bot_user_agent';
  return null;
}

// ---------------------------------------------------------------- devices

/** Coarse device category from a user agent (fallback when the SDK did not send one). */
export function deviceFromUserAgent(userAgent: string | null | undefined): DeviceCategory {
  const ua = userAgent ?? '';
  if (/iPad|Tablet|PlayBook|Silk|Kindle|(Android(?!.*Mobile))/i.test(ua)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone|Opera Mini/i.test(ua)) return 'mobile';
  return 'desktop';
}

// ---------------------------------------------------------------- channels

export const CHANNELS = [
  'direct',
  'organic_search',
  'paid',
  'social',
  'email',
  'referral',
  'ai_assistant',
  'unknown',
] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_LABELS: Record<Channel, string> = {
  direct: 'Direct',
  organic_search: 'Organic search',
  paid: 'Paid',
  social: 'Social',
  email: 'Email',
  referral: 'Referral',
  ai_assistant: 'AI assistants',
  unknown: 'Unknown',
};

const SEARCH_HOSTS = [
  /(^|\.)google\.[a-z.]+$/, /(^|\.)bing\.com$/, /(^|\.)duckduckgo\.com$/, /(^|\.)search\.yahoo\.com$/,
  /(^|\.)yahoo\.[a-z.]+$/, /(^|\.)yandex\.[a-z.]+$/, /(^|\.)baidu\.com$/, /(^|\.)ecosia\.org$/,
  /^search\.brave\.com$/, /(^|\.)startpage\.com$/, /(^|\.)qwant\.com$/, /(^|\.)naver\.com$/,
  /(^|\.)seznam\.cz$/, /(^|\.)ask\.com$/,
];
const AI_HOSTS = [
  /(^|\.)chatgpt\.com$/, /^chat\.openai\.com$/, /(^|\.)perplexity\.ai$/, /^gemini\.google\.com$/,
  /^bard\.google\.com$/, /^copilot\.microsoft\.com$/, /(^|\.)claude\.ai$/, /(^|\.)you\.com$/,
  /(^|\.)phind\.com$/, /(^|\.)poe\.com$/, /(^|\.)deepseek\.com$/, /(^|\.)meta\.ai$/, /(^|\.)mistral\.ai$/,
];
const SOCIAL_HOSTS = [
  /(^|\.)facebook\.com$/, /^fb\.me$/, /^l\.facebook\.com$/, /(^|\.)instagram\.com$/, /^t\.co$/,
  /(^|\.)twitter\.com$/, /(^|\.)x\.com$/, /(^|\.)linkedin\.com$/, /^lnkd\.in$/, /(^|\.)reddit\.com$/,
  /(^|\.)pinterest\.[a-z.]+$/, /(^|\.)tiktok\.com$/, /(^|\.)youtube\.com$/, /^youtu\.be$/,
  /(^|\.)threads\.net$/, /(^|\.)bsky\.app$/, /(^|\.)mastodon\.social$/, /(^|\.)quora\.com$/,
  /(^|\.)snapchat\.com$/, /(^|\.)vk\.com$/, /(^|\.)news\.ycombinator\.com$/,
];
const EMAIL_HOSTS = [/^mail\.google\.com$/, /(^|\.)outlook\.(live|office)\.com$/, /^mail\.yahoo\.com$/];

const SOCIAL_SOURCES = new Set([
  'facebook', 'fb', 'instagram', 'ig', 'twitter', 'x', 'linkedin', 'reddit', 'pinterest', 'tiktok',
  'youtube', 'threads', 'bluesky', 'mastodon', 'snapchat', 'whatsapp', 'telegram',
]);
const AI_SOURCES = new Set(['chatgpt', 'chatgpt.com', 'openai', 'perplexity', 'gemini', 'copilot', 'claude']);

const PAID_MEDIUM_RE = /^(cpc|ppc|cpm|cpv|cpa|paid|paid[-_ ]?(search|social|media)|display|banner|retargeting|remarketing|affiliate|sponsored|ads?)$/;
const EMAIL_MEDIUM_RE = /^(e[-_]?mail|newsletter)$/;
const SOCIAL_MEDIUM_RE = /^(social|social[-_ ]?(network|media)|sm|organic[-_ ]?social)$/;

const matchAny = (host: string, list: RegExp[]) => list.some((r) => r.test(host));

export interface TouchInput {
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  /** Normalised external referrer host (internal referrers must already be removed). */
  referrer_host?: string | null;
}

/**
 * Channel classification. Order matters:
 * paid (utm_medium) > email > AI assistants > social > organic search > referral > unknown > direct.
 * Any UTM tag that matches no rule is `unknown` (tagged traffic we cannot place).
 */
export function classifyChannel(t: TouchInput): Channel {
  const medium = (t.utm_medium ?? '').trim().toLowerCase();
  const source = (t.utm_source ?? '').trim().toLowerCase();
  const host = t.referrer_host ? normalizeHost(t.referrer_host) : '';
  const hasUtm = Boolean(medium || source || (t.utm_campaign ?? '').trim());

  if (medium && (PAID_MEDIUM_RE.test(medium) || medium.includes('paid'))) return 'paid';
  if (EMAIL_MEDIUM_RE.test(medium) || source === 'email' || source === 'newsletter') return 'email';
  if (AI_SOURCES.has(source) || (host && matchAny(host, AI_HOSTS))) return 'ai_assistant';
  if (SOCIAL_MEDIUM_RE.test(medium) || SOCIAL_SOURCES.has(source)) return 'social';
  if (medium === 'organic') return 'organic_search';
  if (host) {
    if (matchAny(host, SOCIAL_HOSTS)) return 'social';
    if (matchAny(host, SEARCH_HOSTS)) return 'organic_search';
    if (matchAny(host, EMAIL_HOSTS)) return 'email';
    return 'referral';
  }
  return hasUtm ? 'unknown' : 'direct';
}

/** True when the touch carries any attribution (UTM or external referrer). */
export function isNonDirectTouch(t: TouchInput): boolean {
  return Boolean(
    (t.utm_source ?? '').trim() || (t.utm_medium ?? '').trim() || (t.utm_campaign ?? '').trim() || t.referrer_host,
  );
}
