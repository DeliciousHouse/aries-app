import { test } from '@playwright/test';
import { DEMO } from '../fixtures/demo-config';

test('B-roll 03 — signup form fill (does not submit)', async ({ page }) => {
  await page.goto('/signup');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  const typeOpts = { delay: 60 };

  await page.getByRole('textbox', { name: /full name/i }).click();
  await page.getByRole('textbox', { name: /full name/i }).pressSequentially(DEMO.account.fullName, typeOpts);
  await page.waitForTimeout(400);

  await page.getByRole('textbox', { name: /organization/i }).click();
  await page.getByRole('textbox', { name: /organization/i }).pressSequentially(DEMO.brandName, typeOpts);
  await page.waitForTimeout(400);

  const timestampEmail = `demo+${Date.now()}@sugarandleather.com`;
  await page.getByRole('textbox', { name: /email/i }).click();
  await page.getByRole('textbox', { name: /email/i }).pressSequentially(timestampEmail, typeOpts);
  await page.waitForTimeout(400);

  await page.getByRole('textbox', { name: /password/i }).click();
  await page.getByRole('textbox', { name: /password/i }).pressSequentially('DemoBroll16!', typeOpts);
  await page.waitForTimeout(2500);

  const registerBtn = page.getByRole('button', { name: /register/i });
  await registerBtn.hover();
  await page.waitForTimeout(2000);
});
