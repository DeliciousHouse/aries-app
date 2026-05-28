import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { RuntimeReviewItem } from '@/backend/marketing/runtime-views';

const FIXTURE_REVIEW_ITEM: RuntimeReviewItem = {
  id: 'job_test_t19::approval',
  jobId: 'job_test_t19',
  postId: 'job_test_t19',
  postName: 'Test Brand',
  reviewType: 'creative',
  workflowState: 'creative_review_required',
  workflowStage: 'production',
  title: 'Instagram feed post 1',
  channel: 'Instagram',
  placement: 'instagram_feed',
  scheduledFor: 'Awaiting review',
  status: 'in_review',
  summary: 'Brand statement that fits Instagram.',
  currentVersion: {
    id: 'creative-1',
    label: 'Current version',
    headline: 'Original headline',
    supportingText: 'Original caption text.',
    cta: 'Approve',
    notes: [],
  },
  previousVersion: undefined,
  lastDecision: null,
  notePlaceholder: undefined,
  assetId: 'creative-1',
  contentType: null,
  previewUrl: null,
  fullPreviewUrl: null,
  destinationUrl: null,
  sections: [],
  attachments: [],
  history: [],
};

const FIXTURE_FACEBOOK_ITEM: RuntimeReviewItem = {
  ...FIXTURE_REVIEW_ITEM,
  id: 'job_test_t19::approval-fb',
  channel: 'Facebook',
  placement: 'facebook_feed',
};

async function withDataRoot<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-t19-edit-'));
  const previousDataRoot = process.env.DATA_ROOT;
  process.env.DATA_ROOT = dataRoot;
  try {
    return await run(dataRoot);
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('runtime-edit-state: first edit creates file with previous=null', async () => {
  await withDataRoot(async () => {
    const { recordReviewItemEdit, getReviewItemEdit } = await import('@/backend/marketing/runtime-edit-state');
    const result = recordReviewItemEdit({
      jobId: 'job_t19_a',
      tenantId: 'tenant_a',
      reviewId: 'item-1',
      headline: 'Edited headline',
      supportingText: 'Edited supporting text.',
      editedBy: 'reviewer@tenant.example',
    });
    assert.equal(result.headline, 'Edited headline');
    assert.equal(result.supportingText, 'Edited supporting text.');
    assert.equal(result.previous, null);
    assert.equal(result.editedBy, 'reviewer@tenant.example');

    const persisted = getReviewItemEdit('job_t19_a', 'tenant_a', 'item-1');
    assert.ok(persisted);
    assert.equal(persisted!.headline, 'Edited headline');
  });
});

test('runtime-edit-state: second edit archives previous override', async () => {
  await withDataRoot(async () => {
    const { recordReviewItemEdit } = await import('@/backend/marketing/runtime-edit-state');
    recordReviewItemEdit({
      jobId: 'job_t19_b',
      tenantId: 'tenant_b',
      reviewId: 'item-1',
      headline: 'First edit',
      supportingText: 'First caption.',
    });
    const second = recordReviewItemEdit({
      jobId: 'job_t19_b',
      tenantId: 'tenant_b',
      reviewId: 'item-1',
      headline: 'Second edit',
      supportingText: 'Second caption.',
    });
    assert.equal(second.headline, 'Second edit');
    assert.deepEqual(second.previous, {
      headline: 'First edit',
      supportingText: 'First caption.',
    });
  });
});

test('runtime-edit-state: undefined input leaves prior override unchanged', async () => {
  await withDataRoot(async () => {
    const { recordReviewItemEdit } = await import('@/backend/marketing/runtime-edit-state');
    recordReviewItemEdit({
      jobId: 'job_t19_c',
      tenantId: 'tenant_c',
      reviewId: 'item-x',
      headline: 'Stable headline',
      supportingText: 'Stable caption.',
    });
    const next = recordReviewItemEdit({
      jobId: 'job_t19_c',
      tenantId: 'tenant_c',
      reviewId: 'item-x',
      supportingText: 'Updated caption only.',
    });
    assert.equal(next.headline, 'Stable headline');
    assert.equal(next.supportingText, 'Updated caption only.');
  });
});

test('PATCH /api/social-content/jobs/[jobId]/posts/[postId]: rejects request with no edit fields', async () => {
  await withDataRoot(async () => {
    const { handlePatchSocialContentPost } = await import('@/app/api/social-content/jobs/[jobId]/posts/[postId]/route');
    const request = new Request('http://aries.example.test/api/social-content/jobs/job_t19/posts/item-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const response = await handlePatchSocialContentPost(
      'job_t19',
      'item-1',
      request,
      async () => ({ userId: 'u_1', tenantId: 'tenant_a', tenantSlug: 't-a', role: 'tenant_admin' }),
    );
    assert.equal(response.status, 400);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.error, 'no_edit_fields');
  });
});

test('PATCH route: persists valid Instagram caption edit', async () => {
  await withDataRoot(async () => {
    const { handlePatchSocialContentPost } = await import('@/app/api/social-content/jobs/[jobId]/posts/[postId]/route');
    const item = { ...FIXTURE_REVIEW_ITEM };
    const request = new Request('http://aries.example.test/api/social-content/jobs/job_test_t19/posts/item-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        headline: 'Updated headline',
        supportingText: 'Updated caption that respects Instagram limits.',
      }),
    });
    const response = await handlePatchSocialContentPost(
      'job_test_t19',
      item.id,
      request,
      async () => ({ userId: 'u_1', tenantId: 'tenant_t19', tenantSlug: 't-t19', role: 'tenant_admin' }),
      {
        runtimeDocLoader: async () => ({ tenant_id: 'tenant_t19' }),
        resolver: async () => item,
        rebuilder: async () => [
          {
            ...item,
            currentVersion: {
              ...item.currentVersion,
              headline: 'Updated headline',
              supportingText: 'Updated caption that respects Instagram limits.',
            },
          },
        ],
      },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { review: RuntimeReviewItem; edit: { headline: string } };
    assert.equal(body.review.currentVersion.headline, 'Updated headline');
    assert.equal(body.review.currentVersion.supportingText, 'Updated caption that respects Instagram limits.');
    assert.equal(body.edit.headline, 'Updated headline');
  });
});

test('PATCH route: rejects too-long Instagram caption with caption_too_long', async () => {
  await withDataRoot(async () => {
    const { handlePatchSocialContentPost } = await import('@/app/api/social-content/jobs/[jobId]/posts/[postId]/route');
    const longText = 'a'.repeat(2201);
    const request = new Request('http://aries.example.test/api/social-content/jobs/job_test_t19/posts/item-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ supportingText: longText }),
    });
    const response = await handlePatchSocialContentPost(
      'job_test_t19',
      FIXTURE_REVIEW_ITEM.id,
      request,
      async () => ({ userId: 'u_1', tenantId: 'tenant_t19', tenantSlug: 't-t19', role: 'tenant_admin' }),
      {
        runtimeDocLoader: async () => ({ tenant_id: 'tenant_t19' }),
        resolver: async () => FIXTURE_REVIEW_ITEM,
        rebuilder: async () => [FIXTURE_REVIEW_ITEM],
      },
    );
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string; reason: string; validation_errors: string[] };
    assert.equal(body.error, 'caption_invalid');
    assert.equal(body.reason, 'caption_invalid');
    assert.ok(body.validation_errors.includes('caption_too_long'));
  });
});

test('PATCH route: accepts Facebook caption longer than IG limit', async () => {
  await withDataRoot(async () => {
    const { handlePatchSocialContentPost } = await import('@/app/api/social-content/jobs/[jobId]/posts/[postId]/route');
    const longText = 'a'.repeat(3000);
    const request = new Request('http://aries.example.test/api/social-content/jobs/job_test_t19/posts/item-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ supportingText: longText }),
    });
    const response = await handlePatchSocialContentPost(
      'job_test_t19',
      FIXTURE_FACEBOOK_ITEM.id,
      request,
      async () => ({ userId: 'u_1', tenantId: 'tenant_t19', tenantSlug: 't-t19', role: 'tenant_admin' }),
      {
        runtimeDocLoader: async () => ({ tenant_id: 'tenant_t19' }),
        resolver: async () => FIXTURE_FACEBOOK_ITEM,
        rebuilder: async () => [
          {
            ...FIXTURE_FACEBOOK_ITEM,
            currentVersion: { ...FIXTURE_FACEBOOK_ITEM.currentVersion, supportingText: longText },
          },
        ],
      },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { review: RuntimeReviewItem };
    assert.equal(body.review.currentVersion.supportingText, longText);
  });
});

test('PATCH route: cross-tenant attempt resolves to 404', async () => {
  await withDataRoot(async () => {
    const { handlePatchSocialContentPost } = await import('@/app/api/social-content/jobs/[jobId]/posts/[postId]/route');
    const request = new Request('http://aries.example.test/api/social-content/jobs/job_test_t19/posts/item-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ headline: 'Sneaky edit' }),
    });
    const response = await handlePatchSocialContentPost(
      'job_test_t19',
      FIXTURE_REVIEW_ITEM.id,
      request,
      async () => ({ userId: 'u_attacker', tenantId: 'tenant_other', tenantSlug: 't-other', role: 'tenant_admin' }),
      {
        runtimeDocLoader: async () => ({ tenant_id: 'tenant_t19' }),
        resolver: async () => FIXTURE_REVIEW_ITEM,
      },
    );
    assert.equal(response.status, 404);
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, 'review_not_found');
  });
});

test('PATCH route: review item not found resolves to 404', async () => {
  await withDataRoot(async () => {
    const { handlePatchSocialContentPost } = await import('@/app/api/social-content/jobs/[jobId]/posts/[postId]/route');
    const request = new Request('http://aries.example.test/api/social-content/jobs/job_test_t19/posts/missing', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ headline: 'edit' }),
    });
    const response = await handlePatchSocialContentPost(
      'job_test_t19',
      'missing',
      request,
      async () => ({ userId: 'u_1', tenantId: 'tenant_t19', tenantSlug: 't-t19', role: 'tenant_admin' }),
      {
        runtimeDocLoader: async () => ({ tenant_id: 'tenant_t19' }),
        resolver: async () => null,
      },
    );
    assert.equal(response.status, 404);
  });
});

test('PATCH route: writes edit override file under DATA_ROOT', async () => {
  await withDataRoot(async (dataRoot) => {
    const { handlePatchSocialContentPost } = await import('@/app/api/social-content/jobs/[jobId]/posts/[postId]/route');
    const request = new Request('http://aries.example.test/api/social-content/jobs/job_evidence_t19/posts/item-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        headline: 'Persisted headline',
        supportingText: 'Persisted caption.',
        editedBy: 'reviewer@tenant.example',
      }),
    });
    const response = await handlePatchSocialContentPost(
      'job_evidence_t19',
      FIXTURE_REVIEW_ITEM.id,
      request,
      async () => ({ userId: 'u_1', tenantId: 'tenant_t19', tenantSlug: 't-t19', role: 'tenant_admin' }),
      {
        runtimeDocLoader: async () => ({ tenant_id: 'tenant_t19' }),
        resolver: async () => ({ ...FIXTURE_REVIEW_ITEM, jobId: 'job_evidence_t19' }),
        rebuilder: async () => [
          {
            ...FIXTURE_REVIEW_ITEM,
            jobId: 'job_evidence_t19',
            currentVersion: {
              ...FIXTURE_REVIEW_ITEM.currentVersion,
              headline: 'Persisted headline',
              supportingText: 'Persisted caption.',
            },
          },
        ],
      },
    );
    assert.equal(response.status, 200);
    const overlayPath = path.join(dataRoot, 'generated', 'draft', 'marketing-review-edits', 'job_evidence_t19.json');
    const overlay = JSON.parse(await readFile(overlayPath, 'utf8')) as {
      tenant_id: string;
      items: Record<string, { headline: string; supportingText: string; editedBy: string | null }>;
    };
    assert.equal(overlay.tenant_id, 'tenant_t19');
    const entry = overlay.items[FIXTURE_REVIEW_ITEM.id];
    assert.ok(entry);
    assert.equal(entry.headline, 'Persisted headline');
    assert.equal(entry.editedBy, 'reviewer@tenant.example');
  });
});
