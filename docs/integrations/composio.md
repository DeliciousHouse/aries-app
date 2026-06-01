# Composio integration

Composio is an **optional, isolated** provider layer that lets end users connect
their own social and advertising accounts (Facebook, Instagram, Meta Ads,
TikTok, YouTube, LinkedIn, Reddit) for publishing and analytics. It sits behind
Aries-owned abstractions and **never replaces** the existing direct Meta path —
which remains the default and the fallback.

> **Default state: OFF.** With `COMPOSIO_ENABLED=false` (or unset), no Composio
> code is loaded and Aries behaves exactly as before.

## What Composio does

- Provides a one-click **account connection** flow for end users (no developer
  terms exposed in the UI).
- Executes **publishing** (organic posts; ads as PAUSED drafts) through the
  Composio toolkit tools.
- Reads **analytics** and normalizes them into a single metric envelope.
- Reports a per-account **capability matrix** so the UI can show exactly what a
  connection can and cannot do.

## Architecture

Aries codes against four provider interfaces
(`backend/integrations/providers/interfaces.ts`); concrete providers implement
them:

| Interface | Direct Meta | Composio |
|---|---|---|
| `AccountConnectionProvider` | — (env-managed) | `ComposioAccountProvider` |
| `PublisherProvider` | `DirectMetaProvider` (organic FB/IG) | `ComposioPublisherProvider` |
| `AnalyticsProvider` | `DirectMetaProvider` (reports unavailable) | `ComposioAnalyticsProvider` |
| `CapabilityProvider` | `DirectMetaProvider` | `ComposioCapabilityProvider` |

`backend/integrations/providers/provider-factory.ts` is the only place flags
turn into providers. The Composio adapter
(`backend/integrations/composio/`) is loaded **lazily** — only when selected —
and the `@composio/core` SDK is imported lazily inside the gateway, so a
deployment without the package or without Composio enabled never touches it.

```
app / api routes  ->  providers (factory)  ->  DirectMetaProvider  -> meta-publishing.ts (unchanged)
                                            \-> Composio adapter    -> @composio/core (lazy)
```

## Required env vars

```bash
COMPOSIO_ENABLED=false                 # master switch (default OFF)
COMPOSIO_API_KEY=                      # required when enabled
COMPOSIO_DEFAULT_AUTH_CONFIG_ID=       # fallback auth config for any platform
COMPOSIO_METAADS_AUTH_CONFIG_ID=
COMPOSIO_FACEBOOK_AUTH_CONFIG_ID=
COMPOSIO_INSTAGRAM_AUTH_CONFIG_ID=
COMPOSIO_TIKTOK_AUTH_CONFIG_ID=
COMPOSIO_YOUTUBE_AUTH_CONFIG_ID=
COMPOSIO_LINKEDIN_AUTH_CONFIG_ID=
COMPOSIO_REDDIT_AUTH_CONFIG_ID=

PUBLISH_PROVIDER=direct_meta           # direct_meta | composio | auto
ANALYTICS_PROVIDER=direct_meta         # direct_meta | composio | auto
```

Provider selection:

- `direct_meta` — use the existing Meta flow (default).
- `composio` — use Composio only (requires `COMPOSIO_ENABLED=true`).
- `auto` — try Composio first, fall back to direct Meta where applicable.

**The master switch wins:** `COMPOSIO_ENABLED=false` forces `direct_meta`
regardless of `PUBLISH_PROVIDER` / `ANALYTICS_PROVIDER`.

### Action (tool) slugs

Composio executes platform actions by slug (`composio.tools.execute(slug, …)`).
Slugs vary by toolkit version, so Aries does **not** guess them. Set the ones
you have verified for your account:

```
COMPOSIO_<PLATFORM>_<OPERATION>_ACTION
# operations: PUBLISH_POST, UPLOAD_MEDIA, POST_INSIGHTS, AD_INSIGHTS,
#             ACCOUNT_INSIGHTS, CREATE_AD, LIST_AD_ACCOUNTS, LIST_PAGES, ACCOUNT_INFO
# e.g. COMPOSIO_FACEBOOK_PUBLISH_POST_ACTION=FACEBOOK_CREATE_PAGE_POST
```

An operation whose slug is unset is reported **unavailable** — never executed
against a guessed slug, never fabricated.

## Configuring custom auth configs

Some toolkits ship with Composio-managed credentials; others (notably **Meta
Ads**) typically require a **custom auth config** created in the Composio
dashboard. Create the auth config there, then set the matching
`COMPOSIO_<PLATFORM>_AUTH_CONFIG_ID`. If none is set for a platform,
`COMPOSIO_DEFAULT_AUTH_CONFIG_ID` is used; if that is also unset, starting a
connection for that platform returns a clear configuration error.

## Managed vs custom auth, per platform

| Platform | Auth | Notes |
|---|---|---|
| Facebook | managed (usually) | Requires a connected **Page**, not just a profile. |
| Instagram | managed (usually) | Requires a **Business/Creator** account linked to a Page. |
| Meta Ads | **custom likely** | Managed app may be unavailable; confirm ad-account access. |
| TikTok | managed (usually) | Deeper analytics may be unavailable. |
| YouTube | managed (usually) | Deep analytics needs the YouTube Analytics API. |
| LinkedIn | managed (usually) | Prefer an **Organization Page** for business use. |
| Reddit | managed (usually) | Public engagement only; no reach/impressions. |

## Capability matrix

`GET /api/integrations/:platform/capabilities` returns:

```jsonc
{
  "canPublishOrganic": false,
  "canPublishAds": false,
  "canReadPostInsights": false,
  "canReadAdInsights": false,
  "canUploadMedia": false,
  "missingPermissions": ["facebook.publish_post action slug"],
  "warnings": ["Confirm a Facebook Page is connected …"],
  "provider": "composio"
}
```

A capability is `true` only when both (a) the connection is ACTIVE and (b) the
relevant action slug is configured. Otherwise it stays `false` with the reason
in `missingPermissions` / `warnings`.

## Publishing behavior

- **Ads/campaigns are always created PAUSED/draft.** `publishAd` forces a
  `PAUSED` status on every Meta-family axis and only ever reports `paused`.
- **Organic posts** support **dry-run first** (`dryRun: true` → `preview`, no
  side effect) and refuse a live post unless `approved: true` — set only after
  the existing Aries approval flow has cleared it.
- Normalized result: `{ provider, platform, externalPostId, externalCampaignId,
  externalAdId, status, url, rawResponse }`.

## Analytics behavior

Metrics are normalized into one envelope (`NormalizedMetrics`). Every numeric
field is `number | null`; **a missing metric is `null`, never a fabricated 0**.
`rawMetrics` keeps the untouched provider payload, and `unavailableReason`
explains a wholesale gap (no slug, no active connection, unsuccessful call).

## Connection endpoints

Isolated under `/api/integrations/composio/*` so the surface is removable
without touching any existing route:

- `POST /api/integrations/composio/:platform/connect` → `{ connectUrl }`
- `GET  /api/integrations/composio` → `{ connections }`
- `GET  /api/integrations/composio/:platform/capabilities` → `{ capabilities }`
- `DELETE /api/integrations/composio/:platform` → `{ disconnected }`

UI: `/connections` (`frontend/integrations/composio-connections-screen.tsx`).

## Fallback behavior

In `auto` mode, a Composio failure (or an unsupported platform) falls back to
the direct Meta provider **only for platforms it supports** (Facebook,
Instagram). For Composio-only platforms (TikTok, YouTube, LinkedIn, Reddit, Meta
Ads) a failure surfaces as-is — there is nothing to fall back to.

## Security notes

- Aries stores the **Composio connected-account id** and the **auth config id**,
  never raw OAuth access/refresh tokens. The `connected_accounts` table has no
  token column by design.
- Disabling Composio leaves the table unused and harmless.
- The UI never exposes developer terms (OAuth client id, redirect URI, access
  token, app secret, auth config) to end users.

## How to disable Composio

Set `COMPOSIO_ENABLED=false` (and optionally `PUBLISH_PROVIDER=direct_meta`,
`ANALYTICS_PROVIDER=direct_meta`). No code change required.

## How to remove Composio entirely

1. Delete `backend/integrations/composio/` and
   `backend/integrations/providers/` (or keep providers and just delete the
   composio dir — the factory degrades to direct Meta).
2. Delete `app/api/integrations/composio/`, `app/connections/`, and
   `frontend/integrations/composio-connections-screen.tsx`.
3. `DROP TABLE connected_accounts;`
4. Remove the `COMPOSIO_*` / `PUBLISH_PROVIDER` / `ANALYTICS_PROVIDER` env vars.

Nothing in the existing direct Meta path depends on any of the above.
