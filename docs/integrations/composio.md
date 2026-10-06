# Composio integration

Composio is an **optional, isolated** provider layer that lets end users connect
their own social and advertising accounts (Facebook, Instagram, Meta Ads,
YouTube, LinkedIn, Reddit) for publishing and analytics. It sits behind
Aries-owned abstractions. Publishing through the factory requires Composio;
unscoped direct Meta selection and fallback are disabled.

> **Default state: OFF.** With `COMPOSIO_ENABLED=false` (or unset), no Composio
> SDK is loaded. Facebook/Instagram factory publishing fails closed.

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
COMPOSIO_YOUTUBE_AUTH_CONFIG_ID=
COMPOSIO_LINKEDIN_AUTH_CONFIG_ID=
COMPOSIO_REDDIT_AUTH_CONFIG_ID=

PUBLISH_PROVIDER=composio              # direct_meta / auto publishing is disabled
ANALYTICS_PROVIDER=direct_meta         # direct_meta | composio | auto
```

Provider selection:

- Publishing: `composio` requires `COMPOSIO_ENABLED=true`; `direct_meta` and
  `auto` throw `direct_meta_unscoped`. There is no global-credential exception.
- Analytics: `direct_meta` reports unavailable; `auto` can fall back to those
  unavailable metrics, never fabricated insights.

**The master switch wins:** `COMPOSIO_ENABLED=false` forces `direct_meta`
regardless of the selectors. The publisher factory rejects that selection.
Global `META_PAGE_ID` / `META_ACCESS_TOKEN` do not establish a tenant connection
or publishing capabilities. Remove both from production environment sources
and verify key absence on every app/worker container during deployment. Never
print their values or restore unscoped publishing as a rollback.

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
explains a wholesale gap (no mapper for the platform/op, no active connection,
unsuccessful call).

Analytics ships with **verified default tool slugs** per platform
(`backend/integrations/composio/analytics-mappers.ts`), so it works once an
account is connected — no per-op slug config required (a
`COMPOSIO_<PLATFORM>_<OP>_ACTION` env var still overrides the default). Each
mapper builds the tool's real arguments (IG needs `ig_media_id` + a `metric[]`,
FB needs `page_id`, YouTube `id[]`, LinkedIn a `urn:li:organization:` URN, Meta
Ads `object_id` + `level`) and parses its real response shape (Graph
`data[].values[].value`, YouTube `items[].statistics`, LinkedIn
`elements[].totalShareStatistics`, Meta Ads rows).

Verified analytics tools (2026-06-03):

| Platform | Post insights | Account insights | Ad insights |
|---|---|---|---|
| Facebook | `FACEBOOK_GET_POST_INSIGHTS` | `FACEBOOK_GET_PAGE_INSIGHTS` | — |
| Instagram | `INSTAGRAM_GET_IG_MEDIA_INSIGHTS` | `INSTAGRAM_GET_USER_INSIGHTS` | — |
| YouTube | `YOUTUBE_GET_VIDEO_DETAILS_BATCH` | `YOUTUBE_GET_CHANNEL_STATISTICS` | — |
| LinkedIn | — (org-level only) | `LINKEDIN_GET_SHARE_STATS` | — |
| Meta Ads | — | — | `METAADS_GET_INSIGHTS` (toolkit `metaads`) |
| Reddit | — | — | — |

Platforms/ops with no tool report `unavailable` rather than guessing. FB post
metrics are limited to `post_media_view` (Facebook deprecated most post metrics
in Nov 2025). Meta Ads requires its own `metaads` connection (custom auth config).

> **Note:** the provider + mappers are validated infrastructure. Rendering these
> metrics in the operator dashboard goes through the existing insights module
> (`backend/insights/*`) via a Composio `InsightsAdapter` — see
> `docs/plans/2026-06-03-composio-analytics-render.md`. That bridge is verified
> against a live connected account, so it lands once an account is connected.

## Connection endpoints

Isolated under `/api/integrations/composio/*` so the surface is removable
without touching any existing route:

- `POST /api/integrations/composio/:platform/connect` → `{ connectUrl }`
- `GET  /api/integrations/composio` → `{ connections }`
- `GET  /api/integrations/composio/:platform/capabilities` → `{ capabilities }`
- `DELETE /api/integrations/composio/:platform` → `{ disconnected }`

UI: `/connections` (`frontend/integrations/composio-connections-screen.tsx`).

## Fallback behavior

There is no direct Meta publishing fallback. Facebook/Instagram `auto`
selection fails before constructing a publisher. Composio-only platforms keep
their existing tenant-connected Composio routing. The legacy direct Graph
adapter resolves tenant-scoped OAuth DB credentials, never global env tokens.

## Security notes

- Aries stores the **Composio connected-account id** and the **auth config id**,
  never raw OAuth access/refresh tokens. The `connected_accounts` table has no
  token column by design.
- Disabling Composio leaves the table unused and harmless.
- The UI never exposes developer terms (OAuth client id, redirect URI, access
  token, app secret, auth config) to end users.

## How to disable Composio

Set `COMPOSIO_ENABLED=false`. Facebook/Instagram factory publishing will be
unavailable, not silently routed to a global Meta account.

## How to remove Composio entirely

1. Delete `backend/integrations/composio/` and
   `backend/integrations/providers/` (or keep providers and just delete the
   composio dir only after replacing its factory imports; no publishing fallback).
2. Delete `app/api/integrations/composio/`, `app/connections/`, and
   `frontend/integrations/composio-connections-screen.tsx`.
3. `DROP TABLE connected_accounts;`
4. Remove the `COMPOSIO_*` / `PUBLISH_PROVIDER` / `ANALYTICS_PROVIDER` env vars.

Nothing in the existing direct Meta path depends on any of the above.
