# Aries AI

Aries AI is a Next.js application for weekly social content automation. It pairs
a public marketing site with an authenticated operator shell: connect your
social platforms, generate a week of content, review and approve it, and publish
on a schedule. Long-running generation is handed off to an execution service
(Hermes) so the web app stays responsive and runtime state stays on the server.

> **License:** Apache-2.0. The Aries AI and Sugar & Leather names and logos are
> trademarks — see [TRADEMARKS.md](TRADEMARKS.md).

## What's in this repository

- **Public marketing pages** — homepage, features, documentation, API docs.
- **Authenticated operator shell** — dashboard, platforms, posts, calendar, settings.
- **Workflow UIs** — onboarding, weekly social content creation/review, OAuth connection flows.
- **API routes** (`app/api/*`) — request validation, auth and tenant-context resolution, frontend-safe responses.
- **Backend services** (`backend/*`) — onboarding, social content jobs, integrations, execution handoff, runtime state.
- **Regression tests** (`tests/*`) — route rendering, API contracts, tenant isolation, OAuth wiring.

## What's not in this repository

Aries AI hands long-running execution to **Hermes**, a separate execution
service that owns model/provider auth (including media generation). Hermes is
**not** part of this open-source repository, but it is itself open-source at [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent). Self-hosting Aries AI end-to-end
requires a Hermes endpoint — run your own from [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent); see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for
the execution boundary.

## How it works

The default workflow is Hermes-native weekly social content:

1. A client submits `POST /api/social-content/jobs`.
2. Aries validates tenant and request data, then submits the run to Hermes.
3. Hermes posts authenticated callbacks to `/api/internal/hermes/runs`.
4. Aries updates runtime state and the read-model status for the job.
5. The operator reviews the week of content and approves publish/video steps.

For weekly social content media generation, Hermes owns ChatGPT/OpenAI auth and
provider execution — Aries sends abstract media requests and receives
authenticated callbacks. Text-only weekly planning can run when media generation is disabled. The legacy `/api/marketing/jobs` routes remain only as a thin
legacy compatibility shim and are not the supported path.

## Tech stack

- **Framework:** Next.js App Router (`next` 16.x)
- **UI:** React 18, Tailwind CSS v4
- **Auth:** `next-auth` v5
- **Data:** PostgreSQL (`pg`) + generated runtime files under `DATA_ROOT`
- **Execution:** Hermes run submission + authenticated `/api/internal/hermes/runs` callbacks
- **Language/tooling:** TypeScript, `tsx`

## Quickstart (local)

Prerequisites: Node.js 18+, npm, PostgreSQL 16, and a Hermes endpoint for live
execution.

```bash
# 1. Install dependencies (force dev mode so devDependencies install)
NODE_ENV=development npm ci

# 2. Create your environment file from the template
cp .env.example .env
#    Fill in DB_*, HERMES_*, INTERNAL_API_SECRET, NEXTAUTH_SECRET, etc.

# 3. Initialize the database
npm run db:init

# 4. Start the dev server (Turbopack is required for Tailwind v4)
npm run dev
```

The app runs at `http://localhost:3000`. Full setup detail, including every
environment variable and a demo-friendly mode, is in
[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## Quickstart (Docker)

```bash
cp .env.example .env          # fill in DB_* and HERMES_* values
docker network create docker-stack || true
docker compose --env-file .env -f docker-compose.yml -f docker-compose.local.yml up --build -d aries-app
```

Compose expects an external PostgreSQL database and an external Hermes service:
it does **not** provision PostgreSQL or pgAdmin. Point the external `DB_*` values
in `.env` at a database the container can reach. See
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for production deployment.

## Documentation

| Doc | What it covers |
|-----|----------------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System architecture and the Hermes execution boundary |
| [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) | Running Aries AI locally, environment variables |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production deployment with Docker |
| [docs/OAUTH_SCOPES.md](docs/OAUTH_SCOPES.md) | OAuth providers and required scopes |
| [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) | Auth, tenant isolation, callback trust boundary |
| [docs/COMMERCIAL.md](docs/COMMERCIAL.md) | What is open source vs. commercial / managed hosting |

## Validation

```bash
npm run typecheck   # type-checks the project
npm run lint        # typecheck + banned-pattern + repo-boundary checks
npm run verify      # fast regression suite
npm test            # full test suite
```

Key social-content regression specs:
`tests/social-content-weekly-defaults.test.ts` (weekly defaults and status copy)
and `tests/social-content-execution-contract.test.ts` (the Hermes execution
contract). Tests covering `/api/marketing/*` exist only for legacy compatibility.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md) first. Changes to auth, OAuth, tenant
isolation, internal callback routes, or deployment workflows require maintainer
review.

## Security

Do not file public issues for vulnerabilities. Email security@sugarandleather.com
— see [SECURITY.md](SECURITY.md).

## License and trademarks

Code in this repository is licensed under [Apache-2.0](LICENSE). The Aries AI and
Sugar & Leather names, logos, and brand assets are trademarks of
Sugar & Leather, LLC and are **not** covered by the code license — see
[TRADEMARKS.md](TRADEMARKS.md). Acceptable use is described in
[ACCEPTABLE_USE.md](ACCEPTABLE_USE.md).

## Support and sponsorship

Community support is via GitHub Issues ([SUPPORT.md](SUPPORT.md)). Commercial
support, managed hosting, and custom integration work are available through
Sugar & Leather, LLC — see [docs/COMMERCIAL.md](docs/COMMERCIAL.md).
