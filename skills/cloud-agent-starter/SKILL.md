---
name: cloud-agent-starter
description: Use this at the start of a Cloud-agent session in the Aries repo to get the app running, choose the right test path, avoid dead auth flows, and use the practical mock/fallback workflows that actually exist here.
---

# Cloud Agent Starter

Use this skill at the beginning of a fresh Cloud-agent session. It is the shortest practical runbook for getting Aries running and choosing the right testing workflow without rediscovering the repo’s gotchas.

## Quick start

### 1. Install dependencies

```bash
npm install
```

### 2. Run the baseline repo check

```bash
npm run precheck
```

### 3. Start the app in Cloud

The Cloud VM forces `NODE_ENV=production` globally. If you start Next.js without overriding it, Tailwind/PostCSS processing breaks and pages can 500.

Use this exact command:

```bash
NODE_ENV=development CODE_ROOT=/workspace DATA_ROOT=/workspace/data npx next dev -p 3000
```

### 4. Optional parity build check

```bash
NODE_ENV=production CODE_ROOT=/workspace DATA_ROOT=/workspace/data npx next build
```

## Environment and secrets you usually need

### Always required for runtime-backed flows

- `N8N_BASE_URL`
- `N8N_API_KEY`

### Required for protected app-shell + Google login work

- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `NEXTAUTH_URL`
- `AUTH_URL`
- `AUTH_TRUST_HOST`
- `NEXTAUTH_SECRET`

### Sometimes needed

- `META_APP_ID`
- `META_APP_SECRET`
- `META_REDIRECT_URI`

### Notes

- In Cloud, secrets may already be injected. Use `.env.example` as a reference, not a guarantee that you need to create a local `.env`.
- For auth-backed flows, the DB schema must exist before first sign-in:

```bash
npm run db:init
```

## Login reality: what works and what does not

### Live sign-in path

Only **Google OAuth** is a real login path right now.

- Login page: `/login`
- Auth handler: `/api/auth/[...nextauth]`

### Intentionally unavailable flows

Do **not** try to use email/password, signup, or password recovery as working product paths. They are intentionally disabled.

If you touch auth code, verify that behavior with:

```bash
npx tsx --test tests/auth/oauth-connect.test.ts
```

### Protected routes

These routes require a real authenticated session:

- `/dashboard`
- `/posts`
- `/calendar`
- `/platforms`
- `/settings`

Without auth, the shared app shell redirects to `/login`.

### Extra auth gotcha

Google OAuth is not enough by itself. Protected operator flows also depend on a real tenant membership loaded from Postgres. If the DB rows are missing, login-based testing will still fail.

### Practical rule

If Google secrets, callback URL setup, or DB membership are not ready:

- do **not** try to fake login
- do **not** use email/password as a workaround
- test route handlers, public routes, and targeted scripts directly instead

## Feature flags and mocking: what exists here in practice

There is **no formal feature-flag system** in this repo.

Use these practical substitutes instead:

### Demo / sandbox entry points

- `POST /api/demo`
- `POST /api/sandbox/launch`

These are the easiest “mock-like” tenant provisioning paths when you need a lightweight runtime exercise.

### Local fallback behavior

Several backend flows fall back to local runtime artifacts when n8n is unreachable.

Examples:

- marketing job start/approve can fall back to files under `generated/draft/marketing-jobs/`
- onboarding status reads local runtime artifacts instead of polling n8n directly

### Avoid demo defaults when testing directly

Some routes still contain legacy defaults like `tenant_demo_001`. Do not rely on them when you are testing behavior deliberately.

Prefer sending explicit IDs such as:

- `tenant_id`
- `jobId`
- `signup_event_id`

## Codebase areas and the fastest way to test each one

---

## 1. Public marketing site and runtime shell baseline

### Main files

- `app/`
- `README-runtime.md`
- `ROUTE_MANIFEST.md`

### What to test first

After starting the dev server, load:

- `/`
- `/features`
- `/documentation`
- `/api-docs`

### Fast validation workflow

```bash
npm run precheck
npx tsx --test tests/runtime-pages.test.ts
```

Use this area first when you only need to prove the repo boots and the route wrappers are still truthful.

---

## 2. Auth and protected operator shell

### Main files

- `auth.ts`
- `app/login/page.tsx`
- `frontend/app-shell/layout.tsx`
- `lib/tenant-context.ts`

### Manual workflow

1. Visit `/login`
2. Confirm the page offers **Google** sign-in
3. Open a protected route like `/dashboard`
4. Confirm unauthenticated access redirects back to `/login`

### Fast validation workflow

```bash
npx tsx --test tests/auth/oauth-connect.test.ts
npx tsx --test tests/auth/auth-runtime-config.test.ts
npx tsx --test tests/auth/tenant-context.test.ts
```

### When to stop trying manual login

Stop and switch to test scripts if any of these are missing:

- Google OAuth secrets
- correct callback base URL
- DB schema
- user-to-tenant membership rows

---

## 3. Onboarding runtime

### Main files

- `app/onboarding/*`
- `app/api/onboarding/*`
- `backend/onboarding/*`
- `frontend/onboarding/*`

### Manual workflow

1. Open `/onboarding/start`
2. Submit a real `tenant_id` and `signup_event_id`
3. Follow the redirect to `/onboarding/status`
4. Verify the query state is preserved

### Direct API workflow

- `POST /api/onboarding/start`
- `GET /api/onboarding/status/:tenantId?signup_event_id=...`

### Demo-friendly workflow

- `POST /api/demo`
- `POST /api/sandbox/launch`

### Fast validation workflow

```bash
npx tsx --test tests/runtime-pages.test.ts
npx tsx --test tests/onboarding-marketing-contracts.test.ts
```

### Important truth

`/api/onboarding/status/:tenantId` is a local runtime-status reader. It is not a live workflow polling endpoint.

---

## 4. Marketing job runtime

### Main files

- `app/marketing/*`
- `app/api/marketing/*`
- `backend/marketing/*`
- `frontend/marketing/*`

### Manual workflow

1. Open `/marketing/new-job`
2. Submit:
   - `tenantId`
   - `brandUrl`
   - `competitorUrl`
3. Follow the returned job into:
   - `/marketing/job-status?jobId=...`
   - `/marketing/job-approve?jobId=...&tenantId=...`

### Fast validation workflow

```bash
npx tsx --test tests/marketing-job-flow.test.ts
npx tsx --test tests/runtime-pages.test.ts
npx tsx tests/run-marketing-pipeline-simulation.ts
```

### Important truth

If n8n is unavailable, the backend can still accept the job and create a fallback runtime artifact under:

```text
generated/draft/marketing-jobs/
```

That fallback path is useful for Cloud debugging and should be treated as the practical mock path for marketing flow work.

---

## 5. Integrations and OAuth broker

### Main files

- `app/api/integrations/*`
- `app/api/auth/oauth/*`
- `backend/integrations/*`
- `frontend/settings/*`

### Important truth before testing

- The UI connect flow uses `POST /api/integrations/connect`
- That route requires authenticated tenant context from Postgres
- The canonical callback namespace is `/api/auth/oauth/:provider/*`
- The broker implementation is mostly an in-memory test double, not a full live provider integration stack

### Read-model workflow that works without full login

Always pass an explicit tenant id:

- `GET /api/integrations?tenant_id=tenant_123`
- `GET /api/platform-connections?tenant_id=tenant_123`

### Manual UI workflow

Use `/platforms` only when both are ready:

- Google login works
- DB tenant membership is valid

Then test:

- connect
- reconnect
- disconnect
- sync

### Fast validation workflow

```bash
npx tsx --test tests/integrations-status.test.ts
npx tsx --test tests/auth/oauth-connect.test.ts
```

### Practical rule

For direct API tests, always send `tenant_id` explicitly instead of depending on baked-in demo fallbacks.

---

## 6. Publish and calendar orchestration

### Main files

- `app/api/publish/*`
- `app/api/calendar/sync/route.ts`
- `backend/integrations/workflow-orchestrator.ts`
- `publish/*`

### Direct API workflow

Use explicit tenant ids for every request:

- `POST /api/publish/dispatch`
- `POST /api/publish/retry`
- `POST /api/calendar/sync`

For `publish/dispatch`, send at minimum:

- `tenant_id`
- `provider`
- `content`

### Fast validation workflow

```bash
npx tsx --test tests/runtime-api-truth.test.ts
npx tsx tests/run-token-health-validation.ts
npx tsx tests/run-v3-orchestration-suite.ts
```

### Practical rule

Even if a route still has a demo fallback internally, treat explicit tenant IDs as required for serious testing.

---

## 7. n8n workflows and workflow diagnostics

### Main files

- `n8n/*.workflow.json`
- `publish/*`
- `WEBHOOK_MANIFEST.md`

### First checks

```bash
npx tsx publish/diagnose-env.ts
npx tsx publish/diagnose-n8n-auth.ts
```

### Useful validation scripts

```bash
npx tsx tests/run-gating-suite.ts
```

### Important rule

If you are changing workflow JSON or debugging n8n import/activation issues, also use:

- `skills/n8n-local-runtime/SKILL.md`

That skill is the deeper workflow-specific runbook. This starter skill only gets you to the right starting point.

## Useful docs to keep open

- `README-runtime.md`
- `SETUP.md`
- `ROUTE_MANIFEST.md`
- `WEBHOOK_MANIFEST.md`
- `DOCKER.md`

## How to update this skill when you learn something new

When you discover a new runbook trick, debugging shortcut, or setup gotcha:

1. Add it to the **relevant codebase area** above, not to a generic dump section
2. Include the exact command, route, or prerequisite
3. State whether it requires:
   - auth
   - DB schema
   - n8n connectivity
   - explicit tenant IDs
4. Replace stale guidance instead of stacking contradictory notes

Keep this skill biased toward the first few practical steps a Cloud agent needs, not full repo history.
