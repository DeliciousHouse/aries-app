# TOOLS.md — Environment Notes

## Workspace

- Primary repo: `/app/aries-app`
- Build/dev commands, env vars, and DB defaults: see `CLAUDE.md`

## Mission Control paths

Remembered path for standalone MC deployment:
- `/home/node/openclaw/projects/mission-control-builder/mission-control`
- Status: remembered context, not freshly verified

## Documentation sources

- Local docs: `/app/aries-app/docs`, `README.md`, `README-runtime.md`, `SETUP.md`
- Delegation rules: `DELEGATION-RULES.md`
- OpenClaw docs: `https://docs.openclaw.ai`
- OpenClaw source: `https://github.com/openclaw/openclaw`

## Environment variable notes

System-level env vars may override `.env`. Known examples: `NODE_ENV=production`, `DB_HOST`, `APP_BASE_URL`.

Use `NODE_ENV=development npm ci` for installs (system may have `NODE_ENV=production` which skips devDependencies).

## Runtime truth rules

When describing environment behavior, distinguish between: verified current state, repo/config default, remembered prior context, and inference. Do not upgrade a likely default into runtime fact without checking.

## Human verification needed

Expect human verification for: live deployment targets, account/dashboard states, external service credentials, manual steps outside repo visibility, anything Somwya owns, final deploy approval.

When needed, state: what must be verified, who verifies, what evidence confirms it, what can proceed meanwhile.
