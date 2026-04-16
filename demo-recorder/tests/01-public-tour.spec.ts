import { test } from '@playwright/test';

test.describe.configure({ mode: 'serial' });

test('B-roll 01 — home hero + problem + features + meet-aries tour', async ({ page }) => {
  await page.goto('/');

  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);

  async function smoothScrollTo(y: number) {
    await page.evaluate((target) => {
      window.scrollTo({ top: target, behavior: 'smooth' });
    }, y);
    await page.waitForTimeout(2500);
  }

  await smoothScrollTo(0);
  await page.waitForTimeout(2000);

  await smoothScrollTo(900);
  await smoothScrollTo(1800);
  await smoothScrollTo(2895);
  await page.waitForTimeout(3500);
  await smoothScrollTo(4014);
  await page.waitForTimeout(3500);
  await smoothScrollTo(5062);
  await page.waitForTimeout(3000);
  await smoothScrollTo(6338);
  await page.waitForTimeout(2500);

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await page.waitForTimeout(2000);
});

test('B-roll 02 — marketing subpages flyover (features, docs, api-docs, terms, privacy)', async ({
  page,
}) => {
  const pages: Array<{ path: string; dwellMs: number }> = [
    { path: '/features', dwellMs: 4000 },
    { path: '/documentation', dwellMs: 4000 },
    { path: '/api-docs', dwellMs: 4000 },
    { path: '/privacy', dwellMs: 2500 },
    { path: '/terms', dwellMs: 2500 },
  ];

  for (const p of pages) {
    await page.goto(p.path);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(p.dwellMs);

    const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const targetMid = Math.min(1200, scrollHeight / 2);
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'smooth' }), targetMid);
    await page.waitForTimeout(2500);
  }
});
