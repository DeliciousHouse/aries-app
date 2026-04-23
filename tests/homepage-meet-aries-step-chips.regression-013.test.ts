import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

const source = readFileSync(
  path.join(PROJECT_ROOT, 'frontend', 'donor', 'marketing', 'home-page.tsx'),
  'utf8',
);

// ISSUE-HOMEPAGE-MEET-ARIES — the homepage "Meet Aries" step chips were styled
// like interactive controls (cursor-pointer + hover treatment) even though they
// were plain text with no href, button semantics, role, or tabindex. The fix
// keeps them decorative, removes the false click affordance, and exposes the
// sequence as a non-interactive list.
test('Meet Aries step chips are a semantic list without false interactive styling', () => {
  const meetAriesSection = source.match(/<section id="meet-aries"[\s\S]*?<\/section>/);
  assert.ok(meetAriesSection, 'expected to find the Meet Aries homepage section');

  const section = meetAriesSection![0];

  assert.match(
    section,
    /aria-label="Meet Aries workflow steps"[\s\S]*?role="list"/,
    'Meet Aries steps should be grouped as a semantic list',
  );

  assert.match(
    section,
    /role="listitem"/,
    'each workflow chip should render with non-interactive listitem semantics inside the mapped JSX',
  );

  for (const step of [
    'Set up your business',
    'See the plan',
    'Review the creative',
    'Launch safely',
    'See what delivered results',
  ]) {
    assert.match(section, new RegExp(step.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  assert.doesNotMatch(
    section,
    /cursor-pointer/,
    'decorative Meet Aries chips must not advertise pointer/click affordance',
  );
  assert.doesNotMatch(
    section,
    /hover-gradient-border/,
    'decorative Meet Aries chips must not keep hover-only interactive styling',
  );
  assert.match(
    section,
    /aria-hidden="true" className="hidden h-px w-full bg-white\/20 lg:block"/,
    'connector lines should stay presentational only',
  );
});
