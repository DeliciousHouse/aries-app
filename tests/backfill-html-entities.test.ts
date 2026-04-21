// tests/backfill-html-entities.test.ts
//
// ISSUE-W2-M1 — Verifies the backfill decoder handles every artifact variant
// observed in legacy campaign workspace data, including the space-not-hash
// `& x27;` edge case (where an earlier sanitizer stripped the `#` from
// `&#x27;`).

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  decodeWorkspaceRecord,
  fixArtifacts,
  hasArtifact,
} from '../scripts/backfill-html-entities';

test('fixArtifacts decodes hex apostrophe entity', () => {
  assert.equal(fixArtifacts("Nike&#x27;s voice"), "Nike's voice");
});

test('fixArtifacts decodes the mangled space-not-hash variant (& x27;)', () => {
  assert.equal(fixArtifacts('Just do it & x27;s promise.'), "Just do it 's promise.");
  assert.equal(fixArtifacts('& X27;'), "'");
  assert.equal(fixArtifacts('& 39;'), "'");
});

test('fixArtifacts decodes decimal and named entities', () => {
  assert.equal(fixArtifacts('Nike&#039;s swoosh'), "Nike's swoosh");
  assert.equal(fixArtifacts('AT&amp;T'), 'AT&T');
});

test('fixArtifacts unwraps double-escaped entities', () => {
  assert.equal(fixArtifacts('AT&amp;amp;T'), 'AT&T');
  assert.equal(fixArtifacts('Nike&amp;#x27;s'), "Nike's");
});

test('fixArtifacts is idempotent on already-clean text', () => {
  const clean = "Nike's brand voice is bold.";
  assert.equal(fixArtifacts(clean), clean);
  assert.equal(fixArtifacts(fixArtifacts(clean)), clean);
});

test('fixArtifacts is idempotent when run twice on dirty text (roundtrip)', () => {
  const dirty = 'Nike&#x27;s "& x27;bold&amp;amp; fast" voice';
  const once = fixArtifacts(dirty);
  const twice = fixArtifacts(once);
  assert.equal(twice, once, 'second decode must be a no-op');
  assert.ok(!hasArtifact(once) || !/&#x|& x|&amp;amp;/.test(once));
});

test('hasArtifact detects every known variant', () => {
  assert.equal(hasArtifact("Nike&#x27;s"), true);
  assert.equal(hasArtifact('& x27;'), true);
  assert.equal(hasArtifact('&#039;'), true);
  assert.equal(hasArtifact('AT&amp;T'), true);
  assert.equal(hasArtifact("Nike's"), false);
  assert.equal(hasArtifact(''), false);
  assert.equal(hasArtifact(null as any), false);
});

test('decodeWorkspaceRecord fixes brief.brandVoice and revision notes', () => {
  const record: any = {
    brief: {
      brandVoice: 'Nike&#x27;s voice: bold &amp; fast',
      notes: 'Keep & x27;em moving',
      mustUseCopy: 'Just do it',
      goal: 'Launch&#039;s Q3',
    },
    stage_reviews: {
      brand: { latestNote: 'Tighten Nike&#x27;s wording' },
      strategy: { latestNote: null },
      creative: { latestNote: "Love it — ship it" },
    },
    creative_asset_reviews: {
      asset_1: { latestNote: 'Swap & x27;em for photography' },
    },
    status_history: [
      { note: 'Approved Nike&#x27;s v1' },
      { note: null },
    ],
  };

  const { record: out, changes } = decodeWorkspaceRecord(record);

  assert.equal(out.brief.brandVoice, "Nike's voice: bold & fast");
  assert.equal(out.brief.notes, "Keep 'em moving");
  assert.equal(out.brief.mustUseCopy, 'Just do it');
  assert.equal(out.brief.goal, "Launch's Q3");
  assert.equal(out.stage_reviews.brand.latestNote, "Tighten Nike's wording");
  assert.equal(out.stage_reviews.strategy.latestNote, null);
  assert.equal(out.stage_reviews.creative.latestNote, 'Love it — ship it');
  assert.equal(out.creative_asset_reviews.asset_1.latestNote, "Swap 'em for photography");
  assert.equal(out.status_history[0].note, "Approved Nike's v1");
  assert.equal(out.status_history[1].note, null);

  const paths = changes.map((c) => c.path).sort();
  assert.deepEqual(paths, [
    'brief.brandVoice',
    'brief.goal',
    'brief.notes',
    'creative_asset_reviews.asset_1.latestNote',
    'stage_reviews.brand.latestNote',
    'status_history[0].note',
  ]);
});

test('decodeWorkspaceRecord is a no-op when all fields are clean', () => {
  const record: any = {
    brief: { brandVoice: "Nike's voice", notes: 'clean' },
    stage_reviews: { brand: { latestNote: 'ok' } },
    creative_asset_reviews: {},
    status_history: [],
  };
  const { changes } = decodeWorkspaceRecord(record);
  assert.equal(changes.length, 0);
});

test('decodeWorkspaceRecord tolerates missing / oddly-shaped subtrees', () => {
  const { changes } = decodeWorkspaceRecord({});
  assert.equal(changes.length, 0);
  const { changes: c2 } = decodeWorkspaceRecord({
    brief: null,
    stage_reviews: 'not-an-object',
    creative_asset_reviews: undefined,
    status_history: 'nope',
  } as any);
  assert.equal(c2.length, 0);
});
