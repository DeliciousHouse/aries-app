# How to connect a social platform

Connect a publishing channel so Aries can publish approved posts to it and sync insights back.

This is an operator task. You start the connection in the dashboard, the channel owner grants access through the provider's OAuth screen, and Aries stores the resulting tokens (encrypted) so it can publish and pull insights. Connecting one channel takes a few minutes.

## Prerequisites

- An Aries account with access to the dashboard. Tenant identity is derived server-side from your session, not from any request body, so you must be signed in.
- Admin access on the provider account you are connecting (for example, a Facebook account that owns at least one Page with the admin role).
- Provider client credentials configured in the environment for the channel you want. Each provider's env vars, requested scopes, and callback URL are listed in [docs/OAUTH_SCOPES.md](../OAUTH_SCOPES.md). A channel with missing credentials shows as `disabled` / `health: error` in the UI.
- `OAUTH_TOKEN_ENCRYPTION_KEY` set to a stable 32-byte key. Without it, token encryption fails and the connect callback returns `provider_unavailable`. See [Token storage and encryption](#token-storage-and-encryption).

## Steps

1. **Open the connect surface.** Go to `/dashboard/settings/channel-integrations` (source: `app/dashboard/settings/channel-integrations/page.tsx`). This page renders `<ComposioConnectionsScreen />` inside the dashboard shell with `currentRouteId="channelIntegrations"`. Composio is now the primary connect surface and brokers Facebook, Instagram, and the other toolkits. Expected result: a list of channel cards, each showing a connection state and the actions available for it.

2. **Read the card state before acting.** These exact field names are the Aries broker API representation (`GET /api/integrations`); the Composio screen renders the same connection states with its own labels, so match on the meaning (connected, pending, needs reconnect, not connected, error) rather than the literal string. In the broker shape, each card carries a `connection_state` (`connected`, `connection_pending`, `disabled`, `reauth_required`, `not_connected`, or `connection_error`), a `health` value (`healthy`, `degraded`, `error`, `unknown`), and an `available_actions` list. A channel you have not connected yet shows `not_connected` with `available_actions` `['connect', 'view_permissions']`. Expected result: you can tell which action to take from the card.

3. **Start the connect flow.** Click the channel's connect action. The rendered Composio screen posts to `POST /api/integrations/composio/{provider}/connect`, reads a `connectUrl` from the response, and navigates the browser to it. The direct Aries broker API documented below is a separate path: `POST /api/integrations/connect` (also backed by `POST /api/oauth/{provider}/start`, which delegates straight to `handleIntegrationsConnect`). If you are calling that API directly, the request body field is `platform`:

   ```bash
   curl -i -X POST https://<your-host>/api/integrations/connect \
     -H 'content-type: application/json' \
     --data '{"platform":"linkedin"}'
   ```

   The server builds the broker payload in `buildOauthConnectInput` (`lib/oauth-connect-input.ts`): `{ tenant_id, redirect_uri, scopes }`. The `scopes` default to `PROVIDER_REGISTRY[provider].default_scopes`, so you do not pass scopes yourself. The `redirect_uri` is derived from `APP_BASE_URL`. Expected result: HTTP 200 with `broker_status: 'ok'` and an `authorization_url` (source: `backend/integrations/connect.ts`).

4. **Authorize with the provider.** Send the channel owner to the `authorization_url` and have them grant the requested scopes. The provider redirects back to the registered callback route `GET /api/auth/oauth/{provider}/callback`, handled by `handleOauthCallbackHttp` (`backend/integrations/callback.ts`). An equivalent `GET /api/oauth/{provider}/callback` route runs the same handler. For a browser flow (`Accept: text/html`), the callback issues a 302 redirect to `/oauth/connect/{provider}?result=connected` on success or `result=error` on failure. Expected result: Aries exchanges the authorization code for tokens and marks the connection `connected`.

5. **Pick a Page for Meta (Facebook/Instagram only).** If the Meta account owns more than one Page, the callback returns `broker_status: 'picker_required'` and redirects to `/onboarding/connect/meta/select-page`. Choose the Page to publish from; the selection is submitted to `POST /api/oauth/meta/select-page`. A single-Page account is selected automatically and skips the picker. Expected result: the chosen Facebook Page (and its linked Instagram business account, if any) is connected.

## Token storage and encryption

Aries writes tokens to the `oauth_tokens` table in PostgreSQL (`backend/integrations/oauth-tokens-db.ts`, `INSERT INTO oauth_tokens ...`). The access and refresh tokens are never stored in plaintext: they go into the `access_token_enc` and `refresh_token_enc` columns.

Encryption is AES-256-GCM via `encryptToken` / `decryptToken` (`backend/integrations/oauth-crypto.ts`). The key comes from `OAUTH_TOKEN_ENCRYPTION_KEY` and must be 32 bytes (read as base64 if it matches a base64 pattern, otherwise utf8). Ciphertext is stored as a JSON envelope: `{ v: 1, alg: 'aes-256-gcm', iv, tag, ct }`.

Generate a key once and keep it stable:

```bash
OAUTH_TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)
```

Rotating this key invalidates every stored token (existing ciphertext can no longer be decrypted), so all channels would need reconnecting. Keep it stable. See [docs/OAUTH_SCOPES.md](../OAUTH_SCOPES.md) for the same guidance.

Note on Meta: Meta is env-managed, not user-OAuth-brokered. Its long-lived Page token comes from `META_ACCESS_TOKEN`. In the UI this maps to `status_reason === 'env_managed'`, and the card exposes only `['view_permissions']` (no `sync_now` or `disconnect`).

## Verification

- **In the UI:** reload `/dashboard/settings/channel-integrations`. The channel card should show `connection_state: 'connected'` and `health: 'healthy'`, with `available_actions` `['sync_now', 'disconnect', 'view_permissions']` (Meta shows only `['view_permissions']`). The card's `connected_account` reflects the external account, and `expires_at` carries the token expiry.

- **Via the API:** fetch all statuses with `GET /api/integrations` (handled by `handleIntegrationsGet`). Expected result: HTTP 200 with a JSON page payload whose `cards[]` include your channel as `connected`.

  ```bash
  curl -s https://<your-host>/api/integrations
  ```

- **Confirm insights sync works:** trigger a sync with `POST /api/integrations/sync` and the `platform` field. Insights platforms (`youtube`, `instagram`, `facebook`) sync directly and return HTTP 200 with per-account results; other providers run through a workflow and return HTTP 202 `accepted`.

  ```bash
  curl -i -X POST https://<your-host>/api/integrations/sync \
    -H 'content-type: application/json' \
    --data '{"platform":"youtube"}'
  ```

## Reconnecting an expired channel

When a token expires or access is revoked, the connection status becomes `token_expired`, `revoked`, or `permission_denied`. The card then shows `connection_state: 'reauth_required'` with `available_actions` `['reconnect', 'view_permissions']`. A proactive refresh sweeper (`backend/integrations/refresh-sweeper.ts`) also tries to renew tokens before they lapse.

To reconnect:

1. **Click reconnect on the card.** This calls `handleOauthReconnect` (`app/api/integrations/handlers.ts`), which looks up the connection by provider and tenant. If there is no existing `integration_id`, it returns HTTP 404 `connection_not_found` (there is nothing to reconnect; use the connect flow instead). Otherwise it calls `oauthReconnect` with the stored `connection_id`, a fresh `redirect_uri`, scopes, and optional `auth_type`. To force the provider's full re-auth screen, pass `auth_type: 'reauthenticate'`. Expected result: HTTP 200 with `broker_status: 'ok'` and a new `authorization_url`.

2. **Re-authorize with the provider** using the new `authorization_url`, same as the first connect. Expected result: the card returns to `connected` / `healthy`.

You can also renew a still-valid token without a full re-auth via `POST /api/oauth/{provider}/refresh` (`oauthRefresh`). The tenant is derived server-side; a body-level `tenant_id` is ignored. Optional body fields: `token_expires_in_seconds` and `refresh_expires_in_seconds`. It returns HTTP 200 when `broker_status === 'ok'`, otherwise 400, and 403 if you are not authenticated.

```bash
curl -i -X POST https://<your-host>/api/oauth/linkedin/refresh \
  -H 'content-type: application/json' \
  --data '{"token_expires_in_seconds":3600}'
```

To remove a channel, use the card's disconnect action or `POST /api/integrations/disconnect` (also `POST /api/oauth/{provider}/disconnect`) with the `platform` field. Disconnect returns HTTP 404 `connection_not_found` when there is no live connection to remove.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Connect returns HTTP 503 `provider_unavailable` | Provider client credentials are missing, or `OAUTH_TOKEN_ENCRYPTION_KEY` is unset/invalid. The crypto layer throws `missing_required_fields:OAUTH_TOKEN_ENCRYPTION_KEY` (empty) or `validation_error:OAUTH_TOKEN_ENCRYPTION_KEY_must_be_32_bytes` (wrong length), and the callback maps these to `provider_unavailable`. | Set the provider env vars (see [docs/OAUTH_SCOPES.md](../OAUTH_SCOPES.md)) and a valid 32-byte `OAUTH_TOKEN_ENCRYPTION_KEY`. |
| Connect returns HTTP 409 `already_connected` | The channel is already connected for this tenant. | Use `sync_now` or `reconnect` instead of connecting again. |
| Card shows `disabled` / `health: error` | The provider is misconfigured (`connection_status === 'misconfigured'`), so `available_actions` is empty. | Fix the provider credentials, then reload the page. |
| Callback returns HTTP 401 `authorization_denied` | The user declined consent (`error=access_denied`) at the provider. | Re-run the connect flow and approve the requested scopes. |
| Callback returns HTTP 400 `invalid_state` | The state token is missing, too short, not found, mismatched, or expired (the pending state has a TTL). | Restart the connect flow from the dashboard so a fresh state is issued; do not reuse an old `authorization_url`. |
| Callback returns HTTP 400 `missing_required_fields` | The provider redirected back without an authorization `code`. | Retry the connect flow. |
| Callback returns HTTP 409 `provider_callback_error` | The provider rejected the token exchange. For Meta, a common case is `meta_no_pages_available`: the account owns no Pages. | Connect a provider account in good standing. For Meta, use a Facebook account that owns at least one Page with the admin role. |
| Reconnect returns HTTP 404 `connection_not_found` | There is no existing connection (`integration_id`) to reconnect. | Use the connect flow (step 3) instead of reconnect. |
| Refresh returns HTTP 403 | You are not authenticated; `getTenantContext()` threw. | Sign in and retry. |
| Meta card has no `sync_now` / `disconnect` | Meta is env-managed (`status_reason === 'env_managed'`) with a long-lived token from `META_ACCESS_TOKEN`. | Manage the Meta token through the environment, not the UI. The default Graph API version is `v21.0` (`META_GRAPH_API_VERSION`). |

> Note on callback routes: the broker constructs the provider `redirect_uri` as `${APP_BASE_URL}/api/auth/oauth/{provider}/callback` (in `lib/oauth-connect-input.ts` and `handleOauthReconnect`), and `docs/OAUTH_SCOPES.md` registers callback URLs with the same `/api/auth/oauth/...` path. That route exists (`app/api/auth/oauth/[provider]/callback/route.ts`), and so does a shorter `/api/oauth/{provider}/callback` route (`app/api/oauth/[provider]/callback/route.ts`); both delegate to `handleOauthCallbackHttp`. The registered callback URL therefore resolves to a real handler. The same `/api/auth/oauth/...` tree also exposes `connect`, `disconnect`, and `reconnect` routes.

## Related

- [OAuth providers and scopes](../OAUTH_SCOPES.md)
- [How to generate and approve a week of social content](../how-to/generate-and-approve-a-week.md)
- [Security model](../SECURITY_MODEL.md)
