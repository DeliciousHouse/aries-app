import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from '../helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

// REGRESSION: live audit found the review queue listing failed campaigns
// under "Strategy review ready" / "Brand review ready" copy — but those
// campaigns have no approvable content because the pipeline failed before
// producing any. Reviewers got an empty review screen they couldn't action.
// Fix: filter failed jobs out at buildReviewItemsForJob.
//
// Test approach: use the real production fixture (mkt_b83fc598 — a complete
// job with full strategy+production output) as the baseline. Re-import the
// runtime-views module per test (with delete-cache + new module-version)
// so each variant gets a fresh load against its own DATA_ROOT.

async function withRuntimeEnv<T>(run: () => Promise<T>): Promise<T> {
  const prev = { CODE_ROOT: process.env.CODE_ROOT, DATA_ROOT: process.env.DATA_ROOT };
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-review-queue-fail-test-'));
  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  try {
    return await run();
  } finally {
    if (prev.CODE_ROOT === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = prev.CODE_ROOT;
    if (prev.DATA_ROOT === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prev.DATA_ROOT;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function seedFixture(stateOverride?: { state?: string; status?: string }): Promise<string> {
  const jobsRoot = path.join(process.env.DATA_ROOT!, 'generated', 'draft', 'marketing-jobs');
  await mkdir(jobsRoot, { recursive: true });
  const fixturePath = path.resolve('tests/fixtures/marketing-runtime-primary-output.json');
  const raw = JSON.parse(await readFile(fixturePath, 'utf8')) as Record<string, unknown>;
  // Force an active approval so buildReviewItemsForJob's workflow-approval
  // path produces at least one item for the baseline. The production fixture
  // is a fully completed job (approvals.current=null), which would yield zero
  // pending items under any filter — masking the regression we're testing.
  raw.state = stateOverride?.state ?? 'approval_required';
  raw.status = stateOverride?.status ?? 'awaiting_approval';
  raw.approvals = {
    current: {
      approval_id: 'apr_test',
      workflow_step_id: 'approve_stage_3',
      stage: 'strategy',
      status: 'pending',
      title: 'Approve strategy',
      message: 'Strategy is ready for review.',
      action_label: 'Open approval',
    },
    history: (raw.approvals as Record<string, unknown>)?.history ?? [],
  };
  const jobId = String(raw.job_id);
  const tenantId = String(raw.tenant_id);
  await writeFile(path.join(jobsRoot, `${jobId}.json`), JSON.stringify(raw, null, 2));
  return tenantId;
}

async function freshImport() {
  // Cache-bust with a query param so each invocation pulls a fresh evaluation
  // against the just-set DATA_ROOT.
  const url = `../../backend/marketing/runtime-views?cb=${Date.now()}${Math.random()}`;
  return (await import(url)) as typeof import('../../backend/marketing/runtime-views');
}

test('review queue: baseline (approval_required + active approval) DOES produce review items', async () => {
  // Control. Proves the fixture actually generates items so the failed-variant
  // assertions below can't pass trivially.
  await withRuntimeEnv(async () => {
    const tenantId = await seedFixture();
    const views = await freshImport();
    const queue = await views.listMarketingReviewQueueForTenant(tenantId);
    assert.ok(queue.reviews.length > 0, `baseline must produce items; got ${queue.reviews.length}`);
  });
});

test('review queue: same fixture flipped to state=failed produces ZERO review items', async () => {
  await withRuntimeEnv(async () => {
    const tenantId = await seedFixture({ state: 'failed', status: 'awaiting_approval' });
    const views = await freshImport();
    const queue = await views.listMarketingReviewQueueForTenant(tenantId);
    assert.equal(queue.reviews.length, 0, `state=failed must filter all items; got ${queue.reviews.length}`);
  });
});

test('review queue: same fixture with status=failed alone (state unchanged) ALSO produces ZERO items', async () => {
  await withRuntimeEnv(async () => {
    const tenantId = await seedFixture({ state: 'approval_required', status: 'failed' });
    const views = await freshImport();
    const queue = await views.listMarketingReviewQueueForTenant(tenantId);
    assert.equal(queue.reviews.length, 0, `status=failed must filter all items; got ${queue.reviews.length}`);
  });
});
