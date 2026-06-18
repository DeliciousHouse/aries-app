import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';
import { APP_ROUTES, getRouteById } from '../frontend/app-shell/routes';

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
