# Estimated AI cost/day Grafana panel

`aries-estimated-cost-dashboard.json` is the fleet-monitoring dashboard for the
PESOSE `$100/day` claim. Every currency label says **Estimated**: Aries derives
it from Hermes-reported tokens using
`ARIES_AI_ESTIMATED_COST_PER_MILLION_TOKENS_CENTS` (default `250`, or $2.50 per
million tokens). A tenant-day appears once at least one AI run reports usage.
When coverage is incomplete, the amount is explicitly a partial lower-bound
estimate and the companion coverage panel shows the denominator.

## Install / verify

1. Import the JSON into the fleet Grafana instance.
2. Bind `DS_ARIES_POSTGRES` to the read-only Aries PostgreSQL datasource.
3. Confirm `aries-usage-rollup-worker` is healthy and
   `ARIES_USAGE_ROLLUP_ENABLED=1`.
4. Verify the panel shows one series per non-system tenant and the red threshold
   is exactly `$100/day`.
5. Cross-check one point with:

```sql
SELECT company_id, usage_date,
       total_cogs_cents / 100.0 AS estimated_cost_usd
FROM daily_company_usage
WHERE company_id <> 0
  AND tasks_with_usage_reported > 0
ORDER BY usage_date DESC, company_id;
```

The dashboard is provisioning-safe but importing it into the external fleet
Grafana is an operator action; this repository intentionally does not carry
fleet Grafana credentials or mutate that service during application deploys.
