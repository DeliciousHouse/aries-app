# Repository Restructuring Plan

## Concise diagnosis
- The repository currently treats the repo root as both the read-only application bundle and the writable runtime workspace, mostly through `PROJECT_ROOT` and `generated/...` path joins.
- Local Docker and cloud deployment are misaligned: the app image is built from source, but runtime docs still ask operators to point back at a host checkout.
- Writable runtime state (`generated/`) sits beside source code, which creates bind-mount permission problems and makes it easy to mix committed artifacts with live tenant/job data.
- The current image includes only part of the runtime inputs, while some workflows and scripts still assume repo-root-relative paths.

## Directory classification

| Class | Directories |
| --- | --- |
| Source code | `app/`, `backend/`, `frontend/`, `lib/`, `scripts/` |
| Generated/build artifacts | `.next/`, `tsconfig.tsbuildinfo`, `generated/` contents created at runtime |
| Persistent runtime data | `generated/draft/`, `generated/validated/`, nested tenant/job/idempotency data under `generated/` |
| Docs/specs/non-runtime assets | `specs/`, `templates/`, `validators/`, `n8n/`, `public/`, `tests/`, `skills/`, `publish/`, `SETUP.md`, `DOCKER.md`, `README-runtime.md`, other manifests/docs |

## Target repository / runtime tree
```text
repo/
├── app/                     # Next.js routes
├── backend/                 # server runtime logic
├── frontend/                # UI components/layouts
├── lib/                     # shared helpers
├── specs/                   # read-only schemas copied into the image
├── templates/               # read-only provisioning templates copied into the image
├── validators/              # read-only validation assets copied into the image
├── n8n/                     # read-only workflow definitions copied into the image
├── public/                  # static web assets
├── scripts/                 # repo tooling
├── tests/                   # repo-level validation scripts
├── generated/               # source-run default data dir only; do not mount into containers
└── Dockerfile / compose     # image + volume orchestration

container filesystem
├── /app                     # immutable application image contents
│   ├── app backend frontend lib specs templates validators n8n ...
└── /data/generated          # writable runtime data volume
    ├── draft/
    └── validated/
```

## Target container strategy
- **Keep in the image:** built Next.js output, server code, schemas, templates, validators, n8n workflow JSON, static assets, package metadata, runtime docs.
- **Use a named volume / data disk:** `/data/generated` only.
- **Never bind-mount in production:** the repo root, `.next/`, `node_modules/`, or any source directory.
- **Compatibility rule:** runtime code should read source assets from the app image and write mutable tenant/job state only through `ARIES_DATA_ROOT`.

## Local-development strategy
- Use the same image and same `docker-compose.yml` service shape as production-style deployments.
- Mount a named volume at `/data/generated` for writable state.
- If a local override is needed, limit it to ports, env overrides, or an alternate data volume; do not bind-mount the repo into the running production-style container.
- For source-based development outside Docker, allow the app to fall back to `./generated` when `ARIES_DATA_ROOT` is unset.

## Production strategy
- Build one image and deploy that same artifact to Google Cloud.
- Inject secrets/env only at runtime.
- Mount a persistent disk or service-managed volume to `/data/generated`.
- Do not require `PROJECT_ROOT` or any host checkout path in production.

## Migration plan in phases
1. **Decouple runtime data from repo root**
   - Introduce a single runtime path helper.
   - Use `ARIES_DATA_ROOT` for mutable state while keeping a fallback to `./generated` for source runs.
2. **Align image contents with runtime inputs**
   - Ensure read-only runtime assets (`specs`, `templates`, `validators`, `n8n`) are copied into the image.
   - Update compose to mount only the writable data directory.
3. **Remove operator-facing repo path configuration**
   - Replace `PROJECT_ROOT` guidance in docs and env examples.
   - Keep temporary backward compatibility where non-runtime scripts still rely on repo-root assumptions.
4. **Clean up remaining tooling/workflow coupling**
   - Update `publish/`, `tests/`, and `n8n/*.workflow.json` to use the new runtime data variable.
   - Prevent generated artifacts from being committed accidentally.

## Exact files likely to change
- `Dockerfile`
- `docker-compose.yml`
- `.dockerignore`
- `.env.example`
- `README-runtime.md`
- `DOCKER.md`
- `backend/runtime-paths.ts`
- `backend/onboarding/start.ts`
- `backend/onboarding/status.ts`
- `backend/marketing/jobs-start.ts`
- `backend/marketing/jobs-status.ts`
- `backend/marketing/jobs-approve.ts`
- `backend/video/jobs-start.ts`
- `backend/video/jobs-status.ts`
- `backend/video/jobs-approve.ts`
- `backend/agents/create-core-agent.ts`
- `backend/agents/create-marketing-agent.ts`
- `backend/agents/create-research-agent.ts`
- Later follow-up: `publish/*.ts`, `tests/*.ts`, `n8n/*.workflow.json`, generated examples checked into git

## Risky areas to call out explicitly
- **Imports that may break if files move:** backend modules use relative imports heavily; moving `backend`, `frontend`, or `app` files would be high churn.
- **Scripts that assume repo-root paths:** `publish/*.ts`, `tests/*.ts`, `scripts/runtime-precheck.mjs`, and n8n workflow JSON still contain repo-root assumptions or `process.cwd()` fallbacks.
- **Generated artifacts accidentally committed:** `generated/` is ignored now, but historically committed content can still drift and confuse runtime expectations.
- **Overloaded config values:** `PROJECT_ROOT` has been used for both source lookup and writable runtime storage. Those responsibilities should stay split between image paths and `ARIES_DATA_ROOT`.

## Ranked implementation order
1. Add/standardize a runtime path helper.
2. Update app-facing backend logic to use image paths for read-only assets and `ARIES_DATA_ROOT` for mutable data.
3. Update Dockerfile and compose to ship read-only assets in the image and mount only `/data/generated`.
4. Update env examples and runtime docs.
5. Convert publish/test/n8n tooling off `PROJECT_ROOT`.
6. Remove stale generated artifacts from version control if still tracked.

## Do first / do last
- **Do first:** centralize runtime path resolution and change the running app paths before touching workflows or moving directories.
- **Do last:** rewrite workflow JSON, relocate top-level folders, or remove backward-compatibility fallbacks.

## Acceptance criteria for the executor agent
- The running app no longer requires `PROJECT_ROOT` for normal local Docker or Google Cloud deployment.
- The same built image can run locally and in Google Cloud with only env/volume differences.
- Writable tenant/job state is written only beneath `ARIES_DATA_ROOT` (or `./generated` fallback for source runs).
- `docker-compose.yml` uses a named volume for runtime data and does not bind-mount the repo root.
- Read-only runtime assets required by the app are present in the image.
- Runtime docs and env examples describe `ARIES_DATA_ROOT` instead of asking operators for repo checkout paths.
- Existing app routes and API behavior remain intact after validation with the repository’s current build/precheck commands.
