// Script-tag build: <script src=".../sdk.js" data-site-id="..." async></script>
// Exposes window.GrowthOS, auto-initialises from data-* attributes and replays calls queued in
// window.gosq = [['track', 'name', {...}], ...] before the script loaded.
import { createClient, type ConsentState } from './client';

type Queued = [string, ...unknown[]];
const w = window as unknown as { GrowthOS?: unknown; gosq?: Queued[] };

if (!w.GrowthOS) {
  const client = createClient();
  w.GrowthOS = client;
  try {
    const s = (document.currentScript ??
      document.querySelector('script[data-site-id]')) as HTMLScriptElement | null;
    const d = s?.dataset;
    if (d?.siteId) {
      client.init({
        siteId: d.siteId,
        endpoint: d.endpoint || new URL(s!.src, location.href).origin,
        consent: (d.consent as ConsentState) || 'pending',
        spa: d.spa !== 'false',
        autoPageviews: d.autoPageviews !== 'false',
        debug: d.debug === 'true',
      });
    }
    for (const [m, ...a] of w.gosq ?? []) {
      const fn = (client as unknown as Record<string, (...x: unknown[]) => unknown>)[m];
      if (typeof fn === 'function') fn(...a);
    }
  } catch {
    /* never break the host page */
  }
}
