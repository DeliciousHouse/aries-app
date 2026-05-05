import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import SocialContentReviewPage from '../app/social-content/review/page';
import SocialContentStatusPage from '../app/social-content/status/page';
import { SocialContentNewJobScreenContent } from '../frontend/social-content/new-job';

const SOCIAL_CONTENT_ROUTE_SOURCES = [
  'app/social-content/new/page.tsx',
  'app/social-content/status/page.tsx',
  'app/social-content/review/page.tsx',
] as const;

const ALLOWED_CAMPAIGN_COPY_PATTERNS = [
  /\bMeta campaigns?\b/gi,
  /\bdeprecated legacy campaign(?:s)?\b/gi,
] as const;

function removeAllowedCampaignCopy(value: string): string {
  return ALLOWED_CAMPAIGN_COPY_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, ''),
    value,
  );
}

function assertNoStandaloneCampaignCopy(label: string, value: string): void {
  assert.doesNotMatch(
    removeAllowedCampaignCopy(value),
    /\bcampaigns?\b/i,
    `${label} must not expose standalone campaign copy`,
  );
}

test('social-content public routes and rendered surfaces avoid standalone campaign copy', async () => {
  for (const sourcePath of SOCIAL_CONTENT_ROUTE_SOURCES) {
    const source = await readFile(new URL(`../${sourcePath}`, import.meta.url), 'utf8');
    assertNoStandaloneCampaignCopy(sourcePath, source);
  }

  const newJobMarkup = renderToStaticMarkup(
    React.createElement(SocialContentNewJobScreenContent, {
      embedded: true,
      router: {
        push() {},
      },
    }),
  );
  assertNoStandaloneCampaignCopy('/social-content/new rendered surface', newJobMarkup);

  const statusMarkup = renderToStaticMarkup(
    await SocialContentStatusPage({ searchParams: Promise.resolve({}) }),
  );
  assertNoStandaloneCampaignCopy('/social-content/status rendered surface', statusMarkup);

  const reviewMarkup = renderToStaticMarkup(
    await SocialContentReviewPage({ searchParams: Promise.resolve({}) }),
  );
  assert.match(reviewMarkup, /Review social content/i);
  assert.match(reviewMarkup, /weekly content plan/i);
  assert.match(reviewMarkup, /content job/i);
  assert.match(reviewMarkup, /weekly posts/i);
  assertNoStandaloneCampaignCopy('/social-content/review rendered surface', reviewMarkup);
});
