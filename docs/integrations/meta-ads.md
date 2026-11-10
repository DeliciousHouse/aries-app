# Meta Ads account (read-only)

Meta Ads is a separate channel from the organic Facebook Page and Instagram publishing. Connecting or disconnecting it does not change those channels. The provider key is `meta_ads`; the business-profile label is **Meta Ads account**.

## Setup

- Use the existing `META_APP_ID`, `META_APP_SECRET`, `OAUTH_TOKEN_ENCRYPTION_KEY`, and `APP_BASE_URL` configuration. `META_GRAPH_API_VERSION` is optional (default `v21.0`). Never put credential values in documentation or client code.
- Register `${APP_BASE_URL}/api/auth/oauth/meta_ads/callback` as a valid OAuth redirect URI in the Meta app. Meta must permit `ads_read` and `ads_management` for the tenant/user; production access may require Meta app review. Both permissions are requested and verified before storing a connection.
- Apply `migrations/20261006210000_meta_ads_oauth_provider.sql` through the normal reviewed migration process before enabling the new provider on an existing database. `scripts/init-db.js` includes the same provider constraint for fresh databases.
- This release uses direct Meta OAuth. Composio documents Marketing API tools in its `metaads` toolkit but says Composio-managed OAuth is unavailable. Existing organic Composio connections remain unchanged.

## Use

1. In **Business Profile** or **Settings → Channel Integrations**, connect **Meta Ads account**. It is a separate reporting card, not a selectable weekly organic-content destination; existing generation-channel guards remain in place.
2. Choose one available `act_...` account and confirm it. Aries verifies access against Meta and stores its ID/name on the tenant's separate `oauth_connections` row. Reconnecting clears the selection; choose the account again.
3. In **Insights → All channels**, read **Meta Ads performance** beside organic results. Reporting follows the selected 7-, 30-, or 90-day preset and shows campaigns, status, spend in account currency, impressions and clicks. Missing metrics are **Unavailable**, never fabricated zeroes. Existing campaigns may spend independently of Aries.
4. Disconnect/reconnect when the user grant expires, is revoked, or loses account access. Aries never falls back to a global ad account or an organic Page token.

`GET /api/integrations/meta-ads` returns account choices; `?performance=1&period=7day|30day|90day` additionally reports the selected account. `POST` accepts only account selection (`accountId`, `connectionId`) and revalidates tenant/account ownership. No API to boost, create, activate or change a budget is provided.

## Paid actions are deferred

The requested campaign-specific owner approval, budget and idempotent provider execution are tracked on follow-up `t_6218b254`. Even the legacy Composio Meta Ads creation path is disabled until that contract exists. This source release grants no spending authorization. Live OAuth/account access and the migration must still be validated on the reviewed deployment; mocked tests and local component fixtures are not production acceptance.

## Checks

`NODE_ENV=test npx tsx --test tests/meta-ads-channel.test.ts tests/meta-ads-channel-ui.test.ts tests/composio-publisher.test.ts tests/direct-meta-provider.test.ts`

Also run the affected OAuth/integration regression tests and `npm run verify`. Required CI uses Node 24 and PostgreSQL on Ubuntu.
