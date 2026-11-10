// SPA demo: programmatic SDK install + History API routing (page views come from the SDK's
// pushState/popstate hooks, not from this router).
import GrowthOS from '@growthos/sdk';
import './style.css';

GrowthOS.init({
  siteId: import.meta.env.VITE_GROWTHOS_SITE_ID,
  endpoint: import.meta.env.VITE_GROWTHOS_ENDPOINT,
  consent: (localStorage.getItem('demo_consent') as 'granted' | 'denied' | null) ?? 'pending',
  debug: true,
});

const views: Record<string, () => string> = {
  '/app': () => `
    <h1>Dashboard</h1>
    <p>Navigate with the header links: each route change is a <code>page_view</code> sent via the History API hook.</p>
    <div class="card row">
      <button id="create">Create project</button>
      <button class="secondary" id="upgrade">Upgrade plan</button>
    </div>
    <p>SDK version: <code>${GrowthOS.version}</code></p>`,
  '/app/projects': () => `
    <h1>Projects</h1>
    <div class="card">No projects yet. <button id="create">Create project</button></div>`,
  '/app/settings': () => `
    <h1>Settings</h1>
    <div class="card row">
      <button class="secondary" id="reset">Reset consent choice</button>
      <button class="secondary" id="optout">Opt out</button>
      <button class="secondary" id="optin">Opt back in</button>
    </div>`,
};

function render(): void {
  const path = location.pathname.replace(/\/+$/, '') || '/app';
  const view = views[path] ?? (() => `<h1>Not found</h1><p><a href="/app/" data-route>Back</a></p>`);
  document.getElementById('view')!.innerHTML = view();
  document.getElementById('create')?.addEventListener('click', () => GrowthOS.track('project_created', { template: 'blank' }));
  document.getElementById('upgrade')?.addEventListener('click', () => GrowthOS.track('upgrade_clicked', { from: 'dashboard' }));
  document.getElementById('optout')?.addEventListener('click', () => GrowthOS.optOut());
  document.getElementById('optin')?.addEventListener('click', () => GrowthOS.optIn());
  document.getElementById('reset')?.addEventListener('click', () => {
    localStorage.removeItem('demo_consent');
    GrowthOS.setConsent('pending');
    showBanner();
  });
}

document.addEventListener('click', (e) => {
  const a = (e.target as Element).closest<HTMLAnchorElement>('a[data-route]');
  if (!a || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  if (a.pathname !== location.pathname) history.pushState({}, '', a.pathname);
  render();
});
window.addEventListener('popstate', render);

function showBanner(): void {
  const el = document.getElementById('consent')!;
  el.hidden = !!localStorage.getItem('demo_consent');
}
document.querySelectorAll<HTMLButtonElement>('#consent button[data-consent]').forEach((b) =>
  b.addEventListener('click', () => {
    const v = b.dataset.consent as 'granted' | 'denied';
    localStorage.setItem('demo_consent', v);
    GrowthOS.setConsent(v);
    document.getElementById('consent')!.hidden = true;
  }),
);

showBanner();
render();
