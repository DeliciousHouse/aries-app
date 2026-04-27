# Ralph loop log — live QA 2026-04-27

## Baseline deploy

- PR #207 merged: https://github.com/DeliciousHouse/aries-app/pull/207
- Master SHA: `880e4dccaac4aa89c21c4cd68bb2027e9999d62d`
- Published image: `ghcr.io/delicioushouse/aries-app:880e4dccaac4aa89c21c4cd68bb2027e9999d62d`
- GHCR digest: `sha256:53593def30704d8a85fbdd24635168e95d773df797785706dcb43f6e6e192d01`
- Deploy workflow run: https://github.com/DeliciousHouse/aries-app/actions/runs/24972531636

## Discovery waves

### Public marketing/auth

Routes tested: `/`, `/features`, `/documentation`, `/api-docs`, `/terms`, `/privacy`, `/sitemap`, `/contact`, `/login`, `/signup`, `/forgot-password`, `/reset-password`.

Findings:
- Reset-password backend failures are silent after HTTP 400.
- Reset-password submit enables before confirm/password-policy validation passes.
- Reset-password inputs lack useful accessible names.
- Signup password visibility button is unnamed, and Organization uses placeholder as accessible name.
- Global Features links go to `/#features` while `/features` is a standalone sitemap route.
- Auth pages have no `main`; documentation has nested `main` landmarks.

### Onboarding/review/marketing job

Routes tested: `/onboarding/start`, `/onboarding`, `/onboarding/resume`, `/onboarding/status`, `/marketing/new-job`, `/marketing/job-status`, `/marketing/job-approve`, `/publish-status`, `/review`, invalid `/review/:id`, invalid `/materials/:job/:asset`.

Findings:
- Onboarding competitor field accepts Facebook URL at step 1, then blocks only on final submit.
- Job approval CTA remains enabled after unauthenticated/failed status load.
- Approve API checks job runtime before tenant/auth context, unlike status API.
- Publish status unauthenticated redirect loses callback URL.
- Invalid onboarding tenant displays top-level `onboarding_status OK` despite not-found provisioning state.

### Protected routes

Routes tested: dashboard routes and legacy aliases while unauthenticated.

Result: no route-breaking findings. Protected routes and aliases ultimately land on `/login` with HTTP 200 and no console errors.

## Story plan and resolution

- ISSUE-001: Reset password error handling, validation, and labels. PASS. Commits: `5ec2cb9`, `e23f0de`.
- ISSUE-002: Signup form accessible names. PASS. Commit: `8f2e518`.
- ISSUE-003: Public nav canonical Features link and landmark structure. PASS. Commits: `fe9beac`, `45dc5b1`.
- ISSUE-004: Onboarding competitor validation and not-found status copy. PASS. Commits: `5a0ae9d`, `84d9fb8`.
- ISSUE-005: Marketing job approval gating and approve API auth-order consistency. PASS. Commit: `fc595c0`.
- ISSUE-006: Publish-status login callback preservation. PASS. Commit: `435ef83`.

## Review loop

- ISSUE-001 initial review requested behavioral tests and safer non-string failed-response parsing. Fixed in `e23f0de`; re-review approved.
- ISSUE-002 approved with non-blocking source-test caveat.
- ISSUE-003 initial review requested labeled navigation landmarks. Fixed in `45dc5b1`; re-review approved.
- ISSUE-004 initial review requested behavioral/source-imported tests. Fixed in `84d9fb8`; re-review approved.
- ISSUE-005 approved.
- ISSUE-006 approved.

## Integration validation

Canonical checkout: `/home/node/openclaw/aries-app`.

Passed:
- `npm run workspace:verify`
- `npm run typecheck`
- Targeted 87-test QA regression suite covering reset password, signup, publish-status redirects, public nav/landmarks, onboarding validation/status, marketing approval gating, and core route pages.
- `git diff --check origin/master...HEAD`
- `npm run validate:repo-boundary`
- `npm run validate:banned-patterns`
- `npm run verify`

## Remaining caveats

- Browser vision analysis failed in this Hermes/Codex session due unsupported configured vision model, so discovery used browser snapshots, console, DOM checks, route status checks, and source lookup.
- Authenticated dashboard behavior was limited to unauthenticated redirects because no private credentials were available in the session.
- Broader `tests/frontend-api-layer.test.ts` has unrelated known marketing workspace/hydration failures when run as a full file, but the ISSUE-004 and ISSUE-005 targeted paths pass and `npm run verify` passes.
