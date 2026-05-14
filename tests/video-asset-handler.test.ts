import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function withRuntimeEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-video-asset-handler-'));
  process.env.DATA_ROOT = dataRoot;
  try {
    return await run(dataRoot);
  } finally {
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('handleGetMarketingJobAsset serves PNG video posters from the ingested job videos directory', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { handleGetMarketingJobAsset } = await import('../app/api/marketing/jobs/[jobId]/assets/[assetId]/handler');
    const jobId = 'mkt_video_png_poster';
    const runtimeFile = path.join(dataRoot, 'generated', 'draft', 'marketing-jobs', `${jobId}.json`);
    const videosRoot = path.join(dataRoot, 'generated', 'draft', 'jobs', jobId, 'videos');
    const videoPath = path.join(videosRoot, 'launch-cut.mp4');
    const posterPath = path.join(videosRoot, 'launch-cut-poster.png');

    await mkdir(path.dirname(runtimeFile), { recursive: true });
    await mkdir(videosRoot, { recursive: true });
    await writeFile(videoPath, Buffer.from('video-bytes'));
    await writeFile(posterPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(
      runtimeFile,
      JSON.stringify({
        schema_name: 'marketing_job_state_schema',
        schema_version: '1.0.0',
        job_id: jobId,
        job_type: 'brand_campaign',
        tenant_id: 'tenant_real',
        state: 'running',
        status: 'running',
        current_stage: 'production',
        stage_order: ['research', 'strategy', 'production', 'publish'],
        stages: {
          research: { stage: 'research', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-r', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          strategy: { stage: 'strategy', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-s', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          production: { stage: 'production', status: 'completed', started_at: null, completed_at: null, failed_at: null, run_id: 'run-p', summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
          publish: { stage: 'publish', status: 'not_started', started_at: null, completed_at: null, failed_at: null, run_id: null, summary: null, primary_output: null, outputs: {}, artifacts: [], errors: [] },
        },
        approvals: { current: null, history: [] },
        publish_config: { platforms: ['tiktok'], live_publish_platforms: [], video_render_platforms: ['tiktok'] },
        brand_kit: null,
        inputs: { request: {}, brand_url: 'https://brand.example' },
        errors: [],
        last_error: null,
        history: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, null, 2),
    );

    const response = await handleGetMarketingJobAsset(
      jobId,
      'video-launch-cut-poster',
      new Request('http://localhost/api/marketing/jobs/test/assets/video-launch-cut-poster'),
      async () => ({
        userId: 'user_123',
        tenantId: 'tenant_real',
        tenantSlug: 'acme',
        role: 'tenant_admin' as const,
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
});
