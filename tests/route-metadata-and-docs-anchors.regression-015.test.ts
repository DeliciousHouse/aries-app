import assert from 'node:assert/strict';
import test from 'node:test';

import { metadata as sitemapMetadata } from '../app/sitemap/page';
import { metadata as reviewMetadata } from '../app/review/page';
import { metadata as publishStatusMetadata } from '../app/dashboard/publish-status/page';
import { metadata as dashboardCampaignsMetadata } from '../app/dashboard/campaigns/page';
import { metadata as dashboardNewCampaignMetadata } from '../app/dashboard/campaigns/new/page';
import { metadata as marketingNewJobMetadata } from '../app/marketing/new-job/page';
import { metadata as marketingJobStatusMetadata } from '../app/marketing/job-status/page';
import { metadata as marketingJobApproveMetadata } from '../app/marketing/job-approve/page';
import {
  DIVIDED_SECTION_ANCHOR_CLASS,
  SECTION_ANCHOR_CLASS,
} from '../frontend/documentation/Docs';

test('route-level metadata stays specific for QA-regressed pages', () => {
  assert.equal(sitemapMetadata.title, 'Sitemap · Aries AI');
  assert.equal(reviewMetadata.title, 'Review · Aries AI');
  assert.equal(publishStatusMetadata.title, 'Publish Status · Aries AI');
  assert.equal(dashboardCampaignsMetadata.title, 'Campaigns · Aries AI');
  assert.equal(dashboardNewCampaignMetadata.title, 'New Campaign · Aries AI');
  assert.equal(marketingNewJobMetadata.title, 'New Campaign · Aries AI');
  assert.equal(marketingJobStatusMetadata.title, 'Campaign Status · Aries AI');
  assert.equal(marketingJobApproveMetadata.title, 'Campaign Approval · Aries AI');
});

test('documentation anchors keep a top offset for clean in-page navigation', () => {
  assert.match(SECTION_ANCHOR_CLASS, /\bscroll-mt-32\b/);
  assert.match(DIVIDED_SECTION_ANCHOR_CLASS, /\bscroll-mt-32\b/);
  assert.match(DIVIDED_SECTION_ANCHOR_CLASS, /\bmd:scroll-mt-36\b/);
});
