import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { isValidElement, type ReactElement } from 'react';

import { resolveProjectRoot } from './helpers/project-root';
import { APP_ROUTES, getRouteById } from '../frontend/app-shell/routes';
import { platformSupports } from '../backend/insights/platforms/capabilities';
import { attributionScopeLabel } from '../frontend/insights/tokens';
import { AnalyticsDrilldownLink } from '../frontend/insights/AnalyticsDrilldownLink';
import type { Period, Platform } from '../frontend/insights/types';

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
const insightsActivitySection = read('frontend', 'insights', 'ActivitySection.tsx');
const insightsTopPostsSection = read('frontend', 'insights', 'TopPostsSection.tsx');
// AA-229 PR1: /dashboard/analytics demoted from top-level nav to the
// per-platform drill-down reached from /insights.
const insightsDashboard = read('frontend', 'insights', 'InsightsDashboard.tsx');
const analyticsDrilldownLink = read('frontend', 'insights', 'AnalyticsDrilldownLink.tsx');

test('analytics + comments routes are registered and resolvable (AA-229 PR1: analytics is retained, not retired)', () => {
  // getRouteById('analytics') must keep resolving — app/dashboard/analytics/page.tsx
  // still calls AppShellLayout currentRouteId="analytics", which throws on an
  // unknown id. Only its top-level NAV ENTRY is removed (see the next test);
  // the route registration itself is untouched.
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

test('AA-229 PR1: app shell keeps the analytics icon wired but drops it from the top-level nav', () => {
  // Icon map is a Record<AppRouteId, ...>; 'analytics' remains a required key
  // (removing it would not even compile) even though it is no longer a nav
  // link — TypeScript enforces this, but assert it explicitly here too.
  assert.match(appShellClient, /analytics:\s*TrendingUp/);
  assert.match(appShellClient, /comments:\s*MessageCircle/);
  // The sidebar utility list no longer links directly to analytics — it is
  // reached only via the /insights per-platform drill-down now.
  assert.doesNotMatch(appShellClient, /\{ type: 'link', routeId: 'analytics' \}/);
  // insights and comments remain real top-level nav links.
  assert.match(appShellClient, /\{ type: 'link', routeId: 'insights' \}/);
  assert.match(appShellClient, /\{ type: 'link', routeId: 'comments' \}/);
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
  // AA-229 PR1: platform state now seeds from the /insights drill-down's
  // `platform` query param via resolveInitialPlatform, falling back to
  // enabledPlatforms[0] ?? 'facebook' — dormancy preserved (flags-off + no
  // query param still resolves to Facebook-only, no selector), just resolved
  // dynamically instead of hard-pinned.
  assert.match(analyticsScreen, /useState<Platform>\(\(\) =>/);
  assert.match(analyticsScreen, /resolveInitialPlatform\(searchParams\.get\('platform'\), enabledPlatforms\)/);
  assert.match(analyticsScreen, /enabledPlatforms\[0\] \?\? 'facebook'/);
  // AA-229 F4: `days` seeds from the same drill-down's `days` query param
  // (resolveDaysParam), clamped 1..90 to mirror the read-api handlers, and —
  // like `platform` — captured ONCE via a useState initializer rather than
  // recomputed every render, so the two halves of "the window" can never
  // drift apart from each other.
  assert.match(analyticsScreen, /const \[days\] = useState<number \| undefined>\(\(\) =>/);
  assert.match(analyticsScreen, /resolveDaysParam\(searchParams\.get\('days'\)\)/);
  // AA-229 F5: strict digits-only validation (parsePoolMax convention) — a
  // bare Number.parseInt would truncate '1e3' to 1 and '30abc' to 30 instead
  // of rejecting them.
  assert.match(analyticsScreen, /!\/\^\\d\+\$\/\.test\(paramValue\)/);
  // The hook receives the platform + days STATE, not hard-coded literals.
  assert.match(analyticsScreen, /useInsightsAnalytics\(\{ autoLoad: true, platform, days \}\)/);
  // Prop default of ['facebook'] preserves the single-platform dormant state.
  assert.match(analyticsScreen, /enabledPlatforms\s*=\s*\['facebook'\]/);
  // Selector is only rendered when more than one platform is enabled.
  assert.match(analyticsScreen, /enabledPlatforms\.length > 1/);
  // Headline tiles for the real summary fields.
  assert.match(analyticsScreen, /summary\.totalReach/);
  assert.match(analyticsScreen, /summary\.currentFollowers/);
  assert.match(analyticsScreen, /summary\.totalEngagement/);
  assert.match(analyticsScreen, /summary\.totalLikes/);
  assert.match(analyticsScreen, /summary\.totalComments/);
  assert.match(analyticsScreen, /summary\.totalShares/);
  // Trend chart over the account-metrics series + per-post table.
  assert.match(analyticsScreen, /LineChart/);
  assert.match(analyticsScreen, /post\.metrics\.totalReach/);
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

test('insights sections never hardcode their scope label — no Aries-published misattribution (#785, S4-1)', () => {
  // #785: these sections read ALL channel posts, so claiming "Aries-published"
  // misattributes other people's work. S4-1 makes the scope conditional rather
  // than fixed, so the guard moves from "the words never appear" to "the words
  // are derived from the scope the backend actually applied". A hardcoded label
  // in either section would reintroduce the same lie for every tenant below the
  // attribution-coverage threshold.
  assert.match(insightsActivitySection, /No posts published on your channels in this period\./);
  assert.match(insightsTopPostsSection, /Top performing content/);
  assert.match(insightsTopPostsSection, /No published posts in this period\./);

  // Both sections take their label from the shared helper, keyed on the scope
  // the response reported — never from a literal in the JSX.
  for (const [name, source] of [
    ['ActivitySection', insightsActivitySection],
    ['TopPostsSection', insightsTopPostsSection],
  ] as const) {
    assert.match(source, /attributionScopeLabel\(/, `${name} must derive its scope label`);
    assert.match(
      source,
      /attributionScopeLabel\(\s*data\?\.meta\?\.attribution\?\.scope\s*\)/,
      `${name} must key the label on the reported attribution scope`,
    );
    // Comments may discuss the label; only rendered code may not contain it.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')   // block + JSX comments
      .replace(/^\s*\/\/.*$/gm, '');      // line comments
    assert.doesNotMatch(
      code,
      /Aries-published/,
      `${name} must not hardcode an Aries-published label`,
    );
  }

  // The helper is the single place the mapping lives, and its fallback for an
  // absent scope (a cached pre-split body) is all-channel, not Aries.
  assert.equal(attributionScopeLabel('aries'), 'Aries-published posts');
  assert.equal(attributionScopeLabel('all-channel'), 'all channel activity');
  assert.equal(attributionScopeLabel(undefined), 'all channel activity');
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
  // Data cell rendering the metric is also wrapped in a postViewsSupported conditional.
  // AA-230 renamed the FIELD to totalReach (the value is now COALESCE(reach, views, 0),
  // matching the other ten readers) but deliberately kept the LABEL as "Views".
  assert.match(analyticsScreen, /postViewsSupported[\s\S]{0,300}totalReach/);
});

test('AA-230: analytics screen labels the reach-preferred metric "Views", not "Reach"', () => {
  // Regression guard for the review finding on AA-230. Instagram is the only
  // adapter that populates insights_account_metrics_daily.reach, and
  // app/dashboard/analytics/page.tsx builds enabledPlatforms WITHOUT instagram —
  // so for every platform this screen can render, COALESCE(reach, views, 0)
  // resolves to views. Labelling it "Reach" would replace a correct label with a
  // false one. Relabel only when Instagram becomes selectable here (AA-229).
  assert.doesNotMatch(
    analyticsScreen,
    /label="Reach"|>Reach<\/th>|name="Reach"/,
    'user-facing "Reach" label on a Facebook-only screen whose value is views',
  );
  assert.match(analyticsScreen, /<MetricCard label="Views" value=\{formatNumber\(summary\.totalReach\)\}/);
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

// ─── AA-229 PR1: /insights → /dashboard/analytics drill-down ─────────────────

test('InsightsDashboard renders the analytics drill-down on the same control row as export/freshness', () => {
  assert.match(insightsDashboard, /import \{ AnalyticsDrilldownLink \} from "@\/frontend\/insights\/AnalyticsDrilldownLink"/);
  // It receives the SAME live period + platform state as everything else on
  // the page — this is the load-bearing bit: the child must inherit the
  // parent's window, not silently reset to its own defaults.
  assert.match(insightsDashboard, /<AnalyticsDrilldownLink period=\{period\} platform=\{platform\} \/>/);
});

// AnalyticsDrilldownLink has no hooks — calling it directly as a plain
// function returns the same top-level React element a renderer would
// produce, with no router/context needed (mirrors the pattern
// tests/public-marketing-pages.test.ts uses for full page components).
function drilldownLinkElement(period: Period, platform: Platform): ReactElement {
  const el = AnalyticsDrilldownLink({ period, platform });
  assert.equal(isValidElement(el), true, 'AnalyticsDrilldownLink must always return a real element, never null (AA-229 F1)');
  return el as ReactElement;
}

function drilldownLinkHref(period: Period, platform: Platform): string {
  return (drilldownLinkElement(period, platform).props as { href: string }).href;
}

function drilldownLinkLabel(period: Period, platform: Platform): string {
  const children = (drilldownLinkElement(period, platform).props as { children: unknown }).children;
  return (Array.isArray(children) ? children : [children]).join('');
}

test('AA-229 F1: AnalyticsDrilldownLink ALWAYS renders — the /insights default state (platform="all") is not a dead link', () => {
  // InsightsDashboard.tsx seeds platform to "all" — this is the exact state
  // every first load of /insights starts in, and the state the link is
  // permanently stuck in when COMPOSIO_ENABLED=false (the compose/CI/local
  // default) empties every platform chip except "all". An early-return-null
  // here would make this component — the ONLY reference to
  // /dashboard/analytics outside its own page and the docs — unreachable in
  // both cases. This is the case that would have caught the regression.
  const href = drilldownLinkHref('90day', 'all');
  assert.equal(href, '/dashboard/analytics?days=90');
  assert.doesNotMatch(href, /platform=/);
  assert.match(drilldownLinkLabel('90day', 'all'), /Per-platform analytics/);
});

test('AA-229 F1/F3: an unselectable platform (Instagram) also always renders, with the param omitted — never a silent Facebook swap', () => {
  // Instagram is deliberately absent from app/dashboard/analytics/page.tsx's
  // enabledPlatforms, so it must never ride as a `platform` query param —
  // but the link itself must still render, and land the visitor on a screen
  // that picks its OWN default (resolveInitialPlatform), not one that looks
  // like it silently swapped the user's channel to Facebook.
  const href = drilldownLinkHref('week', 'instagram');
  assert.equal(href, '/dashboard/analytics?days=7');
  assert.doesNotMatch(href, /platform=/);
  assert.match(drilldownLinkLabel('week', 'instagram'), /Per-platform analytics/);
});

test('AnalyticsDrilldownLink carries the platform param for every platform the analytics screen can select', () => {
  const cases: Array<[Platform, string]> = [
    ['facebook', 'Facebook'],
    ['x', 'X'],
    ['youtube', 'YouTube'],
    ['reddit', 'Reddit'],
    ['linkedin', 'LinkedIn'],
  ];
  for (const [platform, label] of cases) {
    const href = drilldownLinkHref('30day', platform);
    assert.equal(href, `/dashboard/analytics?days=30&platform=${platform}`);
    assert.match(drilldownLinkLabel('30day', platform), new RegExp(`^${label} analytics`));
  }
});

test('AnalyticsDrilldownLink carries the live period as `days` (week=7, 30day=30, 90day=90) — same vocabulary as ExportMenu.tsx', () => {
  assert.equal(drilldownLinkHref('week', 'facebook'), '/dashboard/analytics?days=7&platform=facebook');
  assert.equal(drilldownLinkHref('30day', 'facebook'), '/dashboard/analytics?days=30&platform=facebook');
  assert.equal(drilldownLinkHref('90day', 'facebook'), '/dashboard/analytics?days=90&platform=facebook');
});

test('AA-229 F6: AnalyticsDrilldownLink uses next/link, not a raw <a> (avoids re-paying the shell auth round trip)', () => {
  assert.match(analyticsDrilldownLink, /^import Link from "next\/link";$/m);
  assert.doesNotMatch(analyticsDrilldownLink, /<a\s/);
});

test('AA-229 F2: DRILLDOWN_PLATFORMS and app/dashboard/analytics/page.tsx enabledPlatforms cross-reference each other in comments', () => {
  // Not compile-time linked (different flag families resolve each list — see
  // the comments themselves) so a human has to keep them in sync; pin that
  // each file at least points at the other.
  assert.match(analyticsDrilldownLink, /DRILLDOWN_PLATFORMS = new Set<Platform>\(\["facebook", "x", "youtube", "reddit", "linkedin"\]\)/);
  assert.match(analyticsDrilldownLink, /app\/dashboard\/analytics\/page\.tsx's enabledPlatforms/);
  // Substring, not a line-wrap-sensitive pattern: the intent is "this file
  // points at the other one", which a reflow of the comment must not break.
  assert.match(analyticsPage, /DRILLDOWN_PLATFORMS/);
  assert.match(analyticsPage, /AnalyticsDrilldownLink\.tsx/);
});

test('AA-229 PR1: analytics screen reads platform + days from the URL query via next/navigation', () => {
  assert.match(analyticsScreen, /import \{ useSearchParams \} from 'next\/navigation'/);
  assert.match(analyticsScreen, /const searchParams = useSearchParams\(\);/);
});

test('AA-229 PR1: hooks/use-insights-analytics.ts already threads `days` into summary + account-metrics (no change needed there)', () => {
  // Pins that the read path analytics-screen.tsx now relies on was already
  // wired end-to-end before this ticket — only the screen's call site needed
  // to start passing a real `days` value.
  assert.match(analyticsHook, /getInsightsSummary\(\{ platform, days \}\)/);
  assert.match(analyticsHook, /getInsightsAccountMetrics\(\{ platform, days \}\)/);
});
