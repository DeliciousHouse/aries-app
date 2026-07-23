<div align="center">

<img src="https://raw.githubusercontent.com/DeliciousHouse/aries-app/master/public/aries-logo.webp" alt="Aries AI logo" width="140" />

# Aries AI

### Open-source, self-hostable weekly social content automation

Connect your social platforms, generate a full week of content, review and approve it, then publish on a schedule — all from a system you host and control.

[Quickstart](#-quickstart-local) · [Docker Install](#-one-line-install-docker) · [Documentation](#-documentation) · [Contributing](#-contributing) · [Support the project](#-support--sponsorship)

</div>

---

<div align="center">

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)](https://nextjs.org)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![GitHub Stars](https://img.shields.io/github/stars/DeliciousHouse/aries-app?style=social)](https://github.com/DeliciousHouse/aries-app/stargazers)

</div>

## Overview

**Aries AI** is a Next.js application for weekly social content automation. It pairs a public marketing site with an authenticated operator shell: connect your social platforms, generate a week of content, review and approve it, and publish on a schedule. Long-running generation is handed off to an execution service (Hermes) so the web app stays responsive and runtime state stays on the server.

> **License:** Apache-2.0. The Aries AI and Sugar & Leather names and logos are trademarks — see [TRADEMARKS.md](TRADEMARKS.md).

## ✨ Highlights

- **Weekly content, end to end** — onboard a tenant, generate a full week of posts, review, approve, and schedule.
- **Multi-platform publishing** — connect channels via OAuth and publish on a schedule.
- **Responsive by design** — long-running generation is handed to the Hermes execution service so the UI never blocks.
- **Multi-tenant & secure** — tenant isolation, auth, and a hardened internal callback boundary.
- **Truly self-hostable** — one-line Docker install brings up the app, workers, PostgreSQL, and (optionally) Hermes.

## 🚀 One-line install (Docker)

```bash
curl -fsSL https://raw.githubusercontent.com/DeliciousHouse/aries-app/master/install.sh | bash
```

This brings up the full self-host stack — the app, its background workers, a bundled PostgreSQL, and (when you provide an LLM API key) a bundled Hermes execution gateway for content generation. When it finishes, open `http://localhost:3000/signup`; creating an account auto-provisions your workspace. Prerequisites: Docker with Compose v2, `curl`, and `openssl`.

**Useful flags** (pass after `bash -s --`):

| Flag | What it does |
|------|--------------|
| `--dir DIR` | Install directory (default `./aries-app`) |
| `--domain URL` | Public origin (default `http://localhost:3000`) |
| `--llm-provider P` / `--llm-key KEY` | LLM credentials for Hermes (`openrouter`, `anthropic`, or `openai`) |
| `--no-hermes` | Skip the Hermes gateway (dashboard/auth/scheduling only) |
| `--build` | Build the image locally instead of pulling from GHCR |
| `-y` | Non-interactive (no prompts) |

Example with flags:

```bash
curl -fsSL https://raw.githubusercontent.com/DeliciousHouse/aries-app/master/install.sh \
  | bash -s -- --llm-provider openrouter --llm-key sk-or-... -y
```

Re-running the installer in the same directory is safe: it updates the checkout, keeps your `.env`, and rolls the stack onto the new image. Without an LLM key the install still succeeds in a degraded mode — everything except content generation works. Details in [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## 📦 What's in this repository

- **Public marketing pages** — homepage, features, documentation, API docs.
- **Authenticated operator shell** — dashboard, platforms, posts, calendar, settings.
- **Workflow UIs** — onboarding, weekly social content creation/review, OAuth connection flows.
- **API routes** (`app/api/*`) — request validation, auth and tenant-context resolution, frontend-safe responses.
- **Backend services** (`backend/*`) — onboarding, social content jobs, integrations, execution handoff, runtime state.
- **Regression tests** (`tests/*`) — route rendering, API contracts, tenant isolation, OAuth wiring.

### What's not in this repository

Aries AI hands long-running execution to **Hermes**, a separate execution service that owns model/provider auth (including media generation). Hermes is not part of this open-source repository, but it is itself open-source at [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent). Self-hosting Aries AI end-to-end requires a Hermes endpoint — run your own from [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent); see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the execution boundary.

## ⚙️ How it works

The default workflow is Hermes-native weekly social content:

1. A client submits `POST /api/social-content/jobs`.
2. Aries validates tenant and request data, then submits the run to Hermes.
3. Hermes posts authenticated callbacks to `/api/internal/hermes/runs`.
4. Aries updates runtime state and the read-model status for the job.
5. The operator reviews the week of content and approves publish/video steps.

For weekly social content media generation, Hermes owns ChatGPT/OpenAI auth and provider execution — Aries sends abstract media requests and receives authenticated callbacks. Text-only weekly planning can run when media generation is disabled. The legacy `/api/marketing/jobs` routes remain only as a thin legacy compatibility shim and are not the supported path.

## 🧱 Tech stack

- **Framework:** Next.js App Router (`next` 16.x)
- **UI:** React 19, Tailwind CSS v4
- **Auth:** next-auth v5
- **Data:** PostgreSQL (`pg`) + generated runtime files under `DATA_ROOT`
- **Execution:** Hermes run submission + authenticated `/api/internal/hermes/runs` callbacks
- **Language/tooling:** TypeScript, tsx

## 🏁 Quickstart (local)

Prerequisites: Node.js 18+, npm, PostgreSQL 16, and a Hermes endpoint for live execution.

```bash
# 1. Install dependencies (force dev mode so devDependencies install)
NODE_ENV=development npm ci

# 2. Create your environment file from the template
cp .env.example .env
# Fill in DB_*, HERMES_*, INTERNAL_API_SECRET, NEXTAUTH_SECRET, etc.

# 3. Initialize the database
npm run db:init

# 4. Start the dev server (Turbopack is required for Tailwind v4)
npm run dev
```

The app runs at `http://localhost:3000`. Full setup detail, including every environment variable and a demo-friendly mode, is in [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## 🐳 Quickstart (Docker)

The one-line install above is the recommended Docker path — it generates `.env`, provisions PostgreSQL (and optionally Hermes) via the `docker-compose.selfhost.yml` overlay, and waits for health.

To run compose by hand against **external** PostgreSQL and Hermes services (the production layout), use the base file alone:

```bash
cp .env.example .env   # fill in DB_* and HERMES_* values
docker network create docker-stack || true
docker compose --env-file .env -f docker-compose.yml -f docker-compose.local.yml up --build -d aries-app
```

The base compose file does **not** provision PostgreSQL or Hermes — point the `DB_*` values in `.env` at a database the container can reach, or add the self-host overlay (`-f docker-compose.selfhost.yml`, with `--profile hermes` for the bundled gateway) to run them in the same stack. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for production deployment.

## 📚 Documentation

Full documentation lives in `docs/`, organized by the [Diátaxis](https://diataxis.fr) framework. Highlights:

| Doc | Quadrant | What it covers |
|-----|----------|----------------|
| [docs/tutorials/first-week-of-content.md](docs/tutorials/first-week-of-content.md) | Tutorial | Onboard a tenant, generate, review, approve, and schedule a week |
| [docs/how-to/generate-and-approve-a-week.md](docs/how-to/generate-and-approve-a-week.md) | How-to | Submit a weekly job and walk the approval stages (UI and API) |
| [docs/how-to/connect-a-social-platform.md](docs/how-to/connect-a-social-platform.md) | How-to | Connect a channel via OAuth/Composio; token storage; reconnecting |
| [docs/how-to/integrate-hermes.md](docs/how-to/integrate-hermes.md) | How-to | Point Aries at Hermes and wire the authenticated callback |
| [docs/how-to/run-background-workers.md](docs/how-to/run-background-workers.md) | How-to | Run and operate the sidecar and in-process workers |
| [docs/reference/api-jobs-and-callbacks.md](docs/reference/api-jobs-and-callbacks.md) | Reference | The jobs API, approve route, and Hermes callback contract |
| [docs/reference/background-workers.md](docs/reference/background-workers.md) | Reference | Every worker: command, cadence, env gates, defaults |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Explanation | System architecture and the Hermes execution boundary |
| [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) | How-to | Running Aries AI locally, environment variables |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | How-to | Production deployment with Docker |
| [docs/OAUTH_SCOPES.md](docs/OAUTH_SCOPES.md) | Reference | OAuth providers and required scopes |
| [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md) | Explanation | Auth, tenant isolation, callback trust boundary |
| [docs/COMMERCIAL.md](docs/COMMERCIAL.md) | Explanation | What is open source vs. commercial / managed hosting |

## ✅ Validation

```bash
npm run typecheck   # type-checks the project
npm run lint        # typecheck + banned-pattern + repo-boundary checks
npm run verify      # fast regression suite
npm test            # full test suite
```

Key social-content regression specs: `tests/social-content-weekly-defaults.test.ts` (weekly defaults and status copy) and `tests/social-content-execution-contract.test.ts` (the Hermes execution contract). Tests covering `/api/marketing/*` exist only for legacy compatibility.

## 🤝 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) first. Changes to auth, OAuth, tenant isolation, internal callback routes, or deployment workflows require maintainer review.

## 🔒 Security

Do not file public issues for vulnerabilities. Email **security@sugarandleather.com** — see [SECURITY.md](SECURITY.md).

## ❤️ Support & Sponsorship

Aries AI is free and open source under Apache-2.0, and it stays that way because of the community.

- **⭐ Star this repo** — the simplest way to help others discover the project.
- **💜 Sponsor development** — if Aries AI saves you time, please consider sponsoring via the **Sponsor** button at the top of this page. Your support funds maintenance, new integrations, and documentation.
- **🐛 Contribute** — issues, pull requests, and docs improvements are all hugely appreciated.
- **📣 Spread the word** — share Aries AI with your team or community.

Community support is via [GitHub Issues](https://github.com/DeliciousHouse/aries-app/issues) (see [SUPPORT.md](SUPPORT.md)). Commercial support, managed hosting, and custom integration work are available through Sugar & Leather, LLC — see [docs/COMMERCIAL.md](docs/COMMERCIAL.md).

## 📄 License & trademarks

Code in this repository is licensed under **Apache-2.0**. The Aries AI and Sugar & Leather names, logos, and brand assets are trademarks of Sugar & Leather, LLC and are not covered by the code license — see [TRADEMARKS.md](TRADEMARKS.md). Acceptable use is described in [ACCEPTABLE_USE.md](ACCEPTABLE_USE.md).

<div align="center">
<sub>Built with ❤️ by the Aries AI community · Apache-2.0</sub>
</div>
