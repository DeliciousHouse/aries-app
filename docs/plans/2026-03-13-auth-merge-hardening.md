# Auth Merge Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove fake authentication paths, finish the OAuth connect flow, protect the app shell, and restore a safe external-Postgres Docker/runtime contract.

**Architecture:** Keep Google OAuth via NextAuth as the only live sign-in path for now. Treat placeholder email/password flows as unavailable, fix the integrations OAuth broker to use real callback origins and real tenant inputs, and enforce authentication at the shared app-shell boundary. Preserve the existing production contract of `/app` for code, `/data` for writable runtime data, and external Postgres via `DB_*` environment variables.

**Tech Stack:** Next.js 15, React 18, NextAuth/Auth.js v5 beta, PostgreSQL via `pg`, Docker multi-stage build, Docker Compose, TypeScript, Node test runner via `tsx`.

---

### Task 1: Add Regression Harness

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `tests/auth/oauth-connect.test.ts`

**Step 1: Write the failing test**
- Add a test that proves placeholder auth helpers throw instead of silently succeeding.
- Add a test that proves integrations connect requires a real tenant id and uses request/app base URL instead of `localhost`.

**Step 2: Run test to verify it fails**
- Run: `npm test -- tests/auth/oauth-connect.test.ts`
- Expected: FAIL because the current code still uses fake auth behavior and `tenant_demo_001`/`localhost` defaults.

**Step 3: Write minimal implementation**
- Add a lightweight TypeScript test runner script.
- Export small pure helpers where needed so the connect behavior can be tested without browser automation.

**Step 4: Run test to verify it passes**
- Run: `npm test -- tests/auth/oauth-connect.test.ts`
- Expected: PASS.

### Task 2: Disable Placeholder Auth UI

**Files:**
- Modify: `app/login/page.tsx`
- Modify: `frontend/auth/login-form.tsx`
- Modify: `frontend/auth/sign-up-form.tsx`
- Modify: `frontend/auth/ForgotPasswordForm.tsx`
- Modify: `frontend/services/supabase.ts`

**Step 1: Write the failing test**
- Reuse the auth helper failure test to define the unavailable state.

**Step 2: Run test to verify it fails**
- Run: `npm test -- tests/auth/oauth-connect.test.ts`

**Step 3: Write minimal implementation**
- Keep Google OAuth sign-in.
- Remove or disable email/password submit, signup submission, and password reset submission.
- Make placeholder helper methods throw a clear unavailable error instead of returning success/demo data.

**Step 4: Run test to verify it passes**
- Run targeted test, then `npm run build`.

### Task 3: Fix OAuth Connect Flow

**Files:**
- Modify: `frontend/settings/integrations.tsx`
- Modify: `app/api/integrations/connect/route.ts`
- Modify: `backend/integrations/connect.ts` if helper exports are needed
- Create: `app/api/auth/oauth/[provider]/connect/route.ts`
- Create: `app/api/auth/oauth/[provider]/disconnect/route.ts`
- Create: `app/api/auth/oauth/[provider]/reconnect/route.ts`
- Create: `app/api/auth/oauth/[provider]/callback/route.ts`

**Step 1: Write the failing test**
- Add/extend tests for callback base URL resolution, tenant enforcement, and canonical auth route behavior.

**Step 2: Run test to verify it fails**
- Run: `npm test -- tests/auth/oauth-connect.test.ts`

**Step 3: Write minimal implementation**
- Parse connect response and redirect browser to `authorization_url`.
- Resolve callback base from `APP_BASE_URL` or the incoming request origin.
- Reject missing tenant ids instead of using demo fallbacks.
- Make `/api/auth/oauth/*` the canonical namespace and keep `/api/oauth/*` as compatibility aliases.

**Step 4: Run test to verify it passes**
- Run tests, then `npm run build`.

### Task 4: Protect the App Shell

**Files:**
- Modify: `frontend/app-shell/layout.tsx`

**Step 1: Write the failing test**
- Define a small helper test only if extraction is needed; otherwise rely on fresh build verification after adding server-side auth guard.

**Step 2: Run test/build to verify current failure**
- Run: `npm run build`
- Expected: current build passes but protected pages remain anonymous; fix is behavior-level.

**Step 3: Write minimal implementation**
- Call `auth()` server-side in the shared shell layout and `redirect('/login')` for anonymous requests.

**Step 4: Run test/build to verify it passes**
- Run: `npm run build`

### Task 5: Runtime Contract and Repo Cleanup

**Files:**
- Modify: `.env.example`
- Modify: `DOCKER.md`
- Modify: `package.json`
- Possibly modify: `.gitignore`

**Step 1: Write the failing test**
- No code test needed for docs/config only; validate through command checks and file review.

**Step 2: Verify current failure**
- Run: `npm run precheck`
- Expected: documents/runtime contract gaps remain.

**Step 3: Write minimal implementation**
- Add `DB_*`, Google OAuth, and NextAuth env documentation.
- Add a `db:init` script for explicit schema provisioning.
- Add `typecheck` and `test` scripts, plus lint script if supported.
- Keep `.next/`, `.DS_Store`, and `tsconfig.tsbuildinfo` ignored.

**Step 4: Run verification**
- Run `npm test`, `npm run typecheck`, `npm run build`, `docker build -t aries-app-audit .`

### Task 6: Clean Tracked Build Artifacts

**Files:**
- Git index cleanup only

**Step 1: Verify tracked noise**
- Run: `git ls-files .next`

**Step 2: Apply minimal fix**
- Remove tracked `.next/**` and `.DS_Store` from the index without deleting working files.

**Step 3: Verify**
- Run: `git status --short`

