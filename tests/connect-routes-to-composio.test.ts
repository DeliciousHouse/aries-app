import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

/**
 * Adversarial regression suite for #704.
 *
 * Each of the four surfaces that previously linked FB/IG connect/reconnect to
 * the legacy /oauth/connect/* direct-Meta OAuth broker must now route to the
 * canonical Composio connect surface at /dashboard/settings/channel-integrations.
 *
 * Fail-before: before the fix, each surface contained a quoted '/oauth/connect/<platform>'
 * href or push target; after the fix, all four must reference the Composio surface and
 * no quoted functional reference to /oauth/connect/ may exist.
 *
 * Note: source comments may mention /oauth/connect/ as documentation; the negative
 * assertion is scoped to quoted string literals (the form that appears in code, not
 * prose), so documentation comments do not trip it.
 */

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

const COMPOSIO_SURFACE = '/dashboard/settings/channel-integrations';
// Quoted form only — prose comments use the bare path without surrounding quotes
// and should not be flagged.
const LEGACY_OAUTH_SQ = "'/oauth/connect/";
const LEGACY_OAUTH_DQ = '"/oauth/connect/';

function noLegacyOAuthRef(src: string): boolean {
  return !src.includes(LEGACY_OAUTH_SQ) && !src.includes(LEGACY_OAUTH_DQ);
}

// ─── Surface 1: Dashboard Home Presenter ─────────────────────────────────────

test('dashboard-home-presenter: connect/reconnect Link points to Composio surface, not legacy OAuth', () => {
  const src = readFileSync(
    path.join(PROJECT_ROOT, 'frontend', 'aries-v1', 'presenters', 'dashboard-home-presenter.tsx'),
    'utf8',
  );

  assert.ok(
    src.includes(`href="${COMPOSIO_SURFACE}"`),
    'dashboard-home-presenter must render a Link href to the Composio channel-integrations surface',
  );
  assert.ok(
    noLegacyOAuthRef(src),
    'dashboard-home-presenter must not contain a quoted /oauth/connect/ functional reference',
  );
});

// ─── Surface 2: Settings Screen ───────────────────────────────────────────────

test('settings-screen: handleIntegrationAction routes connect/reconnect to Composio surface, not legacy OAuth', () => {
  const src = readFileSync(
    path.join(PROJECT_ROOT, 'frontend', 'aries-v1', 'settings-screen.tsx'),
    'utf8',
  );

  assert.ok(
    src.includes(`'${COMPOSIO_SURFACE}'`) || src.includes(`"${COMPOSIO_SURFACE}"`),
    'settings-screen handleIntegrationAction must push to the Composio channel-integrations surface',
  );
  assert.ok(
    noLegacyOAuthRef(src),
    'settings-screen must not contain a quoted /oauth/connect/ functional reference',
  );
  // Structural check: the connect/reconnect branch pushes to Composio, not legacy.
  const handleFnStart = src.indexOf('handleIntegrationAction');
  assert.ok(handleFnStart >= 0, 'settings-screen must define handleIntegrationAction');
  // 800-char window covers the full function body (router.push is ~610 chars in).
  const fnBody = src.slice(handleFnStart, handleFnStart + 800);
  assert.ok(
    fnBody.includes(COMPOSIO_SURFACE),
    'handleIntegrationAction body must contain the Composio surface path',
  );
});

// ─── Surface 3: Onboarding ConnectPlatformsStep ───────────────────────────────

test('ConnectPlatformsStep: META_OAUTH_HREF constant is the Composio surface, not legacy OAuth', () => {
  const src = readFileSync(
    path.join(
      PROJECT_ROOT,
      'frontend',
      'onboarding',
      'pipeline-intake',
      'steps',
      'ConnectPlatformsStep.tsx',
    ),
    'utf8',
  );

  assert.ok(
    src.includes(`'${COMPOSIO_SURFACE}'`) || src.includes(`"${COMPOSIO_SURFACE}"`),
    'ConnectPlatformsStep META_OAUTH_HREF must be set to the Composio surface',
  );
  assert.ok(
    noLegacyOAuthRef(src),
    'ConnectPlatformsStep must not contain a quoted /oauth/connect/ functional reference',
  );
  // Confirm the constant declaration is the Composio surface.
  const metaHrefIdx = src.indexOf('META_OAUTH_HREF');
  assert.ok(metaHrefIdx >= 0, 'ConnectPlatformsStep must declare META_OAUTH_HREF');
  const constDecl = src.slice(metaHrefIdx, metaHrefIdx + 80);
  assert.ok(
    constDecl.includes(COMPOSIO_SURFACE),
    'META_OAUTH_HREF constant must be assigned the Composio surface path',
  );
});

// ─── Surface 4: Instagram Publish Drawer (reconnect link) ─────────────────────

test('instagram-publish-drawer: reconnect anchor href is Composio surface, not legacy OAuth', () => {
  const src = readFileSync(
    path.join(PROJECT_ROOT, 'frontend', 'aries-v1', 'instagram-publish-drawer.tsx'),
    'utf8',
  );

  assert.ok(
    src.includes(`"${COMPOSIO_SURFACE}"`) || src.includes(`'${COMPOSIO_SURFACE}'`),
    'instagram-publish-drawer reconnect anchor must href to the Composio channel-integrations surface',
  );
  assert.ok(
    noLegacyOAuthRef(src),
    'instagram-publish-drawer must not contain a quoted /oauth/connect/ functional reference',
  );
});
