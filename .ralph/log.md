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

## Story plan

- ISSUE-001: Reset password error handling, validation, and labels.
- ISSUE-002: Signup form accessible names.
- ISSUE-003: Public nav canonical Features link and landmark structure.
- ISSUE-004: Onboarding competitor validation and not-found status copy.
- ISSUE-005: Marketing job approval gating and approve API auth-order consistency.
- ISSUE-006: Publish-status login callback preservation.
