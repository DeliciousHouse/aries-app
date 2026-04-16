import { test, expect } from '@playwright/test';
import { DEMO, requireEnv } from '../fixtures/demo-config';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const STORAGE_STATE_PATH = path.resolve(__dirname, '..', 'storage-state.json');

test('sign in the seeded demo account and persist its session', async ({ page }) => {
  const password = requireEnv('DEMO_PASSWORD');

  await page.goto('/login');
  await page.getByRole('textbox', { name: /email/i }).fill(DEMO.account.email);
  await page.getByRole('textbox', { name: /password/i }).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();

  await page.waitForURL(/\/(dashboard|onboarding\/start|marketing)/, { timeout: 30_000 });
  await expect(page).not.toHaveURL(/\/login/);

  await page.context().storageState({ path: STORAGE_STATE_PATH });
  await fs.access(STORAGE_STATE_PATH);
});
