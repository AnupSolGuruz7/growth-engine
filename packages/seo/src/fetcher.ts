import { isIP } from 'node:net';
import { fetch, type Agent } from 'undici';
import { BlockedAddressError, isPrivateAddress } from './net';

export interface FetchOptions {
  agent: Agent;
  userAgent: string;
  timeoutMs: number;
  maxBytes: number;
  allowPrivate: boolean;
}

export interface Hop {
  url: string;
  status: number;
}

export interface FetchResult {
  /** Every response in order; the last one is the final response. */
  hops: Hop[];
  finalUrl: string;
  status: number | null;
  contentType: string | null;
  xRobotsTag: string | null;
  body: string | null;
  bytes: number | null;
  ms: number;
  error: string | null;
  /** True when a redirect left the allowed host (the crawl does not follow it). */
  leftHost: boolean;
}

const MAX_REDIRECTS = 5;

async function readCapped(res: Awaited<ReturnType<typeof fetch>>, maxBytes: number): Promise<{ text: string; bytes: number }> {
  if (!res.body) return { text: '', bytes: 0 };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) break; // keep what we have; huge pages are flagged by size
    chunks.push(chunk);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes };
}

/**
 * GETs a URL, following up to 5 redirects by hand so the full chain is recorded. Only GET is ever
 * sent; no cookies, no forms. Redirects to another host are recorded but not followed.
 */
export async function fetchUrl(url: string, isAllowedHost: (host: string) => boolean, o: FetchOptions): Promise<FetchResult> {
  const started = Date.now();
  const hops: Hop[] = [];
  let current = url;
  const base: FetchResult = {
    hops, finalUrl: url, status: null, contentType: null, xRobotsTag: null, body: null, bytes: null,
    ms: 0, error: null, leftHost: false,
  };
  try {
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      const host = new URL(current).hostname.replace(/^\[|\]$/g, '');
      if (!o.allowPrivate && isIP(host) && isPrivateAddress(host)) throw new BlockedAddressError(host);
      const res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        dispatcher: o.agent,
        headers: { 'user-agent': o.userAgent, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5' },
        signal: AbortSignal.timeout(o.timeoutMs),
      });
      hops.push({ url: current, status: res.status });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => undefined);
        const next = new URL(location, current).toString();
        if (!isAllowedHost(new URL(next).hostname)) {
          return { ...base, finalUrl: next, status: res.status, leftHost: true, ms: Date.now() - started };
        }
        current = next;
        continue;
      }
      const contentType = res.headers.get('content-type');
      const isText = !contentType || /text\/|xml|json/.test(contentType);
      const { text, bytes } = isText ? await readCapped(res, o.maxBytes) : { text: null as never, bytes: Number(res.headers.get('content-length')) || null };
      if (!isText) await res.body?.cancel().catch(() => undefined);
      return {
        ...base,
        finalUrl: current,
        status: res.status,
        contentType,
        xRobotsTag: res.headers.get('x-robots-tag'),
        body: isText ? text : null,
        bytes: bytes as number | null,
        ms: Date.now() - started,
      };
    }
    return { ...base, finalUrl: current, status: hops.at(-1)?.status ?? null, error: 'too_many_redirects', ms: Date.now() - started };
  } catch (e) {
    const err = e as Error & { cause?: Error & { code?: string } };
    const msg = err instanceof BlockedAddressError || err.cause instanceof BlockedAddressError
      ? 'blocked_private_address'
      : err.name === 'TimeoutError' || err.cause?.code === 'UND_ERR_CONNECT_TIMEOUT'
        ? 'timeout'
        : (err.cause?.code ?? err.message).slice(0, 200);
    return { ...base, finalUrl: current, error: msg, ms: Date.now() - started };
  }
}
