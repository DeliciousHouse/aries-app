# Tenant lifecycle and connection health

## Schema and tenant kinds

`npm run db:init` applies both B7 schema additions; the SQL files are also available as
`migrations/20260819000000_organization_kind.sql` and
`migrations/20260819000000_connection_health_nudges.sql`. The startup initializer does
not identify migrations by filename timestamps. Both files must be retained.

Existing and newly created organizations default to `production`. Nothing infers
kind from an organization name. Operators can inspect with `npm run tenant:kind -- list`
and explicitly classify an approved canary with
`npm run tenant:kind -- set <organization-id> test`. The publish canary refuses any
other kind. `archived` is a classification, not deletion or an access-control lock.

Fleet metrics and quota alerts default to production only. Explicit diagnostic
inclusion is `ARIES_FLEET_TENANT_KINDS=production,test`; the Python monitor uses
`PIPEMON_TENANT_KINDS=production,test`. Connection-owner emails remain production-only.

## Connections and controlled nudge verification

1. Sign in to the intended workspace and open `/dashboard/settings/channel-integrations`.
2. The screen reads `GET /api/integrations/composio` with no browser-supplied tenant ID.
   Stored connections are refreshed from Composio. An upstream error appears as a
   per-platform advisory, not a fabricated healthy status.
3. Each platform shows status and its latest successful **scheduled dispatch** time.
   No dispatch history means “No successful posts yet”; unavailable reads surface an
   error with retry. Manual/non-Aries posts are not included in this timestamp.
4. Reconnect or Finish connecting POSTs the platform's existing connect endpoint and
   follows its returned OAuth URL. Returning from approval refreshes the same screen.
5. Run `NODE_ENV=test APP_BASE_URL=https://aries.example.com npx tsx --test tests/connections-health-screen.test.ts tests/channel-integrations-connection-health.test.ts tests/connection-health-nudges.test.ts tests/email-notifications.test.ts`.
   The controlled nudge test invokes the real hourly worker and email renderer with
   only the transport intercepted; it sends no customer mail.

The existing usage-rollup worker runs nudges when `ARIES_CONNECTION_NUDGES_ENABLED=1`,
even with rollups disabled. This ships **off**. Enabling requires the normal DB, public
`APP_BASE_URL`, and Resend email configuration on that worker. No rollout was performed
by this implementation. Pending must exceed seven days; reauthorization is eligible
on the next sweep. Recipients are active tenant-admin memberships.

Nudges claim one durable row per unhealthy transition **before** attempting mail.
A crash or ambiguous delivery failure can miss one nudge; it will not automatically
resend. Consequently the `last_sent` metric records the claimed attempt, not proof
of inbox delivery. Unhealthy state remains visible independently of nudge rollout.
PostgreSQL transition microseconds are preserved so claims join their exact state.

For the real SQL regression, point all five `DB_*` variables at a disposable Postgres
and run `npx tsx --test tests/tenant-lifecycle.requires-infra.test.ts`. It uses a
transaction-local schema, rolls back, and runs in the existing PostgreSQL CI job.

## Proposal-only owner digest

`npm run report:duplicate-org-hygiene` performs one SELECT and prints a structured
`duplicate_organization_hygiene_proposal` JSON item. It contains merge/keep/archive
recommendations, source organization IDs, activity evidence, and
`proposalOnly: true` / `requiresOwnerSignOff: true`. Names and activity are heuristics,
not proof of common ownership. No execution command is generated or run.

The original B7 dev-lead handoff owns reading the actual target database and posting
that JSON as the owner digest item. Fixture output is not a production disposition
list. This PR supplies and tests the report; it does not claim production extraction
or digest delivery. Do not merge, archive, or delete organizations from this proposal
without separate explicit approval.

## Rollback

Keep the nudge flag off to stop mail, and revert the application version if needed.
The additive kind/status/claim schema can remain; do not drop claims (that could
resend old nudges). No organization cleanup or production data migration is part of
local verification.
