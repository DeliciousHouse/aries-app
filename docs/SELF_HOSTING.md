# Aries AI — Self-Hosting Guide

## Prerequisites

- **Node.js** 18 or later
- **npm** (bundled with Node.js)
- **PostgreSQL** 16
- **Hermes** gateway with a configured session and API key (required for live workflow execution)
- Optional: Docker and Docker Compose (for containerized local runs)

## 1. Clone and install dependencies

The repository may have `NODE_ENV=production` set at the OS level. Force development mode when installing so devDependencies are included:

```bash
NODE_ENV=development npm ci
```

## 2. Configure environment variables

Copy the template:

```bash
cp .env.example .env
```

Edit `.env` and fill in values. The minimum required set for local development:

```bash
# Database
DB_HOST=localhost
DB_PORT=5432
DB_USER=aries_user
DB_PASSWORD=aries_pass
DB_NAME=aries_dev

# App origin — used to build callback URLs
APP_BASE_URL=http://localhost:3000

# next-auth v5
NEXTAUTH_URL=http://localhost:3000
AUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=replace-with-a-long-random-secret
AUTH_TRUST_HOST=true

# Hermes execution boundary
HERMES_GATEWAY_URL=http://127.0.0.1:8642
HERMES_API_SERVER_KEY=replace-with-hermes-api-server-key
HERMES_SESSION_KEY=main

# Callback authentication (Hermes → Aries)
INTERNAL_API_SECRET=replace-with-callback-secret

# Aries root paths
CODE_ROOT=/path/to/aries-app
DATA_ROOT=/tmp/aries-data
NODE_ENV=development
```

Generate secrets for `NEXTAUTH_SECRET` and `INTERNAL_API_SECRET`:

```bash
openssl rand -hex 32
```

### OAuth provider credentials (optional for local dev)

For Aries-managed OAuth providers (LinkedIn, X, YouTube, TikTok, Reddit), also set:

```bash
OAUTH_TOKEN_ENCRYPTION_KEY=<output of: openssl rand -base64 32>

LINKEDIN_CLIENT_ID=...
LINKEDIN_CLIENT_SECRET=...
X_CLIENT_ID=...
X_CLIENT_SECRET=...
TIKTOK_CLIENT_KEY=...
TIKTOK_CLIENT_SECRET=...
REDDIT_CLIENT_ID=...
REDDIT_CLIENT_SECRET=...
REDDIT_USER_AGENT=AriesOAuthBroker/1.0
```

For Google/YouTube and the next-auth Google sign-in provider:

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

For Meta publishing (env-managed, not OAuth-brokered):

```bash
META_APP_ID=...
META_APP_SECRET=...
META_PAGE_ID=...
META_AD_ACCOUNT_ID=...
META_ACCESS_TOKEN=...
```

Register the OAuth callback URLs in each provider's developer console. Aries builds them from `APP_BASE_URL`:

```
https://<APP_BASE_URL>/api/auth/oauth/facebook/callback
https://<APP_BASE_URL>/api/auth/oauth/linkedin/callback
https://<APP_BASE_URL>/api/auth/oauth/reddit/callback
https://<APP_BASE_URL>/api/auth/oauth/tiktok/callback
https://<APP_BASE_URL>/api/auth/oauth/x/callback
https://<APP_BASE_URL>/api/auth/oauth/youtube/callback
```

### Transactional email (optional)

Password reset requires a Resend API key and a verified sender domain:

```bash
RESEND_API_KEY=re_...
EMAIL_FROM=Aries AI <noreply@your-domain.com>
```

For local testing without a verified domain, use Resend's sandbox sender:

```bash
EMAIL_FROM=Aries AI <onboarding@resend.dev>
```

## 3. Start PostgreSQL

```bash
sudo pg_ctlcluster 16 main start
```

## 4. Initialize the database schema

```bash
npm run db:init
```

This runs `scripts/init-db.js` and creates all required tables.

## 5. Start the development server

Aries requires **Turbopack** for Tailwind CSS v4 processing:

```bash
npm run dev
```

The app listens on `http://localhost:3000`.

### Demo / local review mode

Set `MARKETING_STATUS_PUBLIC=1` to serve the latest runtime-backed social content data without a full authenticated session. This makes local review, status pages, and asset routes accessible to teammates reproducing UI issues without a full VM session.

```bash
MARKETING_STATUS_PUBLIC=1 npm run dev
```

This flag must never be set to `1` in production.

## 6. Run verification

After setup, run the fast regression gate:

```bash
npm run verify
```

To verify the full execution provider wiring:

```bash
npm run validate:execution-provider
```

## Docker Compose (alternative)

For a production-style local container run, see `DEPLOYMENT.md`. The quick version:

```bash
docker network create docker-stack || true
docker compose --env-file .env -f docker-compose.yml -f docker-compose.local.yml up --build -d aries-app
```

Compose expects PostgreSQL to be external and reachable via `DB_*` env vars. It does not provision a Postgres container.

## Required environment variable reference

| Variable | Purpose |
|---|---|
| `APP_BASE_URL` | Public origin; used to build callback and redirect URLs |
| `INTERNAL_API_SECRET` | Bearer token Hermes sends on `POST /api/internal/hermes/runs` callbacks |
| `HERMES_GATEWAY_URL` | Base URL for Hermes run submissions |
| `HERMES_API_SERVER_KEY` | Bearer token Aries sends to Hermes `/v1/runs` |
| `HERMES_SESSION_KEY` | Session key for Hermes-submitted runs (usually `main`) |
| `DB_HOST` | PostgreSQL host |
| `DB_PORT` | PostgreSQL port (default `5432`) |
| `DB_USER` | PostgreSQL user |
| `DB_PASSWORD` | PostgreSQL password |
| `DB_NAME` | PostgreSQL database name |
| `NEXTAUTH_URL` | Canonical next-auth v5 URL |
| `AUTH_URL` | Alias for next-auth public origin |
| `NEXTAUTH_SECRET` | next-auth signing secret |
| `AUTH_TRUST_HOST` | Set `true` behind a reverse proxy |
| `OAUTH_TOKEN_ENCRYPTION_KEY` | Required for Aries-managed OAuth providers; 32-byte base64 key |

## Troubleshooting

**`npm ci` fails with missing devDependencies**
Ensure `NODE_ENV=development npm ci` — some environments set `NODE_ENV=production` globally.

**`db:init` fails with "role does not exist"**
Create the role first: `createuser -s aries_user` or adjust `DB_USER` to an existing superuser during initial setup.

**Hermes callbacks not reaching Aries**
`APP_BASE_URL` must be reachable from the Hermes process. For local development with Hermes running on a remote host, use a tunnel or set `APP_BASE_URL` to a publicly routable URL.

**`RESEND_API_KEY is not set` in server logs**
Password reset emails are silently skipped when the key is absent. The `/forgot-password` route still returns 200 to avoid user enumeration. Set `RESEND_API_KEY` and verify `EMAIL_FROM` domain in the Resend dashboard.
