import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  // select the seeded demo site and a range that covers the seeded data
  await page.addInitScript(() => {
    localStorage.setItem('growthos-dashboard', JSON.stringify({ state: { siteId: null, preset: '30d', custom: null, compare: true }, version: 0 }));
  });
});

test('overview loads seeded data', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  const visitors = page.getByTestId('kpi-visitors').locator('.kpi-value');
  await expect(visitors).toHaveText(/^[1-9][\d,.\s]*$/, { timeout: 15_000 });
  await expect(page.getByTestId('kpi-sessions').locator('.kpi-value')).toHaveText(/^[1-9]/);
  await expect(page.getByTestId('kpi-bounce-rate').locator('.kpi-value')).toHaveText(/%$/);
  // the previous-period line can be flat (zero height), so check the selected period's line
  await expect(page.locator('path.recharts-line-curve[name="Selected period"]')).toBeVisible();
  await expect(page.getByText('Previous period', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

const reports: [string, string, RegExp][] = [
  ['/pages', 'Pages', /^\/.*/],
  ['/sources', 'Sources', /Organic search|Direct/],
  ['/events', 'Events', /page_view/],
  ['/devices', 'Devices', /Desktop|Mobile/],
];
for (const [path, heading, rowText] of reports) {
  test(`${heading} report renders rows`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    await expect(page.locator('.bar-label').filter({ hasText: rowText }).first()).toBeVisible({ timeout: 15_000 });
  });
}

test('realtime shows active visitors', async ({ page }) => {
  await page.goto('/realtime');
  await expect(page.getByTestId('active-visitors')).toHaveText(/^\d+$/, { timeout: 15_000 });
});

test('sites page shows the install snippet', async ({ page }) => {
  await page.goto('/sites');
  await expect(page.getByText('data-site-id="gos_demo_local"')).toBeVisible({ timeout: 15_000 });
});

test('SEO audit page renders', async ({ page }) => {
  await page.goto('/seo');
  await expect(page.getByRole('heading', { name: 'SEO audit' })).toBeVisible();
  await expect(page.getByTestId('run-audit')).toBeVisible();
});

test('AI pages render (setup card without a key, the feature with one)', async ({ page }) => {
  const status = await (await page.request.get('http://localhost:4000/health')).json();
  expect(status.status).toBe('ok');
  for (const path of ['/growth', '/ask']) {
    await page.goto(path);
    await expect(page.getByTestId('ai-setup').or(page.locator('.page-head'))).toBeVisible();
  }
});
