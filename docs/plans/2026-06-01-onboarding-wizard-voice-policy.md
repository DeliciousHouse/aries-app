# Onboarding wizard: voice + approval-rules stages + first-weekly-plan handoff

> Status: draft plan (2026-06-01). Roadmap area [6] — "Upgrade onboarding from intake form to business setup wizard." Priority 5. Key: `onboarding-wizard-voice-policy`. Phase P2 (first-user experience).

## Context

The Aries onboarding wizard already exists and is the canonical intake path. `frontend/aries-v1/onboarding-flow.tsx` (2226 lines) is a real multi-step client wizard with five steps — `goal | business | website | brand | channels` (`STEP_DEFINITIONS`, lines 55-86) — covering the marketing goal, business identity, the live-website source-of-truth, a brand snapshot preview, and a channel mix that includes Meta/Instagram/TikTok/YouTube/LinkedIn/Google Business/Email (`CHANNEL_OPTIONS`, lines 88-124). It autosaves to a server draft (`onboarding_drafts` table) plus a localStorage fallback, and on finish it hands off to `/onboarding/resume`, which materializes a tenant, persists the business profile, and **immediately starts the first `weekly_social_content` job** before redirecting into the workspace (`app/onboarding/resume/page.tsx:153-172`).

What the roadmap says is missing, and what this plan adds:

1. **Voice stage** — a tone picker, good/bad example pairs, and a words-to-avoid list. None of these are collected today. The wizard collects no voice signal at all beyond what the website scraper infers.
2. **Approval-rules stage** — who approves, and what must always be human-approved before publish. Today there is a single optional free-text "Launch approver" field buried inside the `business` step (`onboarding-flow.tsx:1531-1543`); there is no notion of approval policy.
3. **First-weekly-plan completion handoff that lands in the live review flow** — the handoff to "generate first weekly plan -> review queue -> calendar -> approval" already *technically* fires (`startSocialContentJob` in resume), but the **voice and approval inputs never reach it**, and the wizard's completion copy does not frame the review/approval loop the operator is about to enter. Completing the wizard is what makes onboarding land in the live review flow — so the voice + policy signal must thread through `resume -> business_profiles -> startSocialContentJob payload -> Hermes brand payload`.

The good news from recon: the **persistence and Hermes-contract seams already exist**. `business_profiles` already has `brand_voice` and `style_vibe` columns (`scripts/init-db.js`, the `business_profiles` block, lines 158-159). The Hermes brand payload already consumes operator-supplied `brandVoice`, `styleVibe`, and a free-text **`mustAvoidAesthetics`** that flows into `must_avoid_aesthetics` (`backend/social-content/brand-kit-payload.ts:182-189` for must-avoid; `129-138` for voice). So "words to avoid" and "tone" map onto contract fields that Hermes already reads — this is wiring, not a new contract. Approval rules are net-new persistence but are an Aries-only concern (they gate Aries' own publish path; Hermes never sees them).

## Who cares

- **New tenants / the operator setting up @sugarandleather-style accounts** — the difference between "Aries guessed my voice from my homepage" and "I told Aries my tone, my three banned words, and that nothing publishes without my sign-off." This is the trust moment.
- **Product** — roadmap item #2 (first useful result) and #6 (setup wizard) both hinge on the wizard producing a real, voice-shaped, approval-gated first plan. A wizard that ends in a generic plan undercuts the whole "safety-first, nothing goes live without approval" framing.
- **Eng** — the voice/approval fields are the same fields the Review Queue v2 (#3) and the memory screen (#4) will later read. Persisting them now in the canonical `business_profiles` + draft shape avoids a second migration.

## Decisions (locked — do not re-litigate)

1. **Two new steps, inserted after `channels`, before finish:** `voice` then `approval`. New step order: `goal | business | website | brand | channels | voice | approval`. The finish action stays on the last step (`approval`). This preserves the existing step-index URL state (`?step=`), browser-history sync, and autosave machinery, which all key off `STEP_DEFINITIONS` ordinality.
2. **Voice fields are structured but map onto existing contract fields.** `tone` (single-select from a fixed picker) + `voiceNotes` (free text) compose into the existing `brandVoice` string. `wordsToAvoid` (list) composes into the existing `mustAvoidAesthetics` string the Hermes payload already reads. `goodExamples` / `badExamples` are stored as draft + profile JSON and passed as `voiceExamples` in the job payload (Hermes may ignore them initially; storing them is the durable win and feeds the future memory screen). **No new Hermes contract field is required for v1.**
3. **Approval rules are Aries-only and default to the safest posture.** Stored as a structured `approvalRules` object: `{ approverName, requireApprovalBeforePublish: boolean (default true, NOT operator-disableable below a floor), alwaysApprove: string[] }`. They never reach Hermes. They are persisted so the publish path and Review Queue can later enforce them. **This plan persists + surfaces them; it does NOT change the publish gate** (the existing approval-gated pipeline already blocks autonomous publish — guardrail). Enforcement wiring is a follow-up, explicitly out of scope here.
4. **The whole new-stage behavior ships behind `ARIES_ONBOARDING_VOICE_POLICY_ENABLED` (default OFF).** When OFF, the wizard renders exactly today's five steps and the resume handoff is byte-for-byte unchanged; the new draft columns simply stay empty. When ON, the two new steps render and their values thread through to the first plan. This is a UI + payload behavior change, so it is flag-gated per the guardrail.
5. **Additive, idempotent schema only.** New `onboarding_drafts` and `business_profiles` columns are `ADD COLUMN IF NOT EXISTS ... DEFAULT`. The draft-store's existing fallback-to-DATA_ROOT path (`shouldUseFallbackDraftStore`, `draft-store.ts:350-374`) already tolerates `42703` (undefined_column) during deploy skew, so a half-deployed column never blocks public intake.
6. **No autonomous publish, ever.** Setting `requireApprovalBeforePublish` is presented as a fixed guarantee with an explanatory line, not a toggle the operator can flip to "auto-publish." The wizard never offers an auto-publish path. (Guardrail: nothing publishes without human approval.)
7. **Brand URL discipline.** Any example copy, placeholder, or preview text that references the brand uses `aries.sugarandleather.com`, never bare `sugarandleather.com`.

## Current State (VERIFIED — branch `fix/story-composer-serving`)

**Wizard — `frontend/aries-v1/onboarding-flow.tsx`:**
- `StepKey = 'business' | 'website' | 'brand' | 'channels' | 'goal'` (line 35); `STEP_DEFINITIONS` orders them `goal, business, website, brand, channels` (lines 55-86).
- Per-step readiness via `stepReady()` (lines 291-321) and `stepValidationMessage()` (lines 323-365) — both are exported and unit-tested.
- `canFinish` = every step ready (lines 664-675); `handleFinish()` (lines 1147-1244) PATCHes the draft to `status:'ready_for_auth'` and routes to `/onboarding/resume` (authenticated) or `/login` (unauth).
- All draft fields are flat scalars/arrays on the component and on the `updateOnboardingDraft` PATCH body: `businessName, businessType, websiteUrl, approverName, channels, goal, offer, competitorUrl, preview, provenance` (lines 857-872). `approverName` already exists as a free-text field (lines 1531-1543, `LocalDraftSnapshot` line 376, component state line 579).
- Autosave keys off `STEP_DEFINITIONS` length and the field-state effect deps (lines 842-902). localStorage snapshot shape is `LocalDraftSnapshot` (lines 370-382). The full-screen transition copy "Building your first weekly social content plan" is at lines 1342-1351.
- Step copy strings that tests import live in the sidecar `frontend/aries-v1/onboarding-flow.copy.ts`.

**Draft store — `backend/onboarding/draft-store.ts`:**
- `OnboardingDraft` type (lines 53-70) and `OnboardingDraftMutation` (lines 72-86) enumerate every draft field; `emptyDraft` (125), `applyDraftMutation` (229), `rowToDraft` (301), `draftToRow` (322) must each learn any new field.
- SQL `INSERT` (454) / `UPDATE` (594, 635) enumerate columns explicitly — a new column requires touching the field-bearing INSERT/UPDATE.
- `shouldUseFallbackDraftStore` already treats `42703` (undefined_column) and `42P01` as fallback-eligible (lines 350-374), so column skew during deploy degrades to the DATA_ROOT JSON file, not a 503.

**Draft API — `app/api/onboarding/draft/route.ts`:**
- `PATCH` whitelists each field explicitly (lines 98-119). New fields need an explicit parse line each (the route does not pass through unknown keys). The `provenance` object-shape guard is at lines 109-114.

**Resume / handoff — `app/onboarding/resume/page.tsx`:**
- `claimOnboardingDraftMaterialization` (CAS guard, idempotent) -> `resolveTenantForDraft` -> `updateBusinessProfileWithDiagnostics(client, {...})` (lines 122-132, currently passes `businessName, websiteUrl, businessType, primaryGoal, launchApproverName, offer, competitorUrl, channels` — **no voice/approval**) -> builds `payload` (lines 137-151) -> `startSocialContentJob({ tenantId, jobType:'weekly_social_content', createdBy, payload })` -> `ensureSocialContentWorkspaceRecord` -> sets draft `materialized` -> redirects to `/dashboard/social-content/{jobId}?welcome=1`. This is the live review/calendar/approval landing surface.
- On error it resets the draft to `ready_for_auth` and rethrows (lines 173-176) — resumable.

**Business profile — `backend/tenant/business-profile.ts`:**
- `BusinessProfileRecord` (line 39) and `BusinessProfileView` (line 60) already carry `brand_voice`/`brandVoice` (49/70) and `style_vibe`/`styleVibe` (50/71). `BusinessProfileUpdateInput` (line 109) accepts `brandVoice` (118), `styleVibe` (119). The UPSERT (`saveBusinessProfileRecordToDb`, lines 367-399) and merge logic (`mergePersistedStringField`, line 204; applied to brandVoice/styleVibe at 793-794) already persist them. **No `wordsToAvoid`, no structured voice, no approval policy columns.**
- `app/api/business/profile/route.ts` PATCH (lines 111-167) already accepts `brandVoice`/`styleVibe` (input types 120-121, parse 166-167).

**Hermes brand payload — `backend/social-content/brand-kit-payload.ts`:**
- `SocialContentBrandPayload` has `voice`, `style_vibe`, and `must_avoid_aesthetics` (lines 14-32).
- `resolveBrandVoice(req, brandKit)` composes `req.brandVoice` + brandKit tone (lines 129-138).
- `resolveMustAvoidAesthetics(req)` splits operator-supplied `req.mustAvoidAesthetics` free text on `[\n;,]` (the `.split(/[\n;,]/)` call is line 185) and unions it with `SOCIAL_CONTENT_FORBIDDEN_VISUAL_PATTERNS` (function lines 182-189). **This is the existing seam "words to avoid" rides into.** Approval rules are NOT in this payload and must not be added (Aries-only).

**Schema — `scripts/init-db.js`:**
- `onboarding_drafts` (`CREATE TABLE IF NOT EXISTS onboarding_drafts`, line 129) and `business_profiles` (line 148) both list columns explicitly. Both get additive columns. `business_profiles` already uses an additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS timezone` (line 171), so the additive-column idiom is precedented in this file. The repo also uses dated migrations under `migrations/` for forward deploys.

**Tests (existing, must stay green):** `tests/onboarding-draft-route.test.ts` (in the fast verify suite, `scripts/verify-regression-suite.mjs:163`), `tests/onboarding-resume.test.ts`, `tests/onboarding-materialization-claim.test.ts`, `tests/onboarding-step-one-validation.regression-012.test.ts`, `tests/onboarding-draft-store.test.ts`, `tests/onboarding-browser-history.test.ts`. The step-validation and browser-history tests assert against `STEP_DEFINITIONS` ordinality and `stepReady`/`stepValidationMessage`, so adding steps must extend, not break, them.

## Architecture (target data flow)

```
Wizard (flag ON): goal -> business -> website -> brand -> channels -> [voice] -> [approval] -> finish
   tone(select) + voiceNotes(text) ─┐
   wordsToAvoid(list) ──────────────┤
   goodExamples/badExamples ────────┤   (new draft fields, all default-empty)
   approverName + alwaysApprove[] ──┘
        │  PATCH /api/onboarding/draft   (status: ready_for_auth)
        ▼
backend/onboarding/draft-store.ts  (OnboardingDraft gains tone, voiceNotes,
   wordsToAvoid[], voiceExamples{good[],bad[]}, approvalRules{...})
        │  onboarding_drafts (+ new columns, additive)
        ▼
app/onboarding/resume/page.tsx  (claim → tenant)
   updateBusinessProfileWithDiagnostics({ …, brandVoice: compose(tone,voiceNotes),
        styleVibe, wordsToAvoid, approvalRules })   → business_profiles (+ new cols)
        │
   startSocialContentJob payload {
        …, brandVoice, styleVibe,
        mustAvoidAesthetics: wordsToAvoid.join('\n'),   ← rides EXISTING Hermes seam
        voiceExamples, approvalRules (carried for workspace record, not Hermes)
   }
        ▼
backend/social-content/brand-kit-payload.ts
   resolveBrandVoice(req) ← req.brandVoice (tone+notes)
   resolveMustAvoidAesthetics(req) ← req.mustAvoidAesthetics (wordsToAvoid)   [UNCHANGED]
        ▼
Hermes weekly plan  →  review queue / calendar / approval
        ▼
/dashboard/social-content/{jobId}?welcome=1   (live review landing — UNCHANGED route)
```

## Phases

| # | Phase | Priority | Effort (human / CC) | Dependencies |
|---|-------|----------|---------------------|--------------|
| A | Schema + draft contract: new draft + profile columns, draft-store + API field plumbing (no UI yet) | Critical | 3h / 1h | none |
| B | Voice stage UI (tone picker, good/bad examples, words-to-avoid) behind flag | High | 5h / 2h | A |
| C | Approval-rules stage UI (approver, always-approve list, fixed approval guarantee) behind flag | High | 4h / 1.5h | A |
| D | Resume handoff: thread voice + approval into `updateBusinessProfileWithDiagnostics` + `startSocialContentJob` payload; completion copy framing the review/approval loop | High | 3h / 1h | A |
| E | Flag, docs, fast-suite allowlist, live E2E on a fresh tenant, ship | Medium | 3h / 1h | B, C, D |

**Sequencing:** A first (every later phase reads the new fields). B and C are parallel UI work once A lands. D depends only on A (it reads draft fields, not UI). E last. Each phase is independently shippable: A ships dark (columns + plumbing, no behavior change, flag still OFF); B/C ship the steps behind the flag; D ships the wiring (still gated); E flips the flag in a controlled rollout.

```
A ─┬─> B ──┐
   ├─> C ──┼─> E
   └─> D ──┘
```

---

### A — Schema + draft contract (Critical, 3h)

**What exists / reused:** the `onboarding_drafts` and `business_profiles` tables, `OnboardingDraft`/`OnboardingDraftMutation` types, the draft-store fallback path, the draft PATCH route.

**Implementation:**
1. New migration `migrations/20260601120000_onboarding_voice_policy.sql` (additive + idempotent):
   ```sql
   ALTER TABLE onboarding_drafts ADD COLUMN IF NOT EXISTS voice JSONB NOT NULL DEFAULT '{}'::jsonb;
   ALTER TABLE onboarding_drafts ADD COLUMN IF NOT EXISTS approval_rules JSONB NOT NULL DEFAULT '{}'::jsonb;
   ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS words_to_avoid TEXT[] NOT NULL DEFAULT '{}';
   ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS voice_examples JSONB NOT NULL DEFAULT '{}'::jsonb;
   ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS approval_rules JSONB NOT NULL DEFAULT '{}'::jsonb;
   ```
   `voice` JSONB on the draft holds `{ tone, voiceNotes, wordsToAvoid[], goodExamples[], badExamples[] }`; keeping voice in one JSONB column (rather than 5 scalar columns) keeps the explicit-column INSERT/UPDATE lists short. Mirror all five `ADD COLUMN` lines into `scripts/init-db.js` (both table blocks — `onboarding_drafts` at line 129, `business_profiles` at line 148) for fresh installs, following the existing `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` idiom already used at line 171.
2. `backend/onboarding/draft-store.ts`: extend `OnboardingDraft` (line 53) + `OnboardingDraftMutation` (line 72) with `voice: OnboardingDraftVoice` and `approvalRules: OnboardingDraftApprovalRules` (new exported types). Wire them through `emptyDraft` (125, sanitize/default to empty), a new `sanitizeVoice()` + `sanitizeApprovalRules()` (mirror `sanitizePreview` shape-validation, line 153), `applyDraftMutation` (229), `rowToDraft` (301), `draftToRow` (322, JSON.stringify like `preview`/`provenance`), and the field-bearing `INSERT` (454) / `UPDATE` (635) SQL (add `voice`, `approval_rules` columns + params). `requireApprovalBeforePublish` is forced `true` in the sanitizer — a stored `false` is read back as `true` (no autonomous-publish escape hatch).
3. `app/api/onboarding/draft/route.ts` PATCH: add explicit parse lines for `voice` and `approvalRules` (validate they are objects, like the `provenance` guard at lines 109-114). Reject malformed shapes silently to `undefined` (no-op), never 500.
4. `business_profiles`: add `wordsToAvoid?: string[]`, `voiceExamples?`, `approvalRules?` to `BusinessProfileUpdateInput` (line 109) and the UPSERT (`saveBusinessProfileRecordToDb`, lines 367-399); add read-side fields to `BusinessProfileRecord`/`BusinessProfileView` for the future memory screen. These are net-new merge fields (use a list-merge / object-merge, NOT `mergePersistedStringField`, which is string-only).

**Acceptance:** `\d onboarding_drafts` shows `voice` + `approval_rules`; a PATCH carrying `voice:{tone:'warm',wordsToAvoid:['hype']}` round-trips through GET unchanged; a PATCH with `approvalRules:{requireApprovalBeforePublish:false}` reads back `true`; a draft created on a DB still missing the columns (simulated `42703`) silently falls back to the DATA_ROOT JSON file (existing behavior, now covering the new fields). No UI change, flag still OFF — this phase is invisible to operators.

### B — Voice stage UI (High, 5h)

**What exists / reused:** the entire wizard step machinery — `STEP_DEFINITIONS`, `stepReady`, `stepValidationMessage`, `Field`/`EditorialPanel` render primitives, autosave, URL/history sync, the `LOCAL_DRAFT_VERSION` snapshot.

**Implementation:**
1. Add `'voice'` to `StepKey` (line 35) and a `voice` entry to `STEP_DEFINITIONS` (after `channels`). **Per CLAUDE.md memory "widening union → grep inequalities": grep every `=== 'channels'`, `=== 'goal'`, `!== 'business'` and the `currentStep.key === '<x>'` render branches after widening the union.** Bump `LOCAL_DRAFT_VERSION` (line 368, currently `1`) to 2 and extend `LocalDraftSnapshot` (line 370) with the new fields so a stale v1 local draft is discarded rather than mis-read.
2. New `voice` render branch in the step body: a **tone picker** (fixed `TONE_OPTIONS` const, single-select chips, e.g. Warm / Confident / Playful / Premium / Plain-spoken / Bold), a **good example** + **bad example** pair of textareas ("a sentence that sounds like you" / "a sentence that does not"), and a **words-to-avoid** chip input (comma/enter to add). Each writes component state mirrored into the draft `voice` JSONB on autosave.
3. `stepReady('voice', …)` returns `true` always (voice is encouraged, not required — do not block finish on it; an empty voice degrades to today's scraper-inferred behavior). `stepValidationMessage('voice')` returns a soft hint. Keep these exported (tests import them).
4. Gate the whole step behind the flag: a client-readable boolean (passed from the server `app/onboarding/start/page.tsx` as a prop, the same way `initialAuthenticated` is passed at line 34, since `process.env` is server-only). When OFF, filter `voice`/`approval` out of `STEP_DEFINITIONS` at render so step count, progress, and URL state match today exactly.
5. Move new render copy strings into `frontend/aries-v1/onboarding-flow.copy.ts` so tests assert against the sidecar, not the `.tsx`.

**Acceptance (rendered UI):** with the flag ON, a fresh wizard shows a 6th "Voice" step between Channels and the finish; selecting a tone, typing a good/bad example, and adding two words-to-avoid chips autosaves (the "Saved" indicator fires) and survives a page refresh (server draft) and a private-window refresh (localStorage v2). With the flag OFF, the wizard shows exactly five steps and is pixel-identical to production.

### C — Approval-rules stage UI (High, 4h)

**What exists / reused:** same step machinery; the existing `approverName` field (relocated here from the `business` step) and its `LocalDraftSnapshot` slot.

**Implementation:**
1. Add `'approval'` to `StepKey` + `STEP_DEFINITIONS` as the **last** step (so finish stays on it). Apply the same union-widening grep discipline as B.
2. `approval` render branch: (a) **Launch approver** name input (reuse `approverName` state — remove the duplicate from the `business` step, or keep it read-only-mirrored there; pick one source of truth to avoid the two-field drift the codebase already warns about elsewhere); (b) a **fixed approval guarantee** — a non-toggle card reading "Nothing publishes without your approval. Every post waits in your review queue until you approve it." (this renders `requireApprovalBeforePublish` as a guarantee, never an off-switch — guardrail); (c) an **always-require-approval** multi-select for categories that must always be human-checked (e.g. "Posts that mention pricing", "Posts with people's faces", "Anything off the approved channels") → `approvalRules.alwaysApprove[]`.
3. `stepReady('approval', …)` requires a non-empty approver name (the one hard requirement — there must be a named human in the loop). `stepValidationMessage('approval')` returns "Name who approves before anything goes live."
4. Same flag gating + copy-sidecar discipline as B.

**Acceptance (rendered UI):** flag ON, the final step is "Approval"; the approval guarantee card renders and has no auto-publish control; entering an approver name enables Finish; leaving it blank shows the validation message and keeps Finish disabled. Flag OFF: step absent, finish stays on Channels' successor exactly as today.

### D — Resume handoff: thread voice + approval into the first plan (High, 3h)

**What exists / reused:** `app/onboarding/resume/page.tsx` claim→profile→`startSocialContentJob` flow; `updateBusinessProfileWithDiagnostics`; the Hermes brand-payload seams `resolveBrandVoice` / `resolveMustAvoidAesthetics` (UNCHANGED — they already read `req.brandVoice` / `req.mustAvoidAesthetics`).

**Implementation:**
1. In `resume/page.tsx`, after `claimOnboardingDraftMaterialization`, read `claim.draft.voice` + `claim.draft.approvalRules`. Compose `brandVoice = [tone, voiceNotes].filter(Boolean).join('. ')` and pass it (plus `styleVibe` if collected, `wordsToAvoid`, `voiceExamples`, `approvalRules`) into `updateBusinessProfileWithDiagnostics(client, { …existing, brandVoice, wordsToAvoid, voiceExamples, approvalRules })` (the existing call is at lines 122-132).
2. Extend the `payload` object (resume lines 137-151) with `brandVoice`, `styleVibe`, `mustAvoidAesthetics: (voice.wordsToAvoid ?? []).join('\n')` (the exact shape `resolveMustAvoidAesthetics` splits on — the `.split(/[\n;,]/)` at brand-kit-payload.ts:185), `voiceExamples`, and `approvalRules`. Because `buildBrandKitPayload` already reads `req.brandVoice` and `req.mustAvoidAesthetics`, the first weekly plan is now voice-shaped with **zero changes to the Hermes contract**. `approvalRules`/`voiceExamples` ride along in the workspace record (`ensureSocialContentWorkspaceRecord`) for the Review Queue, not the Hermes payload.
3. Completion framing: update the wizard's transition copy (`onboarding-flow.tsx:1342-1351`) and/or the `?welcome=1` landing so the operator understands they are entering the review/approval loop — e.g. "Your first week is being drafted. It will wait in your review queue — nothing publishes until you approve it." (Only when flag ON; OFF keeps today's copy.) Reference `aries.sugarandleather.com` if any brand URL appears.
4. Gate the new threading on the same flag server-side so an OFF deploy passes byte-identical payloads to today.

**Acceptance (rendered UI):** completing the flag-ON wizard with tone "Warm" + words-to-avoid ["hype","cheap"] lands on `/dashboard/social-content/{jobId}?welcome=1`; the materialized job's brand payload carries `voice` containing "Warm" and `must_avoid_aesthetics` containing "hype"/"cheap" (verified in the rendered job/brand panel, not just the DB); the business profile screen shows the saved voice + approver. Flag OFF: identical payload + landing as production today.

### E — Flag + docs + fast-suite + live E2E + ship (Medium, 3h)

**Implementation:**
1. `ARIES_ONBOARDING_VOICE_POLICY_ENABLED` (default OFF). Read it with the established helper shape (`raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'`, mirroring `isVideoPublishEnabled`, `backend/marketing/synthesize-publish-posts.ts:115-118`) in one server module that both `app/onboarding/start/page.tsx` (to prop the wizard) and `resume/page.tsx` (to gate threading) import. Add to `.env.example` (next to `ARIES_VIDEO_PUBLISH_ENABLED=0` at line 53), `docker-compose.yml` (default `0`, mirroring `ARIES_VIDEO_PUBLISH_ENABLED: ${ARIES_VIDEO_PUBLISH_ENABLED:-0}` at line 74), and a `CLAUDE.md` "Environment Variables" → "Optional safety flags" entry (after the existing flag block ending ~line 153) styled like the existing flag docs.
2. New test files allowlisted in `scripts/verify-regression-suite.mjs` alongside `tests/onboarding-draft-route.test.ts` (line 163).
3. Live E2E on a fresh test tenant (treat-as-production: real DB, not a mock): run the full flag-ON wizard end to end, confirm the rendered 7-step flow, the rendered first plan in the workspace, and the rendered approver/voice on the profile screen. Per memory, only rendered UI counts as done.
4. `/ship`-style: bump `VERSION` (currently `0.1.13.18`; minor: new columns + UI steps + payload fields) and `CHANGELOG.md`. Run `npm run guardrails:agent` (parallel-worktree dup check), `npm run verify`, then `npm run test:concurrent` (this touches routes + backend + a wizard component).

**Acceptance:** flag OFF ⇒ wizard, draft payload, and resume handoff are byte-identical to production (proven by the unchanged-path tests); flag ON ⇒ the 7-step flow renders, voice + approval persist, and the first plan is voice-shaped and approval-gated; `full-suite` CI gate green.

## Feature flag

`ARIES_ONBOARDING_VOICE_POLICY_ENABLED=1` — gates the onboarding voice + approval-rules stages and the voice/approval-aware first-plan handoff. Aries treats `1`, `true`, `yes`, or `on` as enabled. Default OFF. When OFF, the onboarding wizard renders the existing five steps (`goal | business | website | brand | channels`), the draft PATCH ignores the new fields, and `/onboarding/resume` passes the exact same `startSocialContentJob` payload it does today — the new `onboarding_drafts.voice` / `approval_rules` and `business_profiles.words_to_avoid` / `voice_examples` / `approval_rules` columns simply stay at their empty defaults. When ON, two new steps (`voice`, `approval`) render after `channels`, their values persist to the draft and business profile, and the first weekly plan is generated with operator-supplied tone, words-to-avoid (via the existing `must_avoid_aesthetics` Hermes seam), and a named human approver. The flag never enables autonomous publishing; `requireApprovalBeforePublish` is a fixed guarantee, not an operator toggle. Process-wide (affects all tenants in the container). Ship default OFF; flip only after the live E2E on a fresh tenant confirms the rendered flow and a rendered, voice-shaped first plan.

## User-visible success bar (rendered UI only)

Done means, on a real tenant with the flag ON:
1. The onboarding wizard at `/onboarding/start` renders a **7-step** flow with a "Voice" step (tone picker + good/bad example fields + words-to-avoid chips) and an "Approval" step (named approver + the fixed "nothing publishes without approval" guarantee card + always-approve categories).
2. Entered voice + approval values **survive a page refresh** (server draft) and a private-window refresh (localStorage), shown by the existing "Saved" indicator.
3. Finishing the wizard lands on `/dashboard/social-content/{jobId}?welcome=1` and the **first weekly plan visibly reflects the chosen tone and excludes the words-to-avoid** (verified in the rendered job/brand panel).
4. The business-profile screen renders the saved voice tone and the named approver.

DB rows, draft JSON files, payload objects, and passing unit tests do **not** count on their own — only the rendered dashboard UI does.

## Testing Plan (fixture-primary)

| Layer | What | Count |
|-------|------|-------|
| Unit | `stepReady`/`stepValidationMessage` for `'voice'` (always-ready) and `'approval'` (requires approver) | +4 |
| Unit | union-widening grep guard: no stale `=== 'channels'`/`!== 'goal'` literal-inequality after adding steps (assert step list + last-step-is-approval) | +2 |
| Unit | draft-store `sanitizeVoice`/`sanitizeApprovalRules`: round-trip, malformed→empty, `requireApprovalBeforePublish:false`→read-back `true` | +4 |
| Unit | `applyDraftMutation` carries `voice`/`approvalRules`; absent mutation preserves prior; source-change reset does not nuke voice | +3 |
| Unit | `LocalDraftSnapshot` v2: a stored v1 snapshot is discarded (version bump), a v2 snapshot rehydrates voice/approval | +2 |
| Route | draft PATCH accepts `voice`/`approvalRules`, ignores malformed, GET returns them | +3 |
| Route/integration | resume composes `brandVoice` from tone+notes and `mustAvoidAesthetics` from wordsToAvoid; OFF flag yields today's exact payload | +3 |
| Integration | `buildBrandKitPayload` produces `voice` containing the tone and `must_avoid_aesthetics` containing the words (proves the existing seam carries the new signal) | +2 |
| Integration | `updateBusinessProfileWithDiagnostics` persists `words_to_avoid`/`approval_rules` and the view projects them | +2 |
| Live-DB | fresh-tenant resume insert + first-job start with voice/approval against the real DB (precedent: `tests/onboarding-materialization-claim.test.ts`) | +1 |
| E2E (live, manual) | full flag-ON wizard → rendered 7 steps → rendered voice-shaped first plan → rendered approver on profile | manual |

**~28 automated + 1 manual.** New test files added to `scripts/verify-regression-suite.mjs`. All tests set `APP_BASE_URL=https://aries.example.com`. Run `npm run guardrails:agent`, then `npm run verify`, then `npm run test:concurrent` before ship (touches routes + backend + wizard).

## Resumability / idempotency

- **Schema:** additive + idempotent (`ADD COLUMN IF NOT EXISTS … DEFAULT`). Reverse: `ALTER TABLE … DROP COLUMN voice` etc. No data loss; pre-existing drafts/profiles read the empty defaults.
- **Draft autosave** already debounces and is last-write-wins per field; the new fields join that path unchanged.
- **Resume materialization** keeps its existing CAS claim (`claimOnboardingDraftMaterialization`) and its error→`ready_for_auth` reset (`resume/page.tsx:173-176`), so a failure mid-handoff is retried cleanly; the new fields are read fresh from the claimed draft each attempt.
- **Column skew during deploy:** the draft-store's existing `42703` fallback (`shouldUseFallbackDraftStore`) already covers a half-applied migration — intake never hard-fails.

## Rollout

1. Land A (dark: columns + plumbing, flag OFF) — invisible, low-risk, deploy first.
2. Land B+C+D behind the OFF flag — UI + wiring present but unreachable in prod.
3. Flip `ARIES_ONBOARDING_VOICE_POLICY_ENABLED=1` for a single live E2E on a fresh test tenant; verify rendered flow + rendered voice-shaped first plan + rendered approver.
4. Keep ON for prod only after the rendered checks pass. Kill switch: set the flag to `0` — the wizard instantly reverts to five steps and the resume handoff to today's exact payload, with zero schema change.

## Out of Scope

- **Enforcing approval rules in the publish path.** This plan persists + surfaces `approvalRules`; it does not change the publish gate (the existing approval-gated pipeline already blocks autonomous publish). Enforcement (`alwaysApprove` categories actually blocking dispatch) is roadmap #14 / Review Queue v2 follow-up.
- **A new Hermes contract field for `goodExamples`/`badExamples`.** v1 stores them (durable, feeds the memory screen) and passes `voiceExamples` in the payload; Hermes may ignore it until a separate Hermes-side change consumes it. No Aries-side dependency on that.
- **Role/approver model beyond a single named approver.** Multi-approver routing, approver roles, and delegation are roadmap #14.
- **The "What Aries knows" memory screen** (#4) that will later read these voice/approval facts — separate plan; this plan only makes the facts exist.
- **Brand-palette / typography redesign** of the wizard (roadmap #5) — visual restyle is a separate effort; this plan reuses the current wizard chrome.
- **Demo-tenant / public 5-minute flow** (#2) — this is the authenticated setup wizard, not the public demo.
- **Editing voice/approval after onboarding** from a settings screen — the business-profile PATCH route can carry the fields, but a dedicated post-onboarding voice editor is follow-up.

## Risks

- **Union-widening literal-inequality bugs.** Adding `StepKey` members has bitten this repo's pattern before (CLAUDE.md memory, shipped 3× in v0.1.11.x). Mitigation: grep every `=== '<step>'` / `!== '<step>'` and `currentStep.key === …` branch after the widen; the +2 grep-guard unit tests assert the step list and that the last step is `approval`.
- **Autosave / localStorage version drift.** Bumping `LOCAL_DRAFT_VERSION` from 1 to 2 must discard v1 snapshots, not mis-read them into the new shape. Covered by the v1-discard unit test.
- **Two-source approver drift.** `approverName` exists in the `business` step today; moving/mirroring it into the `approval` step risks two diverging inputs. Mitigation: one source of truth (relocate, do not duplicate a writable field).
- **Operator perceives an auto-publish toggle.** The approval card must read as a guarantee, never an off-switch; `requireApprovalBeforePublish` is sanitized to `true` on read. Guardrail: nothing publishes without human approval.
- **Deploy-skew column errors.** Mitigated by the existing `42703` fallback in the draft store; the new `business_profiles` columns are written inside the same transaction as the profile upsert, so a missing column there would surface as a profile-write error — keep the migration ahead of the code deploy (land A first).
- **Required-field creep blocking intake.** Voice is intentionally optional (never blocks finish); only the approver name is required, matching the safety framing. Do not make tone/examples mandatory — an empty voice must degrade to today's scraper-inferred plan.
