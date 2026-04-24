# QA Report: Auth + Onboarding

Target: `https://aries.sugarandleather.com`
Date: `2026-04-24`
Scope: `/`, `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/onboarding/start`

## ISSUE-001: Homepage ships with three failing resources on first paint
- Severity: High
- Category: Console
- Page/URL: `https://aries.sugarandleather.com/`
- What I saw: The public homepage loaded, but the browser console immediately logged three failed resource loads with `502` responses.
- Repro:
1. Open `/`.
2. Wait for the page to finish loading.
3. Inspect browser console errors.
- Expected vs Actual: Expected a clean public landing page load. Actual behavior logged three `Failed to load resource` errors on first paint.
- Evidence: Console log excerpt: `Failed to load resource: the server responded with a status of 502 ()` x3. Screenshot: `/tmp/qa-auth-onboarding/homepage.png`

## ISSUE-002: Login route intermittently returns a blank shell after a `502`
- Severity: High
- Category: Functional
- Page/URL: `https://aries.sugarandleather.com/login`
- What I saw: Repeated browser loads of `/login` were unstable. One run returned `GET /login → 502`, and the page rendered with no accessible elements.
- Repro:
1. Open `/login`.
2. Refresh or reload until the unstable response occurs.
3. Observe the blank page and failed network entry.
- Expected vs Actual: Expected `/login` to render the sign-in form consistently. Actual behavior intermittently produced a blank shell after a `502`.
- Evidence: Network log excerpt: `GET https://aries.sugarandleather.com/login → 502`. Screenshot: `/tmp/qa-auth-onboarding/login-wrong-password.png`

## ISSUE-003: Wrong-password login never resolves
- Severity: Critical
- Category: Functional
- Page/URL: `https://aries.sugarandleather.com/login`
- What I saw: Submitting a known account with the wrong password left the form stuck in `Signing in...` with the credentials callback request still pending.
- Repro:
1. Open `/login`.
2. Enter `qa-video-1777014617@aries-test.local`.
3. Enter a wrong password and submit.
4. Wait for a response.
- Expected vs Actual: Expected an inline auth error such as invalid credentials. Actual behavior left the request pending and never surfaced an error state.
- Evidence: Network log excerpt: `POST https://aries.sugarandleather.com/api/auth/callback/credentials? → pending`. Screenshot: `/tmp/qa-auth-onboarding/login-wrong-password.png`

## ISSUE-004: Successful login takes roughly 15 seconds
- Severity: Medium
- Category: Performance
- Page/URL: `https://aries.sugarandleather.com/login`
- What I saw: The happy-path credential login eventually succeeded, but the auth callback took `14559ms` before the app redirected to `/dashboard`.
- Repro:
1. Open `/login`.
2. Sign in with the shared QA credentials.
3. Inspect the credentials callback timing in the network log.
- Expected vs Actual: Expected a normal auth redirect in a few seconds. Actual behavior took about 14.6 seconds before redirecting.
- Evidence: Network log excerpt: `POST https://aries.sugarandleather.com/api/auth/callback/credentials? → 200 (14559ms, 59B)`. Screenshot: `/tmp/qa-auth-onboarding/login-happy-path.png`

## ISSUE-005: Dashboard remains half-loaded after login because core APIs never settle
- Severity: High
- Category: API
- Page/URL: `https://aries.sugarandleather.com/dashboard`
- What I saw: After the successful login, multiple dashboard bootstrap requests remained pending instead of resolving, which leaves the signed-in shell without finished data hydration.
- Repro:
1. Complete a successful login.
2. Let `/dashboard` load.
3. Inspect network requests after the route settles.
- Expected vs Actual: Expected dashboard bootstrap APIs to complete. Actual behavior left core data endpoints pending indefinitely.
- Evidence: Network log excerpt: `GET /api/marketing/campaigns`, `/api/marketing/reviews`, `/api/business/profile`, `/api/tenant/profiles`, and `/api/integrations` all remained `pending`. Screenshot: `/tmp/qa-auth-onboarding/login-happy-path.png`

## ISSUE-006: Google OAuth never leaves the login page
- Severity: Critical
- Category: Functional
- Page/URL: `https://aries.sugarandleather.com/login`
- What I saw: Clicking `Google` never redirected to `accounts.google.com`; instead the app stayed on `/login` with the Google sign-in POST hanging.
- Repro:
1. Open `/login`.
2. Click `Google`.
3. Wait for navigation.
- Expected vs Actual: Expected a redirect to Google’s identifier page with the provider params present. Actual behavior stayed on `/login` with the auth request pending.
- Evidence: Network log excerpt: `POST https://aries.sugarandleather.com/api/auth/signin/google? → pending`. Screenshot: `/tmp/qa-auth-onboarding/login-google-oauth.png`

## ISSUE-007: Existing-email signup hangs instead of returning “already registered”
- Severity: Critical
- Category: Functional
- Page/URL: `https://aries.sugarandleather.com/signup`
- What I saw: Submitting the signup form with the existing QA email left the page stuck in `Creating account…` and the POST to `/signup` never completed.
- Repro:
1. Open `/signup`.
2. Enter a name, the existing QA email, and a valid password.
3. Submit the form.
4. Wait for a response.
- Expected vs Actual: Expected a fast inline “already registered” error. Actual behavior left the form spinning forever with the signup POST pending.
- Evidence: Network log excerpt: `POST https://aries.sugarandleather.com/signup → pending`. Screenshot: `/tmp/qa-auth-onboarding/signup-existing-email.png`

## ISSUE-008: Forgot-password submission never reaches a confirmation state
- Severity: Critical
- Category: Functional
- Page/URL: `https://aries.sugarandleather.com/forgot-password`
- What I saw: Submitting the shared QA email left the CTA in `Sending Code...` with the reset request still pending; the flow never reached any confirmation screen.
- Repro:
1. Open `/forgot-password`.
2. Enter the shared QA email.
3. Submit the form.
4. Wait for the flow to advance.
- Expected vs Actual: Expected a successful transition to a confirmation state. Actual behavior hung on the same screen.
- Evidence: Network log excerpt: `POST https://aries.sugarandleather.com/api/auth/forgot-password → pending`. Screenshot: `/tmp/qa-auth-onboarding/forgot-password-submit.png`

## ISSUE-009: Forgot-password flow is wired to the reset form instead of an email-sent confirmation
- Severity: High
- Category: UX
- Page/URL: `https://aries.sugarandleather.com/forgot-password`
- What I saw: Even ignoring the hanging POST above, the deployed client is designed to send users directly to `/reset-password?email=...` rather than an email-sent confirmation state.
- Repro:
1. Open `/forgot-password`.
2. Review the flow expectations in the product spec versus the current behavior.
3. Compare with the deployed reset-password page entrypoint.
- Expected vs Actual: Expected a confirmation page after submission. Actual behavior is coupled to a direct reset-form transition, so there is no dedicated confirmation state in the shipped flow.
- Evidence: Functional evidence from the stuck forgot-password submit plus client wiring in [`app/forgot-password/page-client.tsx`](/home/node/.worktrees/aries-app/aa-29/app/forgot-password/page-client.tsx:13)

## ISSUE-010: `/reset-password` without context renders a dead-end shell
- Severity: High
- Category: UX
- Page/URL: `https://aries.sugarandleather.com/reset-password`
- What I saw: Opening `/reset-password` without any query params produced a non-interactive screen instead of a clear invalid-token or expired-link state.
- Repro:
1. Open `/reset-password`.
2. Wait for the page to settle.
3. Inspect the rendered UI.
- Expected vs Actual: Expected a clear “invalid or expired reset link” message with recovery guidance. Actual behavior rendered a dead-end shell with no usable controls.
- Evidence: Screenshot: `/tmp/qa-auth-onboarding/reset-password-no-token.png`

## ISSUE-011: Reset form is accessible with only `?email=...` and no reset token
- Severity: High
- Category: Functional
- Page/URL: `https://aries.sugarandleather.com/reset-password?email=qa-video-1777014617@aries-test.local`
- What I saw: Adding only an `email` query parameter exposes the full reset form with code and password inputs, even though there is no tokenized link validation at route entry.
- Repro:
1. Open `/reset-password?email=qa-video-1777014617@aries-test.local`.
2. Observe the rendered form.
- Expected vs Actual: Expected the route to require a valid reset token or show an invalid-link state. Actual behavior renders the reset form for any email query string.
- Evidence: Screenshot: `/tmp/qa-auth-onboarding/reset-password-email-only.png`

## ISSUE-012: Invalid reset code submission hangs indefinitely
- Severity: Critical
- Category: Functional
- Page/URL: `https://aries.sugarandleather.com/reset-password?email=qa-video-1777014617@aries-test.local`
- What I saw: Submitting a bogus `000000` code with a valid replacement password left the CTA in `Updating...` and the reset API request pending.
- Repro:
1. Open the reset form with an `email` query string.
2. Enter `000000` as the code and a policy-compliant password.
3. Submit the form.
4. Wait for a response.
- Expected vs Actual: Expected an immediate invalid-code error. Actual behavior hung with the reset request still pending.
- Evidence: Network log excerpt: `POST https://aries.sugarandleather.com/api/auth/reset-password → pending`. Screenshot: `/tmp/qa-auth-onboarding/reset-password-invalid-code.png`

## ISSUE-013: Goal step lets an invalid competitor URL through to later steps
- Severity: Medium
- Category: Functional
- Page/URL: `https://aries.sugarandleather.com/onboarding/start`
- What I saw: On step 1, I could enter a non-URL competitor value and still progress later in the flow because step gating only checks goal + offer, not competitor validity.
- Repro:
1. Open `/onboarding/start`.
2. Select a goal.
3. Type a valid business-offer description.
4. Enter `notaurl` into the competitor field.
5. Observe that the field does not stop forward progress at the step level.
- Expected vs Actual: Expected invalid competitor input to block progression or show an inline validation error before continuing. Actual behavior deferred validation and allowed the step to appear complete.
- Evidence: Screenshot: `/tmp/qa-auth-onboarding/onboarding-goal-invalid-competitor.png`; implementation path in [`frontend/aries-v1/onboarding-flow.tsx`](/home/node/.worktrees/aries-app/aa-29/frontend/aries-v1/onboarding-flow.tsx:1196)

## ISSUE-014: Business step accepts an invalid “Current source” URL and still enables Continue
- Severity: High
- Category: Functional
- Page/URL: `https://aries.sugarandleather.com/onboarding/start?draft=test&step=business`
- What I saw: On the business step, after entering a business name and type, I could type `notaurl` into `Current source` and `Continue` still became enabled.
- Repro:
1. Open the business step.
2. Enter any business name and business type.
3. Enter `notaurl` into `Current source`.
4. Check the Continue button state.
- Expected vs Actual: Expected the current-source field to participate in step validation. Actual behavior enabled `Continue` even with an invalid source URL.
- Evidence: JS state capture: `continueDisabled=false` with `Current source=notaurl`. Screenshot: `/tmp/qa-auth-onboarding/onboarding-business-long-name-invalid-source.png`

## ISSUE-015: Business name field has no practical length guard
- Severity: Medium
- Category: UX
- Page/URL: `https://aries.sugarandleather.com/onboarding/start?draft=test&step=business`
- What I saw: The `Business name` field accepted a 300-character string with no truncation, no counter, and no warning.
- Repro:
1. Open the business step.
2. Paste a 300-character business name.
3. Observe field acceptance and the lack of any validation feedback.
- Expected vs Actual: Expected a clear upper bound or inline feedback for unusably long business names. Actual behavior accepted all 300 characters silently.
- Evidence: JS state capture: `nameLen=300`. Screenshot: `/tmp/qa-auth-onboarding/onboarding-business-long-name-invalid-source.png`

## ISSUE-016: Wizard steps can be deep-linked directly via `?step=...`
- Severity: Medium
- Category: UX
- Page/URL: `https://aries.sugarandleather.com/onboarding/start?draft=test&step=business`
- What I saw: The onboarding flow accepted direct `step` query parameters and rendered later steps without requiring prior completion, which makes it easy to bypass wizard order.
- Repro:
1. Open `/onboarding/start?draft=test&step=business`.
2. Observe that step 2 renders immediately.
3. Repeat with other valid step names.
- Expected vs Actual: Expected later steps to require prior-step completion or redirect back to the first incomplete step. Actual behavior trusts the URL param and renders later steps directly.
- Evidence: Screenshot: `/tmp/qa-auth-onboarding/onboarding-business-long-name-invalid-source.png`; implementation path in [`frontend/aries-v1/onboarding-flow.tsx`](/home/node/.worktrees/aries-app/aa-29/frontend/aries-v1/onboarding-flow.tsx:117)

## Summary
- Critical: 5
- High: 7
- Medium: 4
- Low: 0
- Cosmetic: 0
- Overall health: 28/100

Primary blockers are the hanging auth POSTs, missing/incorrect reset-password states, and onboarding validation gaps that let invalid source data move forward.
