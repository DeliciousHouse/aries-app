/**
 * Regressions for the four defects reported from the live customer demo:
 *
 *   1. "Business type" reads as a legal-entity question (LLC / L3C / S-corp).
 *   2. Required fields are unmarked while optional ones are labelled "(Optional)",
 *      which inverts the signal.
 *   3. Input entered before account creation was lost, and the user "looped back
 *      to the set up your site thing".
 *   4. Account creation produced a bare server error with no quotable reference.
 *
 * These are source-assertion tests, matching the idiom already used by
 * tests/onboarding-resume.test.ts and its neighbours.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

function read(...segments: string[]): string {
  return readFileSync(path.join(PROJECT_ROOT, ...segments), 'utf8');
}

/**
 * Strip line and block comments so "must not call X" assertions are not
 * satisfied or defeated by prose. Several of the changes here are explained in
 * comments that necessarily name the removed call.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const onboardingFlow = read('frontend', 'aries-v1', 'onboarding-flow.tsx');
const resumePage = read('app', 'onboarding', 'resume', 'page.tsx');
const businessFieldCopy = read('frontend', 'aries-v1', 'business-field-copy.ts');
const signUpForm = read('frontend', 'auth', 'sign-up-form.tsx');
const businessProfile = read('backend', 'tenant', 'business-profile.ts');

// ---------------------------------------------------------------- item 1

test('demo item 1: the business-type field is no longer named in a way that reads as a legal entity', () => {
  // The literal label is what the user misread as "LLC / L3C / S corp".
  assert.doesNotMatch(onboardingFlow, /label="Business type"/);
  assert.match(businessFieldCopy, /label: 'Industry'/);

  // The hint must explicitly disclaim legal structure — that is the whole point.
  assert.match(businessFieldCopy, /not your legal structure/i);

  // The wizard renders the shared copy rather than re-inventing a label.
  assert.match(onboardingFlow, /label=\{BUSINESS_TYPE_FIELD\.label\}/);
  assert.match(onboardingFlow, /hint=\{BUSINESS_TYPE_FIELD\.hint\}/);
});

test('demo item 1: the rename is display-only — the persisted key stays businessType', () => {
  // `business_type` is load-bearing across the DB column, the marketing job
  // payload and the lobster scripts. Renaming the storage key would be a
  // migration, not a copy fix.
  assert.match(onboardingFlow, /businessType,/);
  assert.match(resumePage, /businessType: claim\.draft\.businessType/);
});

test('demo item 1: the field keeps driving channel recommendations, so it must stay an industry signal', () => {
  // If this ever became a "goals" field the recommender would silently fall
  // back to the generic mix — the reason the literal "business goals" rename
  // was not applied.
  assert.match(onboardingFlow, /function recommendedChannelsForBusinessType/);
  assert.match(onboardingFlow, /recommendedChannelsForBusinessType\(businessType\)/);
  // The goal is a separate, already-existing step.
  assert.match(onboardingFlow, /key: 'goal'/);
});

// ---------------------------------------------------------------- item 2

test('demo item 2: the Field primitive can mark required, not only optional', () => {
  assert.match(onboardingFlow, /required\?: boolean;/);
  assert.match(onboardingFlow, /\{props\.required \? \([\s\S]*?Required/);
});

test('demo item 2: every field the step gate actually requires is visibly marked', () => {
  // stepReady() requires businessName + businessType + websiteUrl + offer.
  for (const marker of [
    /label=\{BUSINESS_NAME_FIELD\.label\}[\s\S]{0,220}?required/,
    /label=\{BUSINESS_TYPE_FIELD\.label\}[\s\S]{0,220}?required/,
    /label="Current source"[\s\S]{0,320}?required/,
    /label="Website"[\s\S]{0,320}?required/,
    /label="Offer summary"[\s\S]{0,320}?required/,
  ]) {
    assert.match(onboardingFlow, marker);
  }
});

test('demo item 2: signup stops marking only the optional field', () => {
  // Organization was the ONLY annotated field, so the three genuinely required
  // ones read as optional by omission.
  assert.match(signUpForm, /Organization \(Optional\)/);
  for (const label of ['Full Name', 'Email Address', 'Password']) {
    const pattern = new RegExp(`${label}<span[^>]*>Required</span>`);
    assert.match(signUpForm, pattern, `${label} must carry a visible Required marker`);
  }
});

// ---------------------------------------------------------------- item 3

test('demo item 3: submitting no longer discards the local snapshot before the next hop succeeds', () => {
  // clearLocalDraft() used to run immediately before router.push(). If the
  // resume hop then failed, the user had nothing left: the server draft is
  // unreachable once `?draft=` is lost, because onboarding_drafts has no owner.
  const finish = stripComments(onboardingFlow).match(/async function handleFinish\(\)[\s\S]*?\n  \}\n/);
  assert.ok(finish, 'expected handleFinish()');
  assert.doesNotMatch(finish[0], /clearLocalDraft\(\)/);
  assert.match(finish[0], /submittingRef\.current = true/);
});

test('demo item 3: an empty server draft cannot blank a populated form', () => {
  // A draft is created eagerly on mount, so "a draft exists" and "a draft has
  // content" are different questions; applying an empty draft's fields raced
  // the profile hydrate and wiped it.
  assert.match(onboardingFlow, /function serverDraftHasContent/);
  assert.match(onboardingFlow, /if \(!serverDraftHasContent\(draft\)\) \{/);
});

test('demo item 3: profile hydration is gated on the URL draft, not the eagerly-created one', () => {
  // Gating on draftId meant the eager create-draft effect always won the race
  // and an authenticated user returning to /onboarding/start got a blank wizard.
  assert.match(
    onboardingFlow,
    /if \(!props\.initialAuthenticated \|\| profileHydrated \|\| draftParam\) \{/,
  );
  assert.doesNotMatch(
    onboardingFlow,
    /if \(!props\.initialAuthenticated \|\| profileHydrated \|\| draftId\) \{/,
  );
});

test('demo item 3: authenticated users are offered their local snapshot when the profile is empty', () => {
  const resumeEffect = onboardingFlow.match(
    /\/\/ Check for local draft on mount and offer to restore\.[\s\S]*?\n  \]\);/,
  );
  assert.ok(resumeEffect, 'expected the local-draft resume effect');
  // The old code bailed out unconditionally for authenticated users.
  assert.doesNotMatch(
    resumeEffect[0],
    /if \(props\.initialAuthenticated\) \{\n\s*return;\n\s*\}/,
  );
  assert.match(resumeEffect[0], /if \(!profileHydrated\)/);
});

test('demo item 3: the local backup is not deleted while the resume prompt is still open', () => {
  // On mount every field is empty, so the 500ms trailing local-save tick used
  // to fire with an empty snapshot and hit the clearLocalDraft() branch —
  // erasing the backup roughly half a second after the dialog told the user it
  // existed, and leaving that dialog backed only by in-memory state.
  const localSave = onboardingFlow.match(
    /\/\/ localStorage fallback: write a debounced snapshot[\s\S]*?\n  \]\);/,
  );
  assert.ok(localSave, 'expected the localStorage fallback effect');
  assert.match(localSave[0], /if \(!resumeChecked \|\| resumePromptOpen\) return;/);
  assert.match(localSave[0], /resumeChecked,\n\s*resumePromptOpen,/);
});

test('demo item 3: the handoff failure screen hands the draft id back to the user', () => {
  const failed = read('app', 'onboarding', 'resume', 'failed.tsx');
  assert.match(failed, /\/onboarding\/start\?draft=\$\{encodeURIComponent\(draftId\)\}/);
  assert.match(failed, /\/onboarding\/resume\?draft=\$\{encodeURIComponent\(draftId\)\}/);
  assert.match(failed, /Everything you entered is saved/);
});

// ---------------------------------------------------------------- item 4

test('demo item 4: the app ships root error boundaries', () => {
  assert.ok(existsSync(path.join(PROJECT_ROOT, 'app', 'error.tsx')), 'app/error.tsx must exist');
  assert.ok(
    existsSync(path.join(PROJECT_ROOT, 'app', 'global-error.tsx')),
    'app/global-error.tsx must exist',
  );
});

test('demo item 4: every error surface exposes a quotable reference', () => {
  const surface = read('frontend', 'errors', 'error-surface.tsx');
  assert.match(surface, /error\.digest/);
  assert.match(surface, /data-testid="error-reference"/);
  // Selectable, so it survives a screenshot even if the clipboard is blocked.
  assert.match(surface, /select-all/);

  const globalError = read('app', 'global-error.tsx');
  assert.match(globalError, /error\.digest/);

  const failed = read('app', 'onboarding', 'resume', 'failed.tsx');
  assert.match(failed, /data-testid="error-reference"/);
});

test('demo item 4: a failed onboarding handoff renders a recovery screen instead of rethrowing', () => {
  // Rethrowing here is what produced the demo's bare server error: the user had
  // just created an account and the whole render blew up.
  assert.match(resumePage, /return <OnboardingResumeFailed draftId=\{draftId\} reference=\{reference\}/);
  assert.match(resumePage, /function logOnboardingResumeFailure/);

  // The NEXT_REDIRECT rethrow must survive — redirect() is control flow.
  assert.match(resumePage, /digest\.startsWith\('NEXT_REDIRECT'\)/);

  // ...but the only remaining `throw error` in the materialization catch is
  // that redirect passthrough. Anchor on the NEXT_REDIRECT guard so this does
  // not accidentally match the unrelated transaction catch further up the file.
  const catchStart = resumePage.indexOf("digest.startsWith('NEXT_REDIRECT')");
  assert.notEqual(catchStart, -1, 'expected the materialization catch block');
  const catchBlock = stripComments(resumePage.slice(catchStart));
  const throws = catchBlock.match(/throw error;/g) ?? [];
  assert.equal(throws.length, 1, 'only the NEXT_REDIRECT passthrough may rethrow');
});

test('demo item 4: an unreachable customer website cannot cost a new signup their workspace', () => {
  // brand_kit_fetch_failed:site_unavailable thrown from persistBrandKitIfNeeded
  // is the failure actually observed in the deployment logs.
  assert.match(businessProfile, /tolerateFetchFailure/);
  assert.match(businessProfile, /tolerateBrandKitFailure\?: boolean;/);
  assert.match(resumePage, /tolerateBrandKitFailure: true/);
});

test('demo item 4: signup errors are not auto-dismissed on a timer', () => {
  // The banner erased itself after 3s. That is literally why the reported
  // "server error" could not be read in time.
  const code = stripComments(signUpForm);
  assert.doesNotMatch(code, /setTimeout\([\s\S]{0,60}setErrorLocal\(null\)/);
  assert.match(signUpForm, /aria-label="Dismiss error"/);
  assert.match(signUpForm, /aria-live="assertive"/);
});

test('demo item 4: a failed registration returns a reference, not the raw driver error', () => {
  const auth = read('app', 'actions', 'auth.ts');
  assert.doesNotMatch(stripComments(auth), /error: err\.message/);
  assert.match(auth, /const reference = `ARS-\$\{crypto\.randomUUID\(\)/);
  assert.match(auth, /reference,\s*\n\s*\};/);
  // The real error must still reach the log, keyed by the same reference.
  assert.match(auth, /console\.error\('Registration error:', \{\s*\n\s*reference,/);
});

test('demo item 4: transport failures of the register action do not show framework text', () => {
  // The deployment logs are full of "Failed to find Server Action <id>", which
  // is what a tab left open across a redeploy produces.
  assert.doesNotMatch(stripComments(signUpForm), /setErrorLocal\(error instanceof Error \? error\.message/);
  assert.match(signUpForm, /could not reach the server to finish signing you up/);
});

// ------------------------------------------------- funnel dead-ends

test('signing up with the optional Organization field cannot paywall the first workspace', () => {
  // registerUserAction creates an org + ACTIVE tenant_admin membership when the
  // optional field is filled. assertMultiWorkspaceEntitlement counts active
  // memberships, so on the free plan that stub made the user's FIRST workspace
  // look like a second one and redirected them to the upgrade screen straight
  // after signup. ARIES_MULTI_WORKSPACE_ENABLED=1 in the deployment, so this
  // was live.
  assert.match(resumePage, /async function findReusableStubTenant/);
  // The reuse must be attempted BEFORE the entitlement gate, or it cannot help.
  const stubAt = resumePage.indexOf('findReusableStubTenant(client, input.userId)');
  const gateAt = resumePage.indexOf('assertMultiWorkspaceEntitlement(client, input.userId)');
  assert.notEqual(stubAt, -1);
  assert.notEqual(gateAt, -1);
  assert.ok(stubAt < gateAt, 'stub reuse must run before the entitlement gate');
});

test('stub reuse cannot escalate a role or hijack a shared organization', () => {
  const helper = resumePage.match(/async function findReusableStubTenant[\s\S]*?\n\}/);
  assert.ok(helper, 'expected findReusableStubTenant');
  // Exactly one active membership...
  assert.match(helper[0], /memberships\.rows\.length !== 1/);
  // ...already tenant_admin (never an elevation)...
  assert.match(helper[0], /row\.role !== 'tenant_admin'/);
  // ...sole active member (never a hijack)...
  assert.match(helper[0], /user_id <> \$2/);
  // ...and never onboarded.
  assert.match(helper[0], /tenantIsReusable\(organizationId\)/);
});

test('the signup "Sign In" link is not a closed redirect loop', () => {
  // /login bounced draftSaved=1 traffic to /signup, and signup's sign-in link
  // carried draftSaved=1 — so a returning customer who completed the intake
  // anonymously could never reach the sign-in form.
  const loginPage = read('app', 'login', 'page.tsx');
  assert.match(loginPage, /const wantsLoginForm = firstParamValue\(resolvedParams\.intent\) === 'login'/);
  assert.match(loginPage, /if \(!wantsLoginForm && draftSaved === '1'/);

  const signupClient = read('app', 'signup', 'page-client.tsx');
  assert.match(signupClient, /params\.set\('intent', 'login'\)/);
});

test('a disabled advance button always states what is missing', () => {
  // Clicking a disabled button cannot surface a reason, so the message must be
  // rendered proactively rather than only on click.
  assert.match(onboardingFlow, /const blockingRequirement = currentStepIsReady/);
  assert.match(onboardingFlow, /\{error \|\| blockingRequirement \? \(/);
  assert.match(onboardingFlow, /aria-describedby=\{error \|\| blockingRequirement \? 'onboarding-advance-blocker' : undefined\}/);
});

test('a custom goal is persisted server-side, not only in localStorage', () => {
  // Autosave sent the literal string "Other"; the typed text only reached the
  // server at final submit.
  assert.match(onboardingFlow, /goal: goal === 'Other' \? customGoal\.trim\(\) : goal,/);
  const autosaveDeps = onboardingFlow.match(/loadedDraftId,\n\s*markSaved,\n\s*\]\);/);
  assert.ok(autosaveDeps, 'expected the autosave dependency array');
  assert.match(onboardingFlow, /competitorUrl,\n\s*customGoal,\n\s*draftId,/);
});

// ------------------------------------------------- second pass: remaining audit findings

test('the required-offer field on the first screen is marked', () => {
  // The goal step is the first screen a new user sees. "What does your business
  // offer?" is hard-required by stepReady, yet the only annotation on the screen
  // was the "(optional)" on Competitor website just below it.
  assert.match(stripComments(onboardingFlow), /What does your business offer\?[\s\S]{0,400}?Required/);
  assert.match(onboardingFlow, /id="onboarding-core-offer"[\s\S]{0,240}?aria-required="true"/);
});

test('the step rail reflects validity, not how far the user has walked', () => {
  // `index < stepIndex` put green checks on steps a deep link or Back/Forward
  // had skipped, while the finish button stayed disabled — the rail actively
  // contradicted the button.
  assert.doesNotMatch(stripComments(onboardingFlow), /const complete = index < stepIndex;/);
  assert.match(onboardingFlow, /const stepIsValid = stepReady\(step\.key, \{/);
  assert.match(onboardingFlow, /const complete = stepIsValid && !active;/);
  // State is not conveyed by colour alone, and the rail is navigable.
  assert.match(onboardingFlow, /<span className="sr-only">Incomplete<\/span>/);
  assert.match(onboardingFlow, /aria-current=\{active \? 'step' : undefined\}/);
});

test('a failed draft load does not permanently disable saving', () => {
  // The catch used to leave loadedDraftId null forever, and the autosave guard
  // `loadedDraftId !== draftId` then blocked every server save for the rest of
  // the session — silently, since SaveIndicator renders nothing for 'idle'.
  assert.match(onboardingFlow, /draftApiFailedRef\.current = true;\s*\n\s*setLoadedDraftId\(draftId\);/);
  assert.match(onboardingFlow, /kept in this browser/);
});

test('the local snapshot is reachable when the server draft is empty', () => {
  // ?draft= is written into the URL on mount, so early-returning on its mere
  // presence made the local backup unreachable in exactly the case it exists
  // for: an empty or failed server draft.
  assert.match(onboardingFlow, /if \(loadedDraftId !== draftParam\) \{/);
  assert.match(onboardingFlow, /const serverHasContent = Boolean\(/);
});

test('API error codes are never rendered raw to the user', () => {
  const copy = read('frontend', 'aries-v1', 'customer-safe-copy.ts');
  assert.match(copy, /export function profileApiErrorMessage/);
  // Unmapped snake_case codes fall back rather than leaking.
  assert.match(copy, /\^\[a-z0-9\]\+\(_\[a-z0-9\]\+\)\+\$/);
  for (const code of ['brand_kit_fetch_failed', 'draft_not_found', 'onboarding_draft_unavailable']) {
    assert.ok(copy.includes(code), `${code} must map to customer-facing copy`);
  }

  // Every surface that used to render the raw message now routes through it.
  assert.match(onboardingFlow, /profileApiErrorMessage\(/);
  assert.match(read('frontend', 'aries-v1', 'business-profile-screen.tsx'), /profileApiErrorMessage\(/);
  assert.match(read('frontend', 'aries-v1', 'settings-screen.tsx'), /profileApiErrorMessage\(/);
});

test('settings save reports success and failure instead of discarding the result', () => {
  const settings = read('frontend', 'aries-v1', 'settings-screen.tsx');
  assert.match(settings, /async function runProfileSave\(/);
  assert.match(settings, /setSaveFeedback\(\{ kind: 'success'/);
  assert.match(settings, /setSaveFeedback\(\{\s*\n\s*kind: 'error'/);
  assert.match(settings, /aria-live="polite"/);
  // Both buttons surface it.
  const feedbackMounts = settings.match(/\{saveFeedbackNode\}/g) ?? [];
  assert.equal(feedbackMounts.length, 2, 'both save buttons must show feedback');
});

test('brand-kit fetches have a hard deadline', () => {
  // Unbounded on the onboarding critical path, and fanned out per stylesheet.
  const brandKit = read('backend', 'marketing', 'brand-kit.ts');
  assert.match(brandKit, /const BRAND_KIT_FETCH_TIMEOUT_MS = 10_000;/);
  assert.match(brandKit, /signal: AbortSignal\.timeout\(BRAND_KIT_FETCH_TIMEOUT_MS\)/);
});

test('demo item 4: interactive profile edits still surface an unreadable website as an error', () => {
  // /api/business/profile maps brand_kit_fetch_failed -> 422, which is correct
  // feedback when a user is editing the URL. Only onboarding degrades.
  assert.match(businessProfile, /if \(!options\?\.tolerateFetchFailure\) \{\s*\n\s*throw error;/);
  const profileRoute = read('app', 'api', 'business', 'profile', 'route.ts');
  assert.match(profileRoute, /brand_kit_fetch_failed/);
});
