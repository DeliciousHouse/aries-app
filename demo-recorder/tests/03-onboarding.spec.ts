import { test } from '@playwright/test';
import path from 'node:path';
import { DEMO } from '../fixtures/demo-config';

test.use({ storageState: path.resolve(__dirname, '..', 'storage-state.json') });

test('B-roll 04 — onboarding steps 1 through 4 (skips blocked step 5 submit)', async ({
  page,
}) => {
  await page.goto('/onboarding/start');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2500);

  // Step 1 — Goal
  await page.getByRole('radio', { name: /sell a product or service/i }).click();
  await page.waitForTimeout(800);

  await page.getByRole('textbox', { name: /describe your core offer/i }).click();
  await page
    .getByRole('textbox', { name: /describe your core offer/i })
    .pressSequentially(DEMO.offer, { delay: 25 });
  await page.waitForTimeout(800);

  await page.getByRole('textbox', { name: /competitor website/i }).click();
  await page
    .getByRole('textbox', { name: /competitor website/i })
    .pressSequentially(DEMO.competitorUrl, { delay: 40 });
  await page.waitForTimeout(1500);

  await page.getByRole('button', { name: /continue/i }).click();
  await page.waitForTimeout(2000);

  // Step 2 — Business
  await page.getByRole('textbox', { name: /business type/i }).click();
  await page
    .getByRole('textbox', { name: /business type/i })
    .pressSequentially(DEMO.businessType, { delay: 25 });
  await page.waitForTimeout(600);

  await page.getByRole('textbox', { name: /launch approver/i }).click();
  await page
    .getByRole('textbox', { name: /launch approver/i })
    .pressSequentially(DEMO.approverName, { delay: 50 });
  await page.waitForTimeout(600);

  await page.getByRole('textbox', { name: /current source/i }).click();
  await page
    .getByRole('textbox', { name: /current source/i })
    .pressSequentially(DEMO.brandUrl, { delay: 50 });
  await page.waitForTimeout(1500);

  await page.getByRole('button', { name: /continue/i }).click();
  await page.waitForTimeout(2500);

  // Step 3 — Website (pre-populated from step 2)
  await page.waitForTimeout(4000);
  await page.getByRole('button', { name: /continue/i }).click();
  await page.waitForTimeout(3500);

  // Step 4 — Brand identity (auto-fetched, dwell for the reveal)
  await page.evaluate(() => window.scrollTo({ top: 200, behavior: 'smooth' }));
  await page.waitForTimeout(4500);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await page.waitForTimeout(2000);
  await page.getByRole('button', { name: /continue/i }).click();
  await page.waitForTimeout(2500);

  // Step 5 — Channels (show the card grid, but DO NOT attempt the broken "Continue to workspace")
  await page.evaluate(() => window.scrollTo({ top: 150, behavior: 'smooth' }));
  await page.waitForTimeout(1500);

  const email = page.getByRole('checkbox', { name: /email marketing/i });
  await email.hover();
  await page.waitForTimeout(800);
  await email.click();
  await page.waitForTimeout(1200);

  const tiktok = page.getByRole('checkbox', { name: /tiktok/i });
  await tiktok.hover();
  await page.waitForTimeout(800);
  await tiktok.click();
  await page.waitForTimeout(3000);
});
