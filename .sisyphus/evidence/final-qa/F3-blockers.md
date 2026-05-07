# F3 Real Manual QA — Blocker Evidence

Date: 2026-05-06
Gate: F3. Real Manual QA — Final Verification Wave
Plan: weekly-social-content-pipeline.md

## What is required

The F3 gate requires running the complete weekly social content E2E flow against
a clean local instance with real test credentials, per the smoke driver
`scripts/smoke-weekly-pipeline.mjs` (T28). The 14 enforced steps are:

```
1.  signup new test tenant
2.  submit business profile via /api/onboarding
3.  connect Meta using test app token        <-- requires META_TEST_*
4.  trigger /api/social-content/jobs
5.  poll runtime state until plan_review     <-- requires Hermes test env
6.  auto-approve plan
7.  wait for creative_review                 <-- requires Hermes test env
8.  auto-approve creatives
9.  wait for publish_review                  <-- requires Hermes test env
10. auto-approve publish
11. wait for completed
12. assert posts.platform_post_id captured
13. Graph API GET round-trip 200             <-- requires META_TEST_*
14. dashboard image rendering (naturalWidth > 0)
```

## Local environment probe

| Prerequisite                       | Status                                  |
|------------------------------------|-----------------------------------------|
| Local app on :3000                 | RUNNING (HTTP 200, signup page loads)   |
| `.env.test` file present           | MISSING                                 |
| `META_TEST_PAGE_ID`                | MISSING (not in `.env`, not in shell)   |
| `META_TEST_PAGE_ACCESS_TOKEN`      | MISSING (not in `.env`, not in shell)   |
| `OAUTH_TOKEN_ENCRYPTION_KEY`       | present in `.env`                       |
| `APP_BASE_URL` (test target)       | `.env` points at production URL         |
| `DB_*` (test database)             | `.env` values; not confirmed test-only  |
| Hermes test environment            | not confirmed reachable for callbacks   |

The smoke script does not load `.env`; it only loads `.env.test` or shell env.
This is the deliberate isolation contract from T28 to prevent production Meta
credential leakage. The script source-bans the production `META_PAGE_ID` /
`META_ACCESS_TOKEN` env names and refuses to soft-fail.

## Smoke driver attempt (captured)

Command (no skip flags, no soft-fail):

```
node scripts/smoke-weekly-pipeline.mjs \
  --tenant smoke_qa_<ts> --website https://example.com --auto-approve
```

Exit code: 1.
First failure line:

```
FAIL step 0 — [step 0] Missing required env: APP_BASE_URL, DB_HOST, DB_PORT,
DB_USER, DB_PASSWORD, DB_NAME, META_TEST_PAGE_ID,
META_TEST_PAGE_ACCESS_TOKEN, OAUTH_TOKEN_ENCRYPTION_KEY
```

Full log: `.sisyphus/evidence/final-qa/smoke-attempt.log`.

## Manual browser probe (captured)

`browse goto http://localhost:3000/signup` returned 200 and rendered the
"Create Account" form (Full Name, Organization, Email Address, Password,
Create account button). Screenshot: `.sisyphus/evidence/final-qa/local-signup.png`.

This proves the local app boots and serves the signup screen. It does NOT
satisfy the F3 contract because steps 3-14 cannot be exercised without the
listed test credentials and a live Hermes test environment.

## Why the gate cannot be approved

The F3 task explicitly forbids:
- using production Meta credentials,
- adding skip flags or soft-fail behavior,
- editing files to make QA pass.

The required test prerequisites are absent in this environment. Approving
without exercising steps 3-14 (Meta connect, IG connect, plan generation,
creative regeneration, upload replace, caption edit, reschedule, approve,
publish confirm, `platform_post_id` capture, Graph round-trip, image render,
cross-tenant isolation) would be guessing, which the task instructs against.

## What unblocks F3

1. Provision `.env.test` with: `APP_BASE_URL` (local instance), `DB_*` (test
   database), `META_TEST_PAGE_ID`, `META_TEST_PAGE_ACCESS_TOKEN`,
   `OAUTH_TOKEN_ENCRYPTION_KEY`.
2. Stand up a Hermes test environment that posts authenticated callbacks to
   `${APP_BASE_URL}/api/internal/hermes/runs`.
3. Re-run `node scripts/smoke-weekly-pipeline.mjs --tenant <slug>
   --website <url> --auto-approve` and confirm 14/14 PASS.
4. Run the cross-tenant isolation manual probe (tenant B cannot see tenant A
   assets/posts/runs).
