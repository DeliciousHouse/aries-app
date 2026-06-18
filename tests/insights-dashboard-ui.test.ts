import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';
import { APP_ROUTES, getRouteById } from '../frontend/app-shell/routes';
import { platformSupports } from '../backend/insights/platforms/capabilities';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

function read(...segments: string[]): string {
  return readFileSync(path.join(PROJECT_ROOT, ...segments), 'utf8');
}

const analyticsPage = read('app', 'dashboard', 'analytics', 'page.tsx');
const commentsPage = read('app', 'dashboard', 'comments', 'page.tsx');
const analyticsScreen = read('frontend', 'aries-v1', 'analytics-screen.tsx');
const commentsScreen = read('frontend', 'aries-v1', 'comments-screen.tsx');
const analyticsHook = read('hooks', 'use-insights-analytics.ts');
const commentsHook = read('hooks', 'use-insights-comments.ts');
const apiClient = read('lib', 'api', 'aries-v1.ts');
const appShellClient = read('components', 'redesign', 'layout', 'app-shell-client.tsx');
const readApi = read('backend', 'insights', 'read-api.ts');

test('analytics + comments nav routes are registered as reachable utility entries', () => {
  const analytics = getRouteById('analytics');
  const comments = getRouteById('comments');

  assert.equal(analytics.href, '/dashboard/analytics');
  assert.equal(analytics.section, 'utility');
  assert.equal(comments.href, '/dashboard/comments');
  assert.equal(comments.section, 'utility');

  // Both must actually be in the exported route table (not just resolvable).
  assert.ok(APP_ROUTES.some((r) => r.id === 'analytics' && r.href === '/dashboard/analytics'));
  assert.ok(APP_ROUTES.some((r) => r.id === 'comments' && r.href === '/dashboard/comments'));
});

test('app shell wires the new routes into icons and the utility nav list', () => {
  // Icon map is a Record<AppRouteId, ...>; missing keys would not even compile,
  // but assert the entries exist so the nav renders a glyph for each.
  assert.match(appShellClient, /analytics:\s*TrendingUp/);
  assert.match(appShellClient, /comments:\s*MessageCircle/);
  // Sidebar utility list must include both so they are clickable from the shell.
  assert.match(appShellClient, /routeId:\s*'analytics'/);
  assert.match(appShellClient, /routeId:\s*'comments'/);
});

test('analytics page renders the analytics screen inside the app shell', () => {
  assert.match(analyticsPage, /import AppShellLayout from '@\/frontend\/app-shell\/layout'/);
  assert.match(analyticsPage, /import AriesAnalyticsScreen from '@\/frontend\/aries-v1\/analytics-screen'/);
  assert.match(analyticsPage, /currentRouteId="analytics"/);
  // enabledPlatforms is passed as a prop (not hard-pinned).
  assert.match(analyticsPage, /<AriesAnalyticsScreen enabledPlatforms=\{enabledPlatforms\} \/>/);
  // Facebook is always the first entry — dormancy default preserved.
  assert.match(analyticsPage, /const enabledPlatforms/);
  assert.match(analyticsPage, /'facebook'/);
});

test('comments page renders the comments screen inside the app shell', () => {
  assert.match(commentsPage, /import AppShellLayout from '@\/frontend\/app-shell\/layout'/);
  assert.match(commentsPage, /import AriesCommentsScreen from '@\/frontend\/aries-v1\/comments-screen'/);
  assert.match(commentsPage, /currentRouteId="comments"/);
  // enabledPlatforms is passed as a prop (not hard-pinned).
  assert.match(commentsPage, /<AriesCommentsScreen enabledPlatforms=\{enabledPlatforms\} \/>/);
  // Facebook is always the first entry — dormancy default preserved.
  assert.match(commentsPage, /const enabledPlatforms/);
  assert.match(commentsPage, /'facebook'/);
});

test('api client targets the real /api/insights/* endpoints (Facebook scoped by the screens)', () => {
  assert.match(apiClient, /'\/api\/insights\/summary'/);
  assert.match(apiClient, /'\/api\/insights\/account-metrics'/);
  assert.match(apiClient, /'\/api\/insights\/posts'/);
  assert.match(apiClient, /'\/api\/insights\/comments'/);
  assert.match(apiClient, /\/api\/insights\/comments\/\$\{encodeURIComponent\(String\(commentId\)\)\}\/reply/);
});

test('analytics screen consumes the analytics hook, charts the series, and keeps the empty state', () => {
  assert.match(analyticsScreen, /useInsightsAnalytics/);
  // Platform state defaults to 'facebook' — dormancy: flags-off renders FB-only, no selector.
  assert.match(analyticsScreen, /useState<Platform>\('facebook'\)/);
  // The hook receives the platform STATE variable, not a hard-coded literal.
  assert.match(analyticsScreen, /useInsightsAnalytics\(\{ autoLoad: true, platform \}\)/);
  // Prop default of ['facebook'] preserves the single-platform dormant state.
  assert.match(analyticsScreen, /enabledPlatforms\s*=\s*\['facebook'\]/);
  // Selector is only rendered when more than one platform is enabled.
  assert.match(analyticsScreen, /enabledPlatforms\.length > 1/);
  // Headline tiles for the real summary fields.
  assert.match(analyticsScreen, /summary\.totalViews/);
  assert.match(analyticsScreen, /summary\.currentFollowers/);
  assert.match(analyticsScreen, /summary\.totalEngagement/);
  assert.match(analyticsScreen, /summary\.totalLikes/);
  assert.match(analyticsScreen, /summary\.totalComments/);
  assert.match(analyticsScreen, /summary\.totalShares/);
  // Trend chart over the account-metrics series + per-post table.
  assert.match(analyticsScreen, /LineChart/);
  assert.match(analyticsScreen, /post\.metrics\.totalViews/);
  // Empty state preserved for the zero/empty payload.
  assert.match(analyticsScreen, /EmptyStatePanel/);
  assert.match(analyticsScreen, /No analytics yet/);
});

test('analytics hook reads summary, account-metrics, and posts and defaults to Facebook', () => {
  assert.match(analyticsHook, /getInsightsSummary/);
  assert.match(analyticsHook, /getInsightsAccountMetrics/);
  assert.match(analyticsHook, /getInsightsPosts/);
  assert.match(analyticsHook, /options\.platform\s*\?\?\s*'facebook'/);
});

test('comments screen groups by post, shows replied state, and surfaces a reply box', () => {
  assert.match(commentsScreen, /useInsightsComments/);
  // Platform state defaults to 'facebook' — dormancy: flags-off renders FB-only, no selector.
  assert.match(commentsScreen, /useState<Platform>\('facebook'\)/);
  // The hook receives the platform STATE variable, not a hard-coded literal.
  assert.match(commentsScreen, /platform,/);
  // Prop default of ['facebook'] preserves the single-platform dormant state.
  assert.match(commentsScreen, /enabledPlatforms\s*=\s*\['facebook'\]/);
  // Selector is only rendered when more than one platform is enabled.
  assert.match(commentsScreen, /enabledPlatforms\.length > 1/);
  // LinkedIn short-circuit: no autoLoad for LinkedIn (no Composio list-comments action).
  assert.match(commentsScreen, /autoLoad: platform !== 'linkedin'/);
  // LinkedIn renders an honest unavailable EmptyStatePanel rather than an error.
  assert.match(commentsScreen, /platform === 'linkedin'[\s\S]*?EmptyStatePanel/);
  assert.match(commentsScreen, /groupByPost/);
  assert.match(commentsScreen, /comment\.authorHandle/);
  assert.match(commentsScreen, /comment\.bodyText/);
  assert.match(commentsScreen, /comment\.receivedAt/);
  assert.match(commentsScreen, /Replied/);
  assert.match(commentsScreen, /<textarea/);
  assert.match(commentsScreen, /handleReply/);
  // Empty state preserved.
  assert.match(commentsScreen, /No comments yet/);
});

test('reply path is treated as flag-gated: a 404 maps to a subtle not-enabled state, not an error', () => {
  // Hook maps the flag-off 404 to a not_enabled outcome.
  assert.match(commentsHook, /replyToInsightComment/);
  assert.match(commentsHook, /error\.status === 404/);
  assert.match(commentsHook, /not_enabled/);
  // Screen renders the subtle not-enabled copy instead of erroring.
  assert.match(commentsScreen, /not_enabled/);
  assert.match(commentsScreen, /enabled for your account yet/);
});

test('comments read-api exposes replied state so the inbox can render it', () => {
  assert.match(readApi, /c\.is_replied/);
  assert.match(readApi, /c\.replied_at/);
  assert.match(readApi, /isReplied:/);
  assert.match(readApi, /repliedAt:/);
});

// ─── #684 honest analytics "metric unavailable" states ───────────────────────

test('analytics screen imports platformSupports and derives accountMetricsSupported + postViewsSupported (#684)', () => {
  // Import of platformSupports from the capabilities module must be present.
  assert.match(analyticsScreen, /import.*platformSupports.*from.*capabilities/);
  // accountMetricsSupported is derived by calling platformSupports for 'account_daily_metrics'.
  assert.match(analyticsScreen, /platformSupports\(platform,\s*'account_daily_metrics'\)/);
  // postViewsSupported is derived by calling platformSupports for 'post_view_count'.
  assert.match(analyticsScreen, /platformSupports\(platform,\s*'post_view_count'\)/);
  // Both derived booleans are referenced in the template (not dead code).
  assert.match(analyticsScreen, /accountMetricsSupported/);
  assert.match(analyticsScreen, /postViewsSupported/);
});

test('analytics screen renders honest EmptyStatePanel with per-platform reasons when account metrics unsupported (#684)', () => {
  // The !accountMetricsSupported branch must drive an EmptyStatePanel — not fabricated zeros.
  assert.match(analyticsScreen, /!accountMetricsSupported[\s\S]*?EmptyStatePanel/);
  // The per-platform reason lookup map must be declared.
  assert.match(analyticsScreen, /ACCOUNT_METRICS_UNAVAILABLE_REASON/);
  // X: honest "paid tier" reason.
  assert.match(analyticsScreen, /paid X API tier/);
  // Reddit: honest "doesn't expose" reason.
  assert.match(analyticsScreen, /Reddit.*expose/);
  // LinkedIn: honest "organization" scope reason.
  assert.match(analyticsScreen, /LinkedIn organization/);
});

test('analytics screen gates the Views <th> and <td> on post_view_count capability (#684)', () => {
  // Header cell for Views is wrapped in a postViewsSupported conditional.
  assert.match(analyticsScreen, /postViewsSupported && <th[^>]*>Views<\/th>/);
  // Data cell rendering totalViews is also wrapped in a postViewsSupported conditional.
  assert.match(analyticsScreen, /postViewsSupported[\s\S]{0,300}totalViews/);
});

// ─── #688 honest LinkedIn comments subtitle (no reply contradiction) ─────────

test('comments screen has honest LinkedIn subtitle that does not promise Aries reply (#688)', () => {
  // POSITIVE: The LinkedIn-specific subtitle text must exist in the source.
  assert.match(commentsScreen, /LinkedIn comment retrieval isn/);
  assert.match(commentsScreen, /LinkedIn directly to read and respond to comments/);
  // STRUCTURAL: The linkedin subtitle branch is interposed between the facebook branch and the
  // generic else subtitle — verifying the 3-way conditional (facebook → linkedin → generic).
  assert.match(
    commentsScreen,
    /platform === 'facebook'[\s\S]{0,1000}platform === 'linkedin'[\s\S]{0,500}LinkedIn comment retrieval isn/,
  );
  // NEGATIVE: The LinkedIn subtitle must NOT promise "Reply directly from Aries" within
  // its own branch (the pre-fix contradiction with the EmptyStatePanel below).
  // From "LinkedIn comment retrieval" to the generic-else "Reply directly from Aries" is
  // ~320 chars; the 100-char window stays inside the LinkedIn subtitle itself.
  assert.doesNotMatch(commentsScreen, /LinkedIn comment retrieval[\s\S]{0,100}Reply directly from Aries/);
  // GOLDEN (#648): The honest EmptyStatePanel for LinkedIn is still rendered beneath.
  assert.match(commentsScreen, /platform === 'linkedin'[\s\S]*?EmptyStatePanel/);
  assert.match(commentsScreen, /Comments aren.*t available for LinkedIn/);
  // GOLDEN: The Facebook subtitle (which does promise Aries reply) is unchanged.
  assert.match(commentsScreen, /Comments on your Facebook posts[\s\S]{0,200}Reply directly from\s+Aries/);
});

// ─── #687 honest per-post Comments/Shares column gating ─────────────────────

test('analytics screen derives commentsSupported and postSharesSupported from capabilities (#687)', () => {
  // Both capability checks must appear in the source — they drive the column gates below.
  assert.match(analyticsScreen, /platformSupports\(platform,\s*'comments'\)/);
  assert.match(analyticsScreen, /platformSupports\(platform,\s*'post_share_count'\)/);
  // Both derived booleans must be referenced in the template (not dead code).
  assert.match(analyticsScreen, /commentsSupported/);
  assert.match(analyticsScreen, /postSharesSupported/);
});

test('analytics screen gates Comments <th>/<td> on commentsSupported and Shares <th>/<td> on postSharesSupported (#687)', () => {
  // Comments header cell is wrapped in a commentsSupported conditional — mirroring #684 Views gate.
  assert.match(analyticsScreen, /commentsSupported && <th[^>]*>Comments<\/th>/);
  // Shares header cell is wrapped in a postSharesSupported conditional.
  assert.match(analyticsScreen, /postSharesSupported && <th[^>]*>Shares<\/th>/);
  // Comments data cell is also gated (commentsSupported precedes totalComments in the template).
  assert.match(analyticsScreen, /commentsSupported[\s\S]{0,300}totalComments/);
  // Shares data cell is also gated (postSharesSupported precedes totalShares in the template).
  assert.match(analyticsScreen, /postSharesSupported[\s\S]{0,300}totalShares/);
});

test('analytics screen Likes column is unconditional — not gated on any capability (#687)', () => {
  // The Likes <th> is present and unconditional.
  assert.match(analyticsScreen, /<th[^>]*>Likes<\/th>/);
  // It must NOT be preceded by any Supported guard on the same JSX expression.
  assert.doesNotMatch(analyticsScreen, /\w+Supported\s*&&\s*<th[^>]*>Likes<\/th>/);
  // totalLikes is referenced (the <td> always renders).
  assert.match(analyticsScreen, /totalLikes/);
  // The Likes <td> is not gated — no Supported gate immediately before the td bearing totalLikes.
  assert.doesNotMatch(analyticsScreen, /\w+Supported\s*&&\s*<td[\s\S]{0,80}totalLikes/);
});

test('capabilities.ts: post_share_count TRUE for facebook/instagram/x, FALSE for reddit/youtube/linkedin; comments FALSE for linkedin only (#687)', () => {
  // Platforms that expose a real per-post share count.
  assert.equal(platformSupports('facebook', 'post_share_count'), true, 'facebook should support post_share_count');
  assert.equal(platformSupports('instagram', 'post_share_count'), true, 'instagram should support post_share_count');
  assert.equal(platformSupports('x', 'post_share_count'), true, 'x should support post_share_count');
  // Platforms that do NOT expose a per-post share count (no fabricated zeros).
  assert.equal(platformSupports('reddit', 'post_share_count'), false, 'reddit must NOT support post_share_count');
  assert.equal(platformSupports('youtube', 'post_share_count'), false, 'youtube must NOT support post_share_count');
  assert.equal(platformSupports('linkedin', 'post_share_count'), false, 'linkedin must NOT support post_share_count');
  // Existing #648 invariant: comments present for all except linkedin.
  assert.equal(platformSupports('facebook', 'comments'), true, 'facebook should support comments');
  assert.equal(platformSupports('instagram', 'comments'), true, 'instagram should support comments');
  assert.equal(platformSupports('x', 'comments'), true, 'x should support comments');
  assert.equal(platformSupports('reddit', 'comments'), true, 'reddit should support comments');
  assert.equal(platformSupports('youtube', 'comments'), true, 'youtube should support comments');
  assert.equal(platformSupports('linkedin', 'comments'), false, 'linkedin must NOT support comments');
});

test('golden: facebook and instagram still render both Comments and Shares columns after #687 (byte-identical)', () => {
  // FB and IG both have 'comments' AND 'post_share_count' — so commentsSupported and
  // postSharesSupported are true for those platforms and neither column is hidden.
  assert.equal(platformSupports('facebook', 'comments'), true, 'facebook: comments must still be supported');
  assert.equal(platformSupports('facebook', 'post_share_count'), true, 'facebook: post_share_count must still be supported');
  assert.equal(platformSupports('instagram', 'comments'), true, 'instagram: comments must still be supported');
  assert.equal(platformSupports('instagram', 'post_share_count'), true, 'instagram: post_share_count must still be supported');
  // The conditional expressions that produce the th and td cells are present in the template —
  // when both booleans are true (FB/IG) those cells are rendered, so the live render is unchanged.
  assert.match(analyticsScreen, /commentsSupported && <th[^>]*>Comments<\/th>/);
  assert.match(analyticsScreen, /postSharesSupported && <th[^>]*>Shares<\/th>/);
  assert.match(analyticsScreen, /commentsSupported[\s\S]{0,300}totalComments/);
  assert.match(analyticsScreen, /postSharesSupported[\s\S]{0,300}totalShares/);
});

test('capabilities.ts: post_view_count present for youtube/instagram/facebook, absent for x/reddit/linkedin (#684)', () => {
  // Platforms that expose per-post view/impression counts.
  assert.equal(platformSupports('youtube', 'post_view_count'), true, 'youtube should support post_view_count');
  assert.equal(platformSupports('instagram', 'post_view_count'), true, 'instagram should support post_view_count');
  assert.equal(platformSupports('facebook', 'post_view_count'), true, 'facebook should support post_view_count');
  // Platforms that do NOT expose per-post view counts (no fabricated zeros).
  assert.equal(platformSupports('x', 'post_view_count'), false, 'x must NOT support post_view_count');
  assert.equal(platformSupports('reddit', 'post_view_count'), false, 'reddit must NOT support post_view_count');
  assert.equal(platformSupports('linkedin', 'post_view_count'), false, 'linkedin must NOT support post_view_count');
  // Existing invariant: account_daily_metrics absent for x/reddit/linkedin/youtube.
  assert.equal(platformSupports('x', 'account_daily_metrics'), false, 'x must NOT support account_daily_metrics');
  assert.equal(platformSupports('reddit', 'account_daily_metrics'), false, 'reddit must NOT support account_daily_metrics');
  assert.equal(platformSupports('linkedin', 'account_daily_metrics'), false, 'linkedin must NOT support account_daily_metrics');
  assert.equal(platformSupports('youtube', 'account_daily_metrics'), false, 'youtube must NOT support account_daily_metrics');
});
