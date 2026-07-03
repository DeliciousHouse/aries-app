# Aries AI — OAuth Providers and Scopes

Aries integrates with six social platforms plus Google for authentication. Each provider requires an app registration and specific OAuth scopes.

## Provider overview

| Provider | Auth mechanism | Env vars |
|---|---|---|
| Meta (Facebook / Instagram) | Long-lived page token (env-managed) | `META_APP_ID`, `META_APP_SECRET`, `META_PAGE_ID`, `META_ACCESS_TOKEN` |
| Google (YouTube) | OAuth 2.0, brokered by Aries | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| LinkedIn | OAuth 2.0, brokered by Aries | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` |
| X (Twitter) | OAuth 2.0 PKCE, brokered by Aries | `X_CLIENT_ID`, `X_CLIENT_SECRET` |
| TikTok | OAuth 2.0, brokered by Aries | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` |
| Reddit | OAuth 2.0, brokered by Aries | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` |

For Aries-managed OAuth providers (Google/YouTube, LinkedIn, X, TikTok, Reddit), also set:

```bash
OAUTH_TOKEN_ENCRYPTION_KEY=<openssl rand -base64 32>
```

This key encrypts stored access and refresh tokens in the database. It must remain stable; rotating it invalidates all stored tokens.

---

## Meta (Facebook and Instagram)

Meta publishing in Aries is env-managed rather than user-OAuth-brokered. Aries uses a long-lived Page access token configured in the environment.

**Required env vars:**

```
META_APP_ID=<your Meta App ID>
META_APP_SECRET=<your Meta App Secret>
META_PAGE_ID=<target Facebook Page ID>
META_AD_ACCOUNT_ID=<ad account ID, if used>
META_ACCESS_TOKEN=<long-lived Page access token>
```

**App permissions required in the Meta developer dashboard:**

| Permission | Purpose |
|---|---|
| `pages_show_list` | List pages the user manages |
| `pages_manage_posts` | Create and manage Page posts |
| `pages_read_engagement` | Read Page engagement metrics |
| `pages_manage_metadata` | Manage Page metadata |
| `business_management` | Access Business Manager resources |
| `instagram_basic` | Read basic Instagram account info |
| `instagram_content_publish` | Publish media to Instagram |

**Callback URL** (register in Meta developer console):

```
https://<APP_BASE_URL>/api/auth/oauth/facebook/callback
```

Note: Aries routes both Facebook and Instagram connections through the Meta adapter family. Instagram OAuth authorization is not supported as a separate Aries-brokered flow; it uses the Facebook app permissions above.

---

## Google (YouTube)

YouTube publishing uses the Google OAuth 2.0 flow with `access_type=offline` for refresh token support.

**Required env vars:**

```
GOOGLE_CLIENT_ID=<your Google OAuth Client ID>
GOOGLE_CLIENT_SECRET=<your Google OAuth Client Secret>
```

These credentials also serve the next-auth Google sign-in provider.

**Scopes requested:**

| Scope | Purpose |
|---|---|
| `https://www.googleapis.com/auth/youtube.upload` | Upload videos to YouTube |

**Callback URL** (register in Google Cloud Console → OAuth 2.0 Credentials):

```
https://<APP_BASE_URL>/api/auth/oauth/youtube/callback
```

---

## LinkedIn

**Required env vars:**

```
LINKEDIN_CLIENT_ID=<your LinkedIn App Client ID>
LINKEDIN_CLIENT_SECRET=<your LinkedIn App Client Secret>
```

**Scopes requested:**

| Scope | Purpose |
|---|---|
| `w_member_social` | Create, modify, and delete posts on behalf of the member |

**Callback URL** (register in LinkedIn Developer Portal):

```
https://<APP_BASE_URL>/api/auth/oauth/linkedin/callback
```

---

## X (Twitter)

X uses OAuth 2.0 with PKCE (S256 code challenge).

**Required env vars:**

```
X_CLIENT_ID=<your X OAuth 2.0 Client ID>
X_CLIENT_SECRET=<your X OAuth 2.0 Client Secret>
```

**Scopes requested:**

| Scope | Purpose |
|---|---|
| `tweet.read` | Read Tweets |
| `tweet.write` | Create Tweets |
| `users.read` | Read user profile info |
| `media.write` | Upload media |
| `offline.access` | Refresh tokens (required for long-lived access) |

**Callback URL** (register in X Developer Portal):

```
https://<APP_BASE_URL>/api/auth/oauth/x/callback
```

---

## TikTok

**Required env vars:**

```
TIKTOK_CLIENT_KEY=<your TikTok App Client Key>
TIKTOK_CLIENT_SECRET=<your TikTok App Client Secret>
```

TikTok uses `client_key` rather than `client_id` in the authorization URL.

**Scopes requested:**

| Scope | Purpose |
|---|---|
| `video.publish` | Publish videos to TikTok |

**Callback URL** (register in TikTok Developer Portal):

```
https://<APP_BASE_URL>/api/auth/oauth/tiktok/callback
```

---

## Reddit

Reddit requests `duration=permanent` for long-lived refresh token support.

**Required env vars:**

```
REDDIT_CLIENT_ID=<your Reddit App Client ID>
REDDIT_CLIENT_SECRET=<your Reddit App Client Secret>
REDDIT_USER_AGENT=AriesOAuthBroker/1.0
```

**Scopes requested:**

| Scope | Purpose |
|---|---|
| `submit` | Submit links and text posts to subreddits |

**Callback URL** (register in Reddit App Preferences):

```
https://<APP_BASE_URL>/api/auth/oauth/reddit/callback
```

---

## Token storage

All Aries-brokered OAuth tokens are encrypted with `OAUTH_TOKEN_ENCRYPTION_KEY` before being written to the `oauth_tokens` table in PostgreSQL. Access tokens and refresh tokens are stored separately with expiry metadata. Token refresh happens on demand via `POST /api/oauth/[provider]/refresh` (there is no scheduled background refresh sweep).

## Graph API version

The Meta Graph API version used in authorization URLs defaults to `v21.0`. Override with `META_GRAPH_API_VERSION` if needed.
