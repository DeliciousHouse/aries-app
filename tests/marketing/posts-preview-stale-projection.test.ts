import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getWorkflowAwareDashboardContentForTenant } from '../../backend/marketing/workspace-views';
import { __resetHermesMediaPresenceCacheForTests } from '../../backend/marketing/hermes-media-presence';

// qa-defect #599 (REOPENED): the Posts page (`/api/marketing/posts` →
// getWorkflowAwareDashboardContentForTenant) serves the PERSISTED
// `dashboard_list_projection.listRow.dashboard.assets` O(1) whenever its baked
// `sourceUpdatedAt` still matches the runtime doc — the steady state for old
// jobs. Those blobs were baked weeks ago, when the Hermes-cache files still
// existed, so the basename-addressed `/api/internal/hermes/media/<basename>`
// previews they carry now 404 after the cache evicted the files. The build-time
// `createAssets` wrap (PR #612) can NEVER reach those stale rows. This proves
// the read-time sanitizer nulls evicted previews at the serving point while
// leaving live previews byte-identical.

const TENANT = 'tenant_599_readpath';
const JOB = 'mkt_599_readpath';
const UPDATED_AT = '2026-05-19T00:00:00.000Z';
const LIVE = 'openai_codex_gpt-image-2-low_20260520_live.png';
const EVICTED = 'openai_codex_gpt-image-2-medium_20260519_evicted.png';
const mediaUrl = (basename: string) =>
  `https://aries.sugarandleather.com/api/internal/hermes/media/${basename}`;

function emptyCounts() {
  return {
    draft: 0,
    in_review: 0,
    ready: 0,
    ready_to_publish: 0,
    published_to_meta_paused: 0,
    scheduled: 0,
    live: 0,
  };
}

function runtimeDoc() {
  return {
    schema_name: 'marketing_job_state_schema',
    job_id: JOB,
    tenant_id: TENANT,
    created_at: UPDATED_AT,
    updated_at: UPDATED_AT,
    current_stage: 'publish',
    stage_order: ['research', 'strategy', 'production', 'publish'],
    inputs: { request: { jobType: 'weekly_social_content' } },
    stages: { research: { status: 'completed' } },
  };
}

function asset(id: string, basename: string) {
  return {
    id,
    postId: JOB,
    jobId: JOB,
    type: 'image_ad',
    title: id,
    summary: id,
    platform: 'social',
    platformLabel: 'Social content',
    postName: 'Weekly social content',
    funnelStage: 'weekly_content',
    objective: 'Weekly social content',
    destinationUrl: null,
    previewUrl: mediaUrl(basename),
    thumbnailUrl: mediaUrl(basename),
    contentType: 'image/png',
    status: 'ready',
    createdAt: UPDATED_AT,
    relatedPostIds: [],
    relatedPublishItemIds: [],
    provenance: {
      sourceKind: 'creative_output',
      sourceStage: 'production',
      sourceRunId: null,
      isDerivedSchedule: true,
      isPlatformNative: false,
    },
  };
}

// A FRESH persisted projection (sourceUpdatedAt === runtimeDoc.updated_at) so the
// fast path serves it verbatim — exactly the production steady state.
function workspaceRecord() {
  const dashboard = {
    posts: [],
    assets: [asset('live-asset', LIVE), asset('evicted-asset', EVICTED)],
    publishItems: [],
    calendarEvents: [],
    statuses: { countsByStatus: emptyCounts() },
  };
  return {
    schema_name: 'marketing_campaign_workspace',
    job_id: JOB,
    tenant_id: TENANT,
    dashboard_list_projection: {
      post: null,
      sourceUpdatedAt: UPDATED_AT,
      listRow: { dashboard },
    },
  };
}

async function withSeededDataRoot<T>(run: () => Promise<T>): Promise<T> {
  const prevMount = process.env.HERMES_IMAGE_CACHE_MOUNT;
  const prevDataRoot = process.env.DATA_ROOT;
  const mount = await mkdtemp(path.join(tmpdir(), 'aries-599-mount-'));
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-599-data-'));
  // Mount holds ONLY the live file; the evicted basename is absent.
  await writeFile(path.join(mount, LIVE), 'png-bytes');

  const jobsDir = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs');
  const wsDir = path.join(dataRoot, 'generated', 'draft', 'marketing-workspaces', JOB);
  await mkdir(jobsDir, { recursive: true });
  await mkdir(wsDir, { recursive: true });
  await writeFile(path.join(jobsDir, `${JOB}.json`), JSON.stringify(runtimeDoc()));
  await writeFile(path.join(wsDir, 'workspace.json'), JSON.stringify(workspaceRecord()));

  process.env.HERMES_IMAGE_CACHE_MOUNT = mount;
  process.env.DATA_ROOT = dataRoot;
  __resetHermesMediaPresenceCacheForTests();
  try {
    return await run();
  } finally {
    if (prevMount === undefined) delete process.env.HERMES_IMAGE_CACHE_MOUNT;
    else process.env.HERMES_IMAGE_CACHE_MOUNT = prevMount;
    if (prevDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = prevDataRoot;
    __resetHermesMediaPresenceCacheForTests();
    await rm(mount, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('#599: Posts page nulls evicted Hermes-media previews served from a fresh persisted projection', async () => {
  await withSeededDataRoot(async () => {
    const content = await getWorkflowAwareDashboardContentForTenant(TENANT);

    const evicted = content.assets.find((a) => a.id === 'evicted-asset');
    const live = content.assets.find((a) => a.id === 'live-asset');
    assert.ok(evicted, 'expected the evicted asset to be present in the response');
    assert.ok(live, 'expected the live asset to be present in the response');

    // The evicted-media preview must be nulled so the UI placeholder fires
    // instead of a dead <img> → 404.
    assert.equal(evicted.previewUrl, null);
    assert.equal(evicted.thumbnailUrl, null);

    // The live media URL is untouched (byte-identical pass-through).
    assert.equal(live.previewUrl, mediaUrl(LIVE));
    assert.equal(live.thumbnailUrl, mediaUrl(LIVE));

    // No asset in the served response carries a dead hermes-media basename URL.
    const stillDead = content.assets.filter(
      (a) =>
        a.previewUrl?.includes(`/hermes/media/${EVICTED}`) ||
        a.thumbnailUrl?.includes(`/hermes/media/${EVICTED}`),
    );
    assert.equal(stillDead.length, 0, 'no served asset may reference the evicted media basename');
  });
});
