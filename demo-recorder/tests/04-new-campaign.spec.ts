import { test } from '@playwright/test';
import path from 'node:path';
import { DEMO } from '../fixtures/demo-config';

test.use({ storageState: path.resolve(__dirname, '..', 'storage-state.json') });

test('B-roll 05 — new campaign form fill + submit + redirect to job-status', async ({
  page,
}) => {
  await page.goto('/marketing/new-job');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2500);

  const typeSlow = { delay: 25 };

  await page.getByRole('textbox', { name: /^website url/i }).click();
  await page.getByRole('textbox', { name: /^website url/i }).pressSequentially(DEMO.brandUrl, { delay: 50 });
  await page.waitForTimeout(800);

  await page.getByRole('textbox', { name: /brand voice/i }).click();
  await page.getByRole('textbox', { name: /brand voice/i }).pressSequentially(DEMO.brandVoice, typeSlow);
  await page.waitForTimeout(600);

  await page.getByRole('textbox', { name: /style.*vibe/i }).click();
  await page.getByRole('textbox', { name: /style.*vibe/i }).pressSequentially(DEMO.styleVibe, typeSlow);
  await page.waitForTimeout(600);

  await page.getByRole('textbox', { name: /must-use copy/i }).click();
  await page.getByRole('textbox', { name: /must-use copy/i }).pressSequentially(DEMO.mustUseCopy, typeSlow);
  await page.waitForTimeout(600);

  await page.getByRole('textbox', { name: /must-avoid aesthetics/i }).click();
  await page
    .getByRole('textbox', { name: /must-avoid aesthetics/i })
    .pressSequentially(DEMO.mustAvoidAesthetics, typeSlow);
  await page.waitForTimeout(600);

  await page.getByRole('textbox', { name: /extra notes|instructions/i }).click();
  await page.getByRole('textbox', { name: /extra notes|instructions/i }).pressSequentially(DEMO.notes, typeSlow);
  await page.waitForTimeout(600);

  await page.getByRole('textbox', { name: /competitor website url/i }).click();
  await page
    .getByRole('textbox', { name: /competitor website url/i })
    .pressSequentially(DEMO.competitorUrl, { delay: 50 });
  await page.waitForTimeout(1500);

  const submit = page.getByRole('button', { name: /start campaign/i });
  await submit.hover();
  await page.waitForTimeout(1200);
  await submit.click();

  await page.waitForURL(/\/marketing\/job-status\?jobId=/, { timeout: 30_000 });
  await page.waitForTimeout(4000);
});
