# Repo audit summary

## Current executable truth

- Framework/runtime: **Next.js 16.1.7** from `package.json`.
- Primary real workflow contract: **`marketing-pipeline.lobster` + resume tokens** for strategy, production, launch review, and paused publish approval.
- Production runtime contract: code baked into the image, writable data under `/data`, external PostgreSQL, external OpenClaw Gateway, no required source bind mount.
- Local host contract: `NODE_ENV=development`, local PostgreSQL 16, localhost app/auth URLs, `DATA_ROOT=/tmp/aries-data`, `npm run dev`.
- Local Docker contract: repo bind mount only in local/dev profile, port `3000`, host gateway default `http://host.docker.internal:18789`, writable `/data` volume.

## Highest-risk drifts

1. **Workflow target drift**
   - `backend/openclaw/workflow-catalog.ts` still points stage 2/3/4 routes at nested workflow files like `stage-2-strategy/review-workflow.lobster`.
   - The actual tested contract uses `marketing-pipeline.lobster` and resume tokens instead.
   - Those nested workflow files are not present under `lobster/`.

2. **Stub routes still in the supported UI/API surface**
   - `/api/onboarding/start`
   - `/api/publish/dispatch`
   - `/api/publish/retry`
   - `/api/calendar/sync`
   - `/api/integrations/sync`
   - `/api/demo`
   - `/api/sandbox/launch`

3. **Local fallback regression**
   - Targeted validation ended at **44 passing / 1 failing**.
   - Failing test: `tests/marketing-local-dev-regression.test.ts`
   - Observed failure: `brand_kit_fetch_failed:fetch failed` while exercising gateway-less local Lobster resume.

## Docs/manifests drift

- `README-runtime.md` still describes Aries as **Next.js 15**.
- `README.md` still carries a stale warning that `npm run dev` lacks `--turbopack`, but `package.json` now includes it.
- `ROUTE_MANIFEST.md` and `README-runtime.md` describe a narrower route contract than the app/tests currently expose.

## Recommended next phase

**Phase 1 — production contract freeze**

Recommended next persistent owner: **Jarvis**

Recommended execution label if a subordinate specialist run is used: **`aries-prod`**

Governance note:
- `aries-prod` is a legacy execution label only.
- It is not a persistent owner under current repo governance.

### Production-first actions

- Freeze the canonical workflow contract around `marketing-pipeline.lobster`.
- Decide which stubbed routes must become real before ship and which should be removed or demoted from the supported contract.
- Reconcile manifests/docs with the actual tested route surface.
- Preserve the existing production container contract: `/app` code, `/data` writable runtime, external Postgres, external OpenClaw.

### Local follow-up after production freeze

- Re-derive host and Docker local env from the frozen production contract.
- Keep the gateway/local cwd split instead of forcing one path style.
- Fix the local Lobster fallback regression before claiming local parity.
