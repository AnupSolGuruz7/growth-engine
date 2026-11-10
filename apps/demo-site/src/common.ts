// Shared bits for the multi-page demo (SDK loaded by the <script src=".../sdk.js"> tag).
import './style.css';

type Client = {
  track(name: string, props?: Record<string, string | number | boolean | null>): void;
  setConsent(s: 'granted' | 'denied' | 'pending'): void;
  optOut(): void;
  optIn(): void;
};
type W = Window & { GrowthOS?: Client; gosq?: unknown[][] };
const w = window as W;

/** Calls the SDK now, or queues the call until the async script has loaded. */
export function gos<K extends keyof Client>(method: K, ...args: Parameters<Client[K]>): void {
  if (w.GrowthOS) (w.GrowthOS[method] as (...a: unknown[]) => void)(...args);
  else (w.gosq ??= []).push([method, ...args]);
}

export function mountConsentBanner(setConsent: (s: 'granted' | 'denied') => void): void {
  const saved = localStorage.getItem('demo_consent') as 'granted' | 'denied' | null;
  if (saved) setConsent(saved);
  const el = document.getElementById('consent');
  if (!el) return;
  el.hidden = !!saved;
  el.querySelectorAll<HTMLButtonElement>('button[data-consent]').forEach((b) =>
    b.addEventListener('click', () => {
      const v = b.dataset.consent as 'granted' | 'denied';
      localStorage.setItem('demo_consent', v); // the demo's own consent record, not a tracking id
      setConsent(v);
      el.hidden = true;
    }),
  );
}

mountConsentBanner((s) => gos('setConsent', s));

document.querySelectorAll<HTMLElement>('[data-track]').forEach((el) =>
  el.addEventListener('click', () => gos('track', el.dataset.track!, JSON.parse(el.dataset.props ?? '{}'))),
);
document.getElementById('optout')?.addEventListener('click', () => gos('optOut'));
document.getElementById('reset-consent')?.addEventListener('click', () => {
  localStorage.removeItem('demo_consent');
  location.reload();
});
