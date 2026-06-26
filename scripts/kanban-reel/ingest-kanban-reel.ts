/**
 * Ingest a kanban-video-orchestrator–produced reel (output/final.mp4) into Aries
 * as a scheduled, publishable IG+FB Reel post.
 *
 * Runs INSIDE the aries-app container (needs the DB pool + the read-only
 * HERMES_VIDEO_CACHE_MOUNT). The host-side bridge copies the rendered mp4 into
 * the Hermes video cache and docker-execs this script.
 *
 * Reuses the exact Aries pipeline (no new publish path):
 *   ingestProductionCreativeAssetsToDb  → durable video creative_asset
 *   synthesizePublishPostsFromContentPackage → reel posts (content_package
 *     placement:reel fallback added in PR #733)
 *   upsertScheduledPost                 → scheduled_posts row → published by the
 *     scheduled-posts-worker via the Composio video branch.
 *
 * Usage (inside container): tsx ingest-kanban-reel.ts <cacheVideoBasename> <jobId> <tenantId> [scheduleInMinutes]
 */
import { existsSync, readFileSync } from 'node:fs';
import { pool } from '@/lib/db';
import { resolveDataPath } from '@/lib/runtime-paths';
import { ingestProductionCreativeAssetsToDb } from '@/backend/marketing/ingest-production-assets';
import { synthesizePublishPostsFromContentPackage } from '@/backend/marketing/synthesize-publish-posts';
import { upsertScheduledPost } from '@/backend/social-content/scheduled-posts';
import type { SocialContentJobRuntimeDocument } from '@/backend/marketing/runtime-state';

/** Load the tenant's validated brand kit so the marketing layer (when enabled)
 *  burns that tenant's OWN colors + logo onto the reel. Null when absent. */
function loadBrandKit(tenantId: number): Record<string, unknown> | null {
  try {
    const p = resolveDataPath('generated', 'validated', String(tenantId), 'brand-kit.json');
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    /* ignore — marketing layer falls back to defaults */
  }
  return null;
}

async function main() {
  const basename = process.argv[2];
  const jobId = process.argv[3] || `mkt_kanbanreel_${Date.now()}`;
  const tenantId = Number(process.argv[4] || '15');
  const scheduleInMinutes = Number(process.argv[5] || '6');
  if (!basename) throw new Error('usage: ingest-kanban-reel.ts <basename> <jobId> <tenantId> [minutes]');
  if (!Number.isFinite(tenantId) || tenantId <= 0) throw new Error('bad tenantId');

  // Dims/duration of the standard reel (the editor normalizes to 1080x1920/15s).
  const width = 1080, height = 1920, durationSeconds = 15;
  const brandKit = loadBrandKit(tenantId);

  const stub = (name: string, status: string, primary: unknown = null) => ({
    stage: name, status, started_at: null, completed_at: null, failed_at: null,
    run_id: null, summary: null, primary_output: primary, outputs: {}, artifacts: [], errors: [],
  });
  const doc = {
    schema_name: 'marketing_job_state_schema', schema_version: '1.0.0',
    job_id: jobId, tenant_id: String(tenantId), job_type: 'weekly_social_content',
    state: 'completed', status: 'completed', current_stage: 'publish',
    stages: {
      research: stub('research', 'completed'),
      strategy: stub('strategy', 'completed'),
      production: stub('production', 'completed', {
        stage: 'production',
        content_package: [
          { post_number: 1, theme: 'Aries reel', hook: 'Marketing on autopilot',
            body: 'Aries plans your week, drafts the creative, holds an approval queue, and publishes safely.',
            cta: 'See it at aries.sugarandleather.com',
            hashtags: ['#AriesAI', '#MarketingAutomation', '#SocialMedia'],
            platforms: ['instagram', 'facebook'], format: 'reel', placement: 'reel', media_type: 'video' },
        ],
        artifacts: {
          creative_assets: [
            { assetId: 'kanban_reel_1', type: 'generated_video', media_type: 'video', surface: 'reel',
              path: basename, width, height, duration_seconds: durationSeconds, mime: 'video/mp4',
              aspect_ratio: '9:16', placement: 1 },
          ],
          errors: [],
        },
      }),
      publish: stub('publish', 'completed', null),
    },
    approvals: { current: null, history: [] },
    publish_config: { platforms: ['instagram', 'facebook'], live_publish_platforms: ['instagram', 'facebook'], video_render_platforms: [] },
    brand_kit: brandKit,
    inputs: { brand_url: 'https://aries.sugarandleather.com', request: { videoRenderCount: 1, imageCreativeCount: 0, channels: ['instagram', 'facebook'] } },
    history: [], errors: [], last_error: null,
  } as unknown as SocialContentJobRuntimeDocument;

  const ing = await ingestProductionCreativeAssetsToDb({
    jobId,
    tenantId,
    doc,
    pool,
    // Per-tenant marketing layer (when ARIES_MARKETING_LAYER_ENABLED): colors +
    // logo from this tenant's brand kit, copy from the content_package above.
    brandKit: brandKit as never,
  });
  console.log('INGEST:', JSON.stringify(ing));
  if (ing.inserted < 1) throw new Error('video creative_asset not ingested (check HERMES_VIDEO_CACHE_MOUNT + basename)');

  const syn = await synthesizePublishPostsFromContentPackage({ jobId, tenantId, doc, publishRunId: null, pool });
  console.log('SYNTHESIZE:', JSON.stringify({ inserted: syn.inserted, skipped: syn.skipped, total: syn.total }));

  const posts = await pool.query(
    "SELECT id, platform, width_px, height_px, duration_seconds FROM posts WHERE job_id=$1 AND tenant_id=$2 AND surface='reel'",
    [jobId, tenantId],
  );
  if (posts.rowCount === 0) throw new Error('no reel posts synthesized (ARIES_VIDEO_PUBLISH_ENABLED must be on)');
  const when = new Date(Date.now() + scheduleInMinutes * 60 * 1000);
  for (const p of posts.rows) {
    await upsertScheduledPost(pool, {
      postId: p.id, tenantId, scheduledFor: when, platforms: [p.platform],
      surface: 'reel', mediaType: 'video',
      widthPx: p.width_px ?? width, heightPx: p.height_px ?? height, durationSeconds: p.duration_seconds ?? durationSeconds,
    });
    console.log('  scheduled reel post', p.id, p.platform, '->', when.toISOString());
  }
  console.log('DONE jobId=', jobId, 'tenant=', tenantId, 'reelPosts=', posts.rowCount);
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e?.stack || e); process.exit(1); });
