# Composio analytics → rendered dashboard (render bridge)

**Status:** planned. Foundation shipped (provider + per-platform mappers +
capability + tests, v0.1.15.9). The render half is blocked on a **live connected
account** for verification (guardrail: only live-verified, rendered UI counts as
done — never mock-passing).

## Goal

Render Composio-sourced analytics for all connected platforms in the operator
dashboard, by feeding the **existing** insights module (`backend/insights/*`,
`insights_accounts` / `insights_posts` / `insights_post_metrics_daily` /
`insights_account_metrics_daily`, read API `/api/insights/*`) rather than
building a parallel surface.

## What already exists (do not rebuild)

- `InsightsAdapter` contract (`backend/insights/adapters/_adapter.types.ts`):
  `fetchAccountMetrics`, `fetchPostList`, `fetchPostMetrics`, `fetchComments`.
- Dispatcher (`backend/insights/sync/dispatcher.ts`): calls the adapter, upserts
  `insights_posts` + `insights_post_metrics_daily` + `insights_account_metrics_daily`,
  stamps `last_metrics_fetched_at`. Registry in `adapter-factory.ts`.
- 30-min worker (`scripts/automations/insights-sync-worker.ts`, docker service
  `aries-insights-sync-worker`).
- Read API (`backend/insights/read-api.ts`): `/api/insights/summary|posts|account-metrics|comments`.

## Work

1. **ComposioInsightsAdapter** (`backend/insights/adapters/composio/`): implement the
   4 methods using `ComposioGateway` + `analytics-mappers.ts`.
   - `fetchPostList`: seed from Aries' own `posts` table (tenant's published
     `platform_post_id` + `platform`), not platform discovery — we published them.
   - `fetchPostMetrics`: call the post mapper → map `NormalizedMetrics` snapshot to
     a single dated `RawPostMetricsDay` (views/reach→… ; `comments`→`commentsCount`).
     Note Raw types are non-null `number`; carry null→leave column null by relaxing
     the dispatcher INSERT (or extend Raw types to `number|null`).
   - `fetchAccountMetrics`: account mapper → `RawAccountMetricsDay`.
   - `fetchComments`: map `FACEBOOK_GET_POST_COMMENTS` / IG equivalents (discover
     slugs via Composio MCP), or return [] initially.
   - Register `facebook`/`instagram`/`youtube`/`tiktok`/`linkedin` in `adapter-factory.ts`.
2. **Seed `insights_accounts`** from `connected_accounts` (one row per connected
   platform; `external_account_id` from the connection) so the worker has accounts to sync.
3. **Schema gap:** add `impressions` column to `insights_post_metrics_daily`
   (Composio provides it; schema lacks it). Ads metrics (spend/cpm/cpc/ctr/roas)
   need a separate `insights_ad_metrics_daily` table or JSONB.
4. **UI:** the results screen reads runtime posts, not insights tables. Add an
   analytics panel/page that calls `/api/insights/summary` + `/api/insights/posts`
   + `/api/insights/account-metrics` and renders per-post + account metrics with
   explicit "unavailable" states (brand tokens).
5. **Flags/worker:** ensure insights tables present, enable the sync worker for the
   tenant, set `ANALYTICS_PROVIDER=composio`.

## Verification (the gate)

Connect a real FB/IG account → publish (or use an existing) post → run a sync →
confirm real metrics render in the dashboard. No step counts as done on
mock/test data alone.

## Dependency

Blocked on a live Composio connection: needs `COMPOSIO_API_KEY` (set) + an
auth-config id (`ac_...`) in the prod `.env` + the user connecting an account.
