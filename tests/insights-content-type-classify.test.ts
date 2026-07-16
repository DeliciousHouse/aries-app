/**
 * tests/insights-content-type-classify.test.ts
 *
 * S3-2 (gap C1) — unit coverage for the caption-keyword theme heuristic
 * (backend/insights/sync/classify-post.ts). Pure/no DB/no IO; runs in
 * `npm run verify` on every PR.
 *
 * Covers (plan §6):
 *   (a) each of the 6 buckets reachable from a representative caption
 *   (b) deterministic precedence on an overlapping-keyword caption
 *   (c) empty/null/whitespace caption+title -> null
 *   (d) vocabulary-lock: output is always in CONTENT_TYPES or null, and the
 *       display-only sentinels 'uncategorized'/'other' are never returned
 *   (e) source-guard drift tripwire: CONTENT_TYPES exactly matches the seed
 *       script's array AND is a subset of the Top pattern card's
 *       CONTENT_TYPE_NOTES keys
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { CONTENT_TYPES, classifyPostContentType } from '../backend/insights/sync/classify-post';

const read = (p: string) => fs.readFileSync(path.join(import.meta.dirname, '..', p), 'utf8');

// ── (a) each of the 6 buckets reachable from a representative caption ─────────
test('classifyPostContentType: each of the 6 canonical buckets is reachable from a representative caption', () => {
  const cases: Array<[typeof CONTENT_TYPES[number], string]> = [
    ['educational', "Here's how to care for your leather goods. Tips inside!"],
    ['lifestyle', 'Meet the team behind our workshop! We love our community.'],
    ['testimonial', 'This 5-star review from a happy customer means the world to us.'],
    ['announcement', 'We are excited to announce our grand opening next week!'],
    ['promotional', 'Flash sale: 20% off everything, shop now before the offer ends!'],
    ['engagement', 'Tag a friend who needs to see this and comment below with your favorite!'],
  ];

  // Belt-and-suspenders: the fixture list itself must cover the full pinned
  // vocabulary, so a future 7th bucket added to CONTENT_TYPES without a test
  // case here fails loudly instead of silently under-covering.
  assert.deepEqual(
    cases.map(([type]) => type).sort(),
    [...CONTENT_TYPES].sort(),
    'fixture cases must cover every CONTENT_TYPES bucket exactly once',
  );

  for (const [expected, caption] of cases) {
    assert.equal(
      classifyPostContentType({ caption }),
      expected,
      `caption "${caption}" must classify as "${expected}"`,
    );
  }
});

// ── (b) deterministic precedence on overlapping keywords ──────────────────────
test('classifyPostContentType: deterministic precedence on a tied-score overlapping caption', () => {
  // "Our family review": wb('family') hits lifestyle (score 1), wb('review')
  // hits testimonial (score 1) — a genuine tie. The documented precedence
  // order (testimonial > announcement > promotional > educational >
  // engagement > lifestyle) means testimonial wins because it is checked
  // first and a later equal score never overwrites the incumbent `best`.
  assert.equal(classifyPostContentType({ caption: 'Our family review' }), 'testimonial');

  // "family deals": wb('family') hits lifestyle (score 1), wb('deals') hits
  // promotional (score 1) — promotional precedes lifestyle, so promotional
  // wins the tie. (Post-review: bare wb('deal') was removed from the
  // promotional keyword set — see the regression fixtures below — so this
  // fixture now uses the commercial-context 'deals' keyword to keep
  // exercising a genuine promotional/lifestyle tie.)
  assert.equal(classifyPostContentType({ caption: 'family deals' }), 'promotional');
});

// ── (b2) adversarial-review regression fixtures ────────────────────────────────
// Encodes the confirmed misfire scenarios from the S3-2 adversarial review as
// now-correct expectations. Each of these captions previously misclassified
// under the pre-fix keyword set (bare wb('deal'), unbounded phrase('drop a'),
// bare wb('learn')) and must not regress.
test('classifyPostContentType: adversarial-review regression fixtures (confirmed misfires, now fixed)', () => {
  // Idiomatic "deal with" must not misfire as promotional (bare wb('deal') is
  // gone) — "how to" correctly drives this to educational instead.
  assert.equal(
    classifyPostContentType({ caption: 'How to deal with dry skin this winter' }),
    'educational',
    '"deal with" is idiomatic, not commercial — must classify via "how to", not misfire on "deal"',
  );

  // "Price drop alert!" must never match engagement via a substring "drop a"
  // inside "drop alert" — phrase() is now bounded at both ends and the bare
  // 'drop a' pattern no longer exists (replaced with full phrases like 'drop
  // a comment'). No keyword actually hits this caption post-fix, so it is
  // honestly null — never engagement.
  assert.notEqual(
    classifyPostContentType({ caption: 'Price drop alert! New totes in the shop' }),
    'engagement',
    '"drop alert" must not substring-match engagement\'s "drop a..." phrases',
  );

  // "New backdrop at our studio today": "backdrop at" previously substring-
  // matched unbounded 'drop a' (backdrop + " at"). Word-bounded phrase()
  // matching must not treat this as engagement.
  assert.notEqual(
    classifyPostContentType({ caption: 'New backdrop at our studio today' }),
    'engagement',
    '"backdrop at" must not substring-match engagement\'s "drop a..." phrases',
  );

  // "backdrop and lighting setup": "backdrop and" previously substring-
  // matched unbounded 'drop a' (backdrop + " and"). Same fix applies.
  assert.notEqual(
    classifyPostContentType({ caption: 'A sneak peek at the new backdrop and lighting setup' }),
    'engagement',
    '"backdrop and" must not substring-match engagement\'s "drop a..." phrases',
  );

  // "Learn more" is a generic CTA, not instructional content — bare
  // wb('learn') is gone; only intent-bearing phrases ('learn how', 'learn
  // why', 'what you need to know') remain, none of which appear here.
  assert.notEqual(
    classifyPostContentType({ caption: 'Fall collection just landed. Learn more at the link in bio.' }),
    'educational',
    '"learn more" is a generic link CTA, not an educational post',
  );

  // The verb idiom "deals with" must not misfire as promotional — "deals"
  // carries a negative lookahead for "with". Retail forms still match.
  assert.notEqual(
    classifyPostContentType({ caption: 'Everyone deals with dry skin differently' }),
    'promotional',
    '"deals with" is a verb idiom, not a retail signal',
  );
  assert.equal(
    classifyPostContentType({ caption: 'How our team deals with rush orders' }),
    'lifestyle',
    '"deals with" must not add a promotional hit — "team" (lifestyle) is the caption\'s only real signal',
  );
  assert.equal(
    classifyPostContentType({ caption: 'Hot deals all week' }),
    'promotional',
    'plain retail "deals" still classifies as promotional',
  );

  // "a great deal of/on" noun idioms must not misfire — "deal of the" is
  // pinned to its day/week/month retail forms and "great deal on" is gone.
  assert.notEqual(
    classifyPostContentType({ caption: 'We handle a great deal of the process in-house' }),
    'promotional',
    '"a great deal of the" is a quantity idiom, not a retail signal',
  );
  assert.notEqual(
    classifyPostContentType({ caption: 'You can learn a great deal on our blog' }),
    'promotional',
    '"a great deal on" is a quantity idiom, not a retail signal',
  );
  assert.equal(
    classifyPostContentType({ caption: 'Deal of the day: candles for your reading nook' }),
    'promotional',
    'the retail "deal of the day" form still classifies as promotional',
  );
});

// ── (c) empty/null/whitespace -> null ──────────────────────────────────────────
test('classifyPostContentType: empty, null, and whitespace-only input returns null (honest pending state)', () => {
  assert.equal(classifyPostContentType({ caption: '', title: '' }), null);
  assert.equal(classifyPostContentType({ caption: null, title: null }), null);
  assert.equal(classifyPostContentType({ caption: undefined, title: undefined }), null);
  assert.equal(classifyPostContentType({ caption: '   ', title: '  \t ' }), null);
  assert.equal(classifyPostContentType({}), null);
  // A caption of pure non-matching text also legitimately returns null — no
  // forced catch-all bucket.
  assert.equal(classifyPostContentType({ caption: 'asdf qwer zxcv 12345' }), null);
});

// ── (d) vocabulary-lock ────────────────────────────────────────────────────────
test('classifyPostContentType: output is always in CONTENT_TYPES or null; never the display-only sentinels', () => {
  const corpus = [
    "Here's how to care for your leather goods. Tips inside!",
    'Meet the team behind our workshop! We love our community.',
    'This 5-star review from a happy customer means the world to us.',
    'We are excited to announce our grand opening next week!',
    'Flash sale: 20% off everything, shop now before the offer ends!',
    'Tag a friend who needs to see this and comment below with your favorite!',
    '',
    'Random unrelated caption text with no theme signal at all',
    'Uncategorized post about other stuff, other things, uncategorized items',
    null,
    'BOGO deal this weekend only, limited time!',
    'Day in the life at our studio — behind the scenes vibes.',
    'Did you know? A step-by-step guide to our process.',
    'Just dropped: brand new arrivals, now available!',
    'What do you think? Let us know in the comments below.',
  ];

  const allowed = new Set<string | null>([...CONTENT_TYPES, null]);
  for (const caption of corpus) {
    const result = classifyPostContentType({ caption });
    assert.ok(
      allowed.has(result),
      `classifyPostContentType("${caption}") returned "${result}", which is not in CONTENT_TYPES ∪ {null}`,
    );
    assert.notEqual(result, 'uncategorized', 'must never store the display-only "uncategorized" sentinel');
    assert.notEqual(result, 'other', 'must never store the display-only "other" sentinel');
  }
});

// ── (e) source-guard: vocabulary drift tripwire ────────────────────────────────
test('source-guard: CONTENT_TYPES exactly matches the seed script and is a subset of the Top pattern-card notes', () => {
  const seedSrc = read('scripts/seed-insights-extend.mjs');
  const seedMatch = seedSrc.match(/const\s+CONTENT_TYPES\s*=\s*\[([^\]]+)\]/);
  assert.ok(seedMatch, 'scripts/seed-insights-extend.mjs must define a CONTENT_TYPES array');
  const seedValues = [...seedMatch![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(
    seedValues,
    [...CONTENT_TYPES],
    'classify-post.ts CONTENT_TYPES must exactly match scripts/seed-insights-extend.mjs CONTENT_TYPES (order + values)',
  );

  const topSrc = read('backend/insights/top/top-template-builder.ts');
  const notesMatch = topSrc.match(/CONTENT_TYPE_NOTES[^{]*\{([\s\S]*?)\}/);
  assert.ok(notesMatch, 'top-template-builder.ts must define CONTENT_TYPE_NOTES');
  const noteKeys = [...notesMatch![1].matchAll(/^\s*([a-zA-Z_]+)\s*:/gm)].map((m) => m[1]);
  for (const type of CONTENT_TYPES) {
    assert.ok(
      noteKeys.includes(type),
      `CONTENT_TYPE_NOTES in top-template-builder.ts must have a key for "${type}"`,
    );
  }
});
