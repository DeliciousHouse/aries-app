# Creative Memory Learning Loop Evals Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Prove Aries Creative Memory learns user creative preferences over time by adding deterministic tests and an optional local eval harness for before/after prompt personalization, generated-asset approval, tenant isolation, and golden preference profiles.

**Architecture:** Keep automated tests deterministic and model-free. Unit/integration tests should exercise Creative Memory services directly with fake DB clients or minimal DB-backed fixtures where necessary. Human image/post quality evaluation stays outside CI until the deterministic prompt/context layer is stable.

**Tech Stack:** TypeScript, Node test runner via `tsx --test`, existing Creative Memory backend modules under `backend/creative-memory`, existing type definitions in `types/creative-memory.ts`.

---

## Non-negotiable constraints

- Work only inside `aries-app`.
- Use strict TDD for every production-code change: write failing test, run and confirm fail, implement minimal fix, run and confirm pass.
- Do not call external image/model APIs in tests.
- Do not make cron jobs in this implementation. Cron comes later after `eval:creative-memory-learning` exists and is fast/deterministic.
- Keep golden profile assertions string/id based, not full prompt snapshots if timestamps/provenance make them brittle.
- Use isolated tenant ids in fixtures.
- Do not push directly to `master`.

## Known implementation files

Read these before editing:

- `backend/creative-memory/retrieval.ts`
- `backend/creative-memory/promptCompiler.ts`
- `backend/creative-memory/learningEvents.ts`
- `backend/creative-memory/generatedAssets.ts`
- `backend/creative-memory/assets.ts`
- `backend/creative-memory/profileContext.ts`
- `types/creative-memory.ts`
- `tests/creative-memory-learning-labels.test.ts`
- `package.json`

## Validation commands

Targeted:

```bash
npx tsx --test tests/creative-memory-learning-loop.test.ts
npm run test:creative-memory
```

Final, from canonical checkout if required by repo guards:

```bash
npm run workspace:verify
```

---

## Task 1: Add learning-loop test skeleton and fake DB helpers

**Objective:** Create a maintainable test file with reusable fake DB helpers that can drive `retrieveCreativeContextPack()` and `compilePromptPreview()` deterministically.

**Files:**

- Create: `tests/creative-memory-learning-loop.test.ts`

**Step 1: Write failing tests/helpers first**

Add helper scaffolding and one initial test for no approved memory:

- tenant id `9200`
- business profile rows that make brand summary deterministic
- no style cards
- no creative assets
- no market notes
- a valid brief with `imageText`

Assertions:

- `preview.contextPack.status === 'insufficient_memory'`
- `preview.canGenerate === false`
- `preview.blockingReason` mentions not enough approved owned/generated examples
- `preview.contextPack.selectedStyleCards.length === 0`
- `preview.contextPack.selectedExamples.length === 0`
- `preview.compiledPrompt` contains blocker text
- `preview.compiledPrompt` does not contain `Memory-assisted guidance:`
- `preview.baselinePrompt` does not contain memory guidance
- `preview.negativePrompt` includes fixed guardrails plus `brief.mustAvoidAesthetics`

**Step 2: Run to verify failure**

```bash
npx tsx --test tests/creative-memory-learning-loop.test.ts
```

Expected: FAIL until helper SQL routing/profile fixture is complete.

**Step 3: Implement minimal helpers**

Build a fake `QueryClient` with arrays for:

- profile/business context tables used by `loadProfileContext()`
- `style_cards`
- `creative_assets`
- `market_pattern_notes`
- generated asset/prompt rows if later tasks need them

Keep SQL matching narrow and explicit. Throw on unexpected SQL so tests reveal missing behavior.

**Step 4: Verify**

```bash
npx tsx --test tests/creative-memory-learning-loop.test.ts
```

Expected: PASS for first test.

---

## Task 2: Add before/after approved memory prompt-delta tests

**Objective:** Prove the same brief changes after approved user preference memory exists.

**Files:**

- Modify: `tests/creative-memory-learning-loop.test.ts`

**Step 1: Write failing test**

Seed after-memory state for one tenant:

- two active style cards ordered by `confidence_score DESC`
- one lower-confidence active decoy style card
- one approved eligible `creative_asset`
- one competitor/public ad library decoy
- one observed/draft/rejected asset decoy

Assertions:

- before seeding: blocked, no memory guidance
- after seeding: `status === 'ready'`, `canGenerate === true`
- `compiledPrompt` includes `Memory-assisted guidance:`
- `compiledPrompt` includes both selected style-card `prompt_guidance` strings
- `compiledPrompt` includes selected example evidence
- `negativePrompt` includes global guardrails, brief avoidances, and selected style-card negative guidance
- `baselinePrompt` stays memory-free
- lower-confidence third style card is not selected
- competitor decoy appears in `excludedCandidates` with `competitor_direct_example_forbidden`
- unapproved lifecycle decoy appears in `excludedCandidates` with `asset_lifecycle_<state>`

**Step 2: Run and confirm fail**

```bash
npx tsx --test tests/creative-memory-learning-loop.test.ts
```

**Step 3: Implement only missing code if needed**

If existing code passes, do not change production. If fake asset shape is wrong, fix the test fixture, not production.

**Step 4: Verify**

```bash
npx tsx --test tests/creative-memory-learning-loop.test.ts
```

---

## Task 3: Add competitor-only tests

**Objective:** Prove competitor-derived information is allowed only as abstract notes and never as direct generation examples.

**Files:**

- Modify: `tests/creative-memory-learning-loop.test.ts`

**Step 1: Write failing test**

Seed:

- no approved owned/generated examples
- one competitor/public ad library creative asset
- one `market_pattern_notes` row with `allowed_use = 'abstract_only'`

Assertions:

- `contextPack.status === 'competitor_only'`
- `canGenerate === false`
- `blockingReason` mentions abstract competitor notes/add approved owned/generated examples
- `selectedExamples.length === 0`
- `marketPatternNotes.length > 0`
- direct competitor asset excluded with `competitor_direct_example_forbidden`
- compiled prompt does not include competitor direct example as selected evidence

**Step 2-4:** Run fail, fix minimally if needed, verify.

---

## Task 4: Add generated asset approval-loop tests

**Objective:** Prove Aries learns from accepted generated outputs, not just pre-seeded approved assets.

**Files:**

- Modify: `tests/creative-memory-learning-loop.test.ts`
- Maybe inspect/modify: `backend/creative-memory/generatedAssets.ts`

**Step 1: Write failing test**

Exercise actual functions where possible:

1. Save or mock a ready prompt recipe/context pack.
2. Call `createGeneratedAssetCandidate()`.
3. Assert candidate starts as:
   - `learningLifecycle === 'suggested'`
   - `reviewStatus === 'pending'`
4. Confirm retrieval excludes the pending linked asset.
5. Call `updateGeneratedAssetReview()` to approve it.
6. Assert linked `creative_assets` state becomes:
   - `usable_for_generation = true`
   - `learning_lifecycle = 'approved_for_generation'`
7. Confirm subsequent retrieval includes the approved generated asset.
8. Add a sibling rejection/changes-requested assertion that rejected candidates remain excluded.

**Step 2:** Run and confirm fail.

**Step 3:** If production behavior is missing, implement minimal fix in `generatedAssets.ts`. If behavior already exists, only adjust fake DB helper.

**Step 4:** Verify targeted test.

---

## Task 5: Strengthen learning label idempotency tests

**Objective:** Codify that labels are confidence signals and idempotent, not automatic approval.

**Files:**

- Modify: `tests/creative-memory-learning-labels.test.ts` or add cases in `tests/creative-memory-learning-loop.test.ts`

**Step 1: Write failing tests**

Cover:

- exact replay returns same label with `idempotentReplay: true`
- same idempotency key with different label returns conflict
- different prompt recipe id returns conflict
- different generated asset id returns conflict
- different source returns conflict
- different note returns conflict
- missing target still rejects before writing
- label alone does not make a non-approved asset selected by retrieval

**Step 2-4:** Run fail, fix minimally if needed, verify.

---

## Task 6: Add tenant isolation tests

**Objective:** Prevent preference leakage across tenants.

**Files:**

- Modify: `tests/creative-memory-learning-loop.test.ts`

**Step 1: Write failing test**

Seed Tenant A and Tenant B with conflicting preferences:

- Tenant A: dark luxury style card and approved asset
- Tenant B: bright playful style card and approved asset

Run the same brief for Tenant A and Tenant B.

Assertions:

- Tenant A prompt includes only dark luxury guidance
- Tenant A prompt excludes Tenant B bright guidance
- Tenant B prompt includes only bright guidance
- Tenant B prompt excludes Tenant A dark guidance
- selected ids are tenant-local

**Step 2-4:** Run fail, fix minimally if needed, verify.

---

## Task 7: Add retrieval filtering/ranking regression test and fix if needed

**Objective:** Catch the likely bug where `LIMIT 30` before filtering lets 30 recent ineligible assets hide older approved assets.

**Files:**

- Modify: `tests/creative-memory-learning-loop.test.ts`
- Maybe modify: `backend/creative-memory/retrieval.ts`

**Step 1: Write failing test**

Seed one tenant with:

- 30 most-recent ineligible assets, mix of competitor, draft, rejected, unusable
- 1 older eligible approved owned/generated asset
- enough active style card data to otherwise make context ready

Assertion:

- older eligible asset is selected
- rank is deterministic and contiguous after filtering, if product decision is to normalize ranks

**Expected current behavior:** likely FAIL because SQL limits to 30 before filtering.

**Step 2: Fix minimally**

Preferred fix options, choose simplest safe one:

- Filter eligibility in SQL before limit where possible, or
- increase query window and then filter, with a deterministic cap, or
- split competitor/exclusion fetch from eligible-example fetch.

Do not allow competitor/public ad library assets as selected examples.

**Step 3: Verify**

```bash
npx tsx --test tests/creative-memory-learning-loop.test.ts
npm run test:creative-memory
```

---

## Task 8: Add asset safety and frontend-safe response tests

**Objective:** Ensure selected examples and context packs do not leak unsafe refs or private internals.

**Files:**

- Modify: `tests/creative-memory-learning-loop.test.ts`

**Step 1: Write failing tests**

Assert exclusions for:

- `usable_for_generation = false`
- unsafe/missing `served_asset_ref`
- unsupported source/scope combination
- competitor/public ad library direct examples

Assert response does not include:

- raw filesystem paths
- `storage_key`
- tenant internals
- direct private/cloud URLs

**Step 2-4:** Run fail, fix minimally if needed, verify.

---

## Task 9: Add golden profile fixtures and tests

**Objective:** Encode six independent preference profiles to prove identical briefs personalize differently by tenant.

**Files:**

- Modify: `tests/creative-memory-learning-loop.test.ts`, or
- Create: `tests/fixtures/creative-memory-golden-profiles.ts` if the test file becomes too large.

**Profiles:**

1. `golden-profile-01-dark-luxury`, brand `Nocturne Skin`
   - include guidance: dark premium product hero, obsidian/charcoal, soft rim lighting, champagne-gold accent, generous negative space
   - avoid: bright candy colors, cluttered prop spreads, cartoon shapes, loud sale bursts, clinical white lab scenes

2. `golden-profile-02-bright-playful-dtc`, brand `PopGlow Lab`
   - include guidance: saturated coral/lemon/aqua color blocking, oversized simple shapes, bold product-first layout, playful sticker-like CTA
   - avoid: black luxury minimalism, muted beige palettes, moody shadows, tiny whisper typography

3. `golden-pref-03-founder-led-ugc`, brand `Northstar Ops Lab`
   - include guidance: founder-recorded UGC look, handheld desk selfie, natural light, unpolished crop, messy whiteboard breakdown
   - avoid: polished studio lighting, corporate stock people, glossy SaaS UI mockups, sterile infographic grid

4. `golden-pref-04-direct-response-offer-heavy`, brand `SprintStack`
   - include guidance: direct-response offer card, oversized benefit headline, checklist mockup, bright CTA, proof badge, arrow toward CTA
   - avoid: subtle editorial layout, vague brand manifesto, tiny CTA, lifestyle-first composition

5. `golden_profile_05_premium_sparse_editorial`, brand `Atelier Vale`
   - include guidance: premium sparse editorial, warm off-white negative space, one calm home vignette, refined serif headline, understated CTA
   - avoid: cluttered layouts, sale badges, cartoon icons, loud colors, starburst offers

6. `golden_profile_06_local_friendly_practical`, brand `Maple Street Home Services`
   - include guidance: friendly local-business layout, bright real-home crop, readable sans-serif headline, rounded service card, warm daylight, practical next steps
   - avoid: luxury fashion styling, abstract editorial whitespace, corporate stock handshake, dark moody palette, jargon

For each profile assert:

- before preference seeding: blocked/no selected examples
- after seeding: `status === 'ready'`, `canGenerate === true`
- expected selected style-card ids
- expected selected asset ids
- expected included prompt phrases
- expected excluded prompt phrases from other profiles
- expected negative guidance phrases

**Step 2-4:** Run fail, fix fixtures/helpers, verify.

---

## Task 10: Add optional local eval script

**Objective:** Provide a developer-facing deterministic report without external API calls.

**Files:**

- Create: `scripts/eval-creative-memory-learning.ts`
- Modify: `package.json`

**Step 1: Write failing test or smoke expectation**

If there is an existing script test pattern, follow it. Otherwise keep this as a directly runnable script that imports the same fixture/eval helpers as tests.

Expected command:

```bash
npm run eval:creative-memory-learning
```

Expected output:

- JSON or markdown summary
- profile name
- before status
- after status
- included prompt checks pass/fail
- excluded prompt checks pass/fail
- selected ids
- final PASS/FAIL

**Step 2: Add package script**

```json
"eval:creative-memory-learning": "tsx scripts/eval-creative-memory-learning.ts"
```

**Step 3: Verify**

```bash
npm run eval:creative-memory-learning
```

---

## Task 11: Final integration review and verification

**Objective:** Ensure the implementation is clean, scoped, and ready for PR.

**Commands:**

```bash
npx tsx --test tests/creative-memory-learning-loop.test.ts
npm run test:creative-memory
npm run eval:creative-memory-learning
npm run validate:repo-boundary
npm run validate:banned-patterns
npm run workspace:verify
```

If `workspace:verify` refuses to run in the worktree due canonical checkout rules, report that clearly and rerun final verification in `/home/node/aries-app` after safely checking out or cherry-picking the branch there.

**Review checklist:**

- No external API calls in tests or eval script
- No sibling-project context
- No direct competitor examples in generation prompt
- Label semantics are documented by tests
- Golden profiles are isolated by tenant id
- Filtering/ranking bug fixed or documented by failing test if product decision is deferred
- All changed files are intentional

---

## Completion report format

When done, report:

- Branch name
- Worktree path
- Files changed
- Tests run and exact results
- Whether production code changed or tests only
- Any discovered bugs, especially retrieval filtering/ranking
- PR status if pushed/created
