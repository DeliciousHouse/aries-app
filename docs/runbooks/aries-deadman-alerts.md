# Aries dead-man alerts

The private GEN-39 Prometheus scraper authenticates to `GET /metrics` with `INTERNAL_API_SECRET`. Never expose the secret or Prometheus publicly.

## AriesMarketingTriggerStalled

1. Compare `marketing_schedule.last_attempt_at` and `last_success_at` for the alert's tenant.
2. Check the `aries-weekly-trigger-worker` logs for timeout, gate, or Hermes submission errors.
3. Verify Hermes with `/api/health/hermes`; fix the dependency before retrying. Do not advance `last_success_at` manually.

## AriesPublishFreshnessStale

1. Inspect `scheduled_posts` queue depth and `scheduled_post_dispatches` failures.
2. Confirm at least one tenant has due approved content; an intentionally empty fleet is not a publishing incident.
3. Follow [content pipeline recovery](content-pipeline-recovery.md) for dead-letter or manual-reconciliation rows.

## AriesAccountReauthorizationRequired

1. Identify affected rows with `SELECT tenant_id, platform, provider FROM connected_accounts WHERE status = 'reauthorization_required';`.
2. Ask the tenant administrator to reconnect that platform through the normal integration flow.
3. Confirm the row returns to `connected` and the dependency degraded gauge clears.

## AriesDispatchFailuresRising

1. Group recent failures by `failure_class` in `scheduled_post_dispatches`.
2. Follow [content pipeline recovery](content-pipeline-recovery.md#dispatch-dead-letters); never blindly replay an `outcome_unknown` dispatch.
3. Confirm the queue drains and the failed-count gauge stops increasing.

## Validation

Run `promtool test rules ops/alerts/aries-deadman.rules.test.yml`. The fixture contains one firing case for every alert.
