import { test } from '@playwright/test';
import path from 'node:path';
import { DEMO } from '../fixtures/demo-config';

test.use({ storageState: path.resolve(__dirname, '..', 'storage-state.json') });

test('B-roll 06 — job status pipeline + audit trail scroll', async ({ page }) => {
  if (!DEMO.existingJobId) {
    test.skip(
      true,
      'Set DEMO_JOB_ID to an existing campaign job id to record this clip, or run 04-new-campaign first to create one.',
    );
  }

  await page.goto(`/marketing/job-status?jobId=${DEMO.existingJobId}`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000);

  await page.evaluate(() => window.scrollTo({ top: 500, behavior: 'smooth' }));
  await page.waitForTimeout(4000);

  await page.evaluate(() => window.scrollTo({ top: 1100, behavior: 'smooth' }));
  await page.waitForTimeout(4000);

  await page.evaluate(() => window.scrollTo({ top: 1800, behavior: 'smooth' }));
  await page.waitForTimeout(4000);

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await page.waitForTimeout(2500);
});
