# Aries AI — Security Model

## Authentication and session management

Aries uses **next-auth v5** (`auth.ts`) for authentication. Two sign-in methods are supported:

- **Email and password** — password hashes are stored using bcrypt. Incorrect credentials and unknown emails return the same generic error to avoid user enumeration.
- **Google OAuth** — uses the next-auth Google provider with `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

Sessions are signed using `NEXTAUTH_SECRET`. `AUTH_TRUST_HOST=true` allows Aries to trust forwarded host headers when running behind a reverse proxy.

The session cookie is HttpOnly and scoped to the origin. next-auth v5 does not expose raw session data to client-side JavaScript.

## Tenant isolation

Every authenticated operator request goes through a two-layer authorization check:

1. **Session check** — middleware enforces a valid next-auth session before any operator route is reached.
2. **Tenant context resolution** — route handlers call `loadTenantContextForUser` (`lib/tenant-context.ts`), which queries the database to confirm the authenticated user has a membership record in the `organizations` table for the requested tenant. The resolved `TenantContext` (`{ userId, tenantId, tenantSlug, role }`) is then threaded through all downstream queries.

All database queries for tenant-scoped data are parameterized with the resolved `tenantId`. No query trusts a client-supplied tenant identifier directly.

Supported tenant roles:

| Role | Description |
|---|---|
| `tenant_admin` | Full management access within the tenant |
| `tenant_analyst` | Read and reporting access |
| `tenant_viewer` | Read-only access |

## Internal callback authentication

The Hermes callback ingress at `POST /api/internal/hermes/runs` is protected by two independent checks:

**1. Bearer token — `INTERNAL_API_SECRET`**

`verifyInternalCallbackRequest` (`lib/internal-callback-auth.ts`) extracts the `Authorization: Bearer <token>` header and performs a constant-time comparison against `INTERNAL_API_SECRET`. Requests without the header return 401; requests with a mismatched token return 403.

**2. Per-run callback token**

Each Hermes run record stores a SHA-256 hash of a per-run callback token generated at submission time. When a callback arrives, `verifyCallbackToken` queries the `execution_runs` table for the matching `aries_run_id` and performs a constant-time comparison of the plaintext token (supplied in the callback body) against the stored hash. This ensures that even if `INTERNAL_API_SECRET` were compromised, a callback cannot update an arbitrary run.

The two secrets serving the callback boundary are intentionally separate:

- `HERMES_API_SERVER_KEY` — outbound; protects `POST HERMES_GATEWAY_URL/v1/runs`
- `INTERNAL_API_SECRET` — inbound; protects `POST APP_BASE_URL/api/internal/hermes/runs`

## OAuth token security

Aries-brokered OAuth tokens (LinkedIn, X, YouTube, TikTok, Reddit) are encrypted before storage using `OAUTH_TOKEN_ENCRYPTION_KEY` via the token crypto helpers in `backend/integrations/oauth-token-crypto.ts`. The key is a 32-byte base64-encoded value generated with `openssl rand -base64 32`.

Rotating `OAUTH_TOKEN_ENCRYPTION_KEY` invalidates all stored encrypted tokens; users must reconnect their provider accounts after a key rotation.

Meta tokens (`META_ACCESS_TOKEN`, `META_PAGE_ID`) are env-managed and not stored in the database.

## Publishing authorization

Publishing dispatch (`POST /api/publish/dispatch`) requires an authenticated operator session with a valid tenant context. The route validates that the dispatching user has access to the tenant that owns the content before submitting publish work to the provider.

## API route trust boundary

Route handlers under `app/api/*` are the only browser-facing surface. They:

- Validate all incoming request bodies before use.
- Resolve auth and tenant context server-side; never trust client-supplied tenant IDs.
- Return typed, frontend-safe response shapes; never leak raw database rows, file paths, or internal state.

Internal routes under `app/api/internal/*` do not accept requests from the browser. They are protected by the `INTERNAL_API_SECRET` bearer token check described above.

## Secret rotation checklist

When rotating any of the following secrets, take the corresponding action:

| Secret | Action on rotation |
|---|---|
| `NEXTAUTH_SECRET` | All active sessions are invalidated; users must sign in again |
| `OAUTH_TOKEN_ENCRYPTION_KEY` | All stored OAuth tokens are invalidated; users must reconnect providers |
| `INTERNAL_API_SECRET` | Update in both Aries env and Hermes callback configuration simultaneously |
| `HERMES_API_SERVER_KEY` | Update in both Aries env and Hermes gateway configuration simultaneously |
| `META_ACCESS_TOKEN` | Re-issue from the Meta developer console |

## Security reporting

To report a security vulnerability, email **security@sugarandleather.com** or open a private security advisory via GitHub's security reporting interface. Do not open a public GitHub issue for security vulnerabilities.
