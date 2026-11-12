import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { Agent } from 'undici';

/** True for loopback, private, link-local, CGNAT, multicast/reserved and unspecified addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('ff');
  }
  return true; // not an IP at all: refuse
}

export class BlockedAddressError extends Error {
  constructor(host: string) {
    super(`Refusing to connect to a private or internal address (${host})`);
  }
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * An undici dispatcher whose DNS lookup drops private addresses, so the crawler cannot be pointed at
 * internal services (SSRF) — including via redirects or DNS that resolves to 127.0.0.1. The check runs
 * on the address actually connected to, not on a separate pre-resolution.
 */
export function createCrawlerAgent(allowPrivate: boolean, timeoutMs: number): Agent {
  const lookup = (hostname: string, options: { all?: boolean }, cb: LookupCb) => {
    dnsLookup(hostname, { all: true }, (err, addrs) => {
      if (err) return cb(err, []);
      const ok = allowPrivate ? addrs : addrs.filter((a) => !isPrivateAddress(a.address));
      if (!ok.length) return cb(Object.assign(new BlockedAddressError(hostname), { code: 'EBLOCKED' }), []);
      if (options?.all) return cb(null, ok);
      return cb(null, ok[0]!.address, ok[0]!.family);
    });
  };
  return new Agent({
    connect: { lookup: lookup as never, timeout: timeoutMs },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });
}
