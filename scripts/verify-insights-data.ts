/**
 * Drives every insights handler against the seeded DB (tenant 1, week/all)
 * and prints the exact emptiness flag the rewritten frontend checks.
 * This exercises the real builders + SQL — not a mock.
 */
import type { TenantContextLoader } from '@/lib/tenant-context-http';

const loader: TenantContextLoader = async () =>
  ({ tenantId: '1', tenantSlug: 'insights-demo', role: 'tenant_admin' } as never);

const PERIOD = process.argv[2] || 'week';
function req(extra = '') {
  return new Request(`https://x.test/api/insights?period=${PERIOD}&platform=all${extra}`);
}

async function main() {
  const { handleGetInsightsNarrative }     = await import('@/backend/insights/narrative/handler');
  const { handleGetInsightsGoal }          = await import('@/backend/insights/goal/handler');
  const { handleGetInsightsAttention }     = await import('@/backend/insights/attention/handler');
  const { handleGetInsightsActivity }      = await import('@/backend/insights/activity/handler');
  const { handleGetInsightsTrends }        = await import('@/backend/insights/trends/handler');
  const { handleGetInsightsTop }           = await import('@/backend/insights/top/handler');
  const { handleGetInsightsConversations } = await import('@/backend/insights/conversations/handler');
  const { handleGetInsightsAries }         = await import('@/backend/insights/aries/handler');
  const { handleGetInsightsAudience }      = await import('@/backend/insights/audience/handler');

  const checks: Array<[string, () => Promise<Response>, (b: any) => string]> = [
    ['narrative',     () => handleGetInsightsNarrative(req(), loader),     b => `status=${b.status} snapshot.hasData=${b.snapshot?.hasData} score=${b.score}`],
    ['goal',          () => handleGetInsightsGoal(req(), loader),          b => `status=${b.status} hasData=${b.hasData} goal=${b.goal} metric=${b.metricValue} ${b.metricLabel}`],
    ['attention',     () => handleGetInsightsAttention(req(), loader),     b => `cards=${b.cards?.length} allCaughtUp=${b.allCaughtUp} unreplied=${b.meta?.unreplied}`],
    ['activity',      () => handleGetInsightsActivity(req(), loader),      b => `meta.hasData=${b.meta?.hasData} postsPublished=${b.strip?.postsPublished} contentMix=${b.contentMix?.length}`],
    ['trends',        () => handleGetInsightsTrends(req(), loader),        b => `meta.hasData=${b.meta?.hasData} reach.headline=${b.metrics?.reach?.headline} reachSeriesSum=${(b.series?.reach?.current||[]).reduce((a:number,c:number)=>a+c,0)} followers.headline=${b.metrics?.followers?.headline}`],
    ['top',           () => handleGetInsightsTop(req(), loader),           b => `meta.hasData=${b.meta?.hasData} posts=${b.posts?.length} pattern="${b.pattern?.title}"`],
    ['conversations', () => handleGetInsightsConversations(req(), loader), b => `conversations=${b.conversations?.length} needsReply=${b.meta?.needsReply} leadQuality=${b.leadQuality?.length}`],
    ['aries',         () => handleGetInsightsAries(req(), loader),         b => `approvalFlow.drafts=${b.approvalFlow?.drafts} curve=${b.learningCurve?.labels?.length}`],
    ['audience',      () => handleGetInsightsAudience(req(), loader),      b => `schedule=${b.schedule?.length} demo.hasData=${b.demographics?.hasData} active.hasData=${b.activeTimes?.hasData}`],
  ];

  for (const [name, fn, fmt] of checks) {
    try {
      const res = await fn();
      const body = await res.json();
      console.log(`${String(name).padEnd(14)} HTTP ${res.status}  ${fmt(body)}`);
    } catch (e) {
      console.log(`${String(name).padEnd(14)} ERROR  ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  process.exit(0);
}

main();
