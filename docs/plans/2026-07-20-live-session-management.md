# Live Social Session Management

> Status: proposed plan (2026-07-20). Supersedes and absorbs `docs/plans/2026-06-01-channel-health-reconnect-ui.md` (its banner, enriched cards, and "publishing paused" truth-endpoint land here as Phases 1 and 5; stamp that doc superseded in the Phase 1 PR). Produced by a multi-agent plan pipeline: 6-reader system map → 3 competing designs (operator-UX-first won 2/3 judge votes) → 26 judge grafts absorbed → 14 load-bearing claims adversarially verified against code (6 confirmed, 8 refined, 0 refuted) → 15 completeness-critic gaps folded in.

## 1. Problem statement

Operators cannot see or manage the health of the live social platform sessions that power publishing and insights:

- **Two schema-disjoint stores, no unified view.** Direct-Meta/native-OAuth sessions live in `oauth_connections`/`oauth_tokens` (scripts/init-db.js:136-174; encrypted token custody, expiry columns, audit trail); Composio sessions live in `connected_accounts` (scripts/init-db.js:224-246; a Composio pointer, **no tokens, no expiry data by design**). No FK or SQL join exists between them; `countConnectedMetaPlatforms` (lib/onboarding-gate.ts:75-104) is the only ad-hoc union. A third store, `insights_accounts` (UNIQUE(tenant_id, platform, external_account_id)), holds analytics identity and is linked to neither.
- **The rich session UI is orphaned.** The only components that render token expiry, AA-102 sync freshness, account identity, and sync-now — `frontend/settings/integrations.tsx` + `frontend/settings/platform-card.tsx` — are imported by **no mounted page**. The mounted Channel Integrations screen shows none of it.
- **Dead sessions render as "Connected".** A Composio row's `status` is never re-verified or downgraded after reaching `connected` — both reconcile paths filter `status='pending'` only (backend/integrations/composio/reconcile-pending-connections.ts:77; app/api/integrations/composio/handlers.ts:150-156), and `updateConnectionStatus` (connection-store.ts:152-163) is dead code. On the direct path, Meta page tokens are persisted with NULL expiry at connect time (backend/integrations/callback.ts:732-737, 753-758) so health reads `unknown` forever, and `oauthRefresh` has exactly one caller — the manual route (app/api/oauth/[provider]/refresh/route.ts:38); a former refresh sweeper was deleted.
- **Runtime auth failures feed back only partially.** The #519 taxonomy already classifies some Meta failures as `kind='auth'` and the scheduled-posts worker writes `auth: …reconnect required` into `scheduled_post_dispatches.error_message` — but Graph `OAuthException` code 190 (the common 60-day expiry) is **not** in `META_AUTH_FAILURE_CODES` (backend/integrations/meta-publishing.ts:128-131) and classifies `permanent`; on the Composio path an expired credential raises a retryable `ComposioToolError` (terminal only for Reddit permanent errors, composio-publisher-provider.ts:717-719) retried on 10/180-min backoff until `campaign_end_date` excludes the row. **No path writes `reauthorization_required` from a publish or insights failure.**
- **No alerting.** Per-tenant Slack infra exists (backend/integrations/slack/notifications.ts, `slack_notifications` dedupe) but fires only for marketing approval gates.
- **Status/UX defects.** For broker-backed providers, `reauthorization_required` renders as a pending state with no reconnect CTA (`statusFromInternal` maps it to `pending_oauth`, backend/integrations/status.ts:97); failed OAuth callbacks strand rows at `pending` (callback.ts:1019-1041 never upserts status); `'openai'` is in the connect `PROVIDERS` list but not the `oauth_connections` CHECK; the legacy settings-hub disconnect 404s for Composio-served rows (`integration_id` always undefined, status.ts:199-227 → handlers.ts:384-386); zero role gating on destructive session routes; `picker_payload` page tokens are stashed in plaintext (callback.ts:849-855).

## 2. Scope / non-goals

**In scope:** unified session visibility (identity, provider path, status, health, true expiry, last-success/last-verified, sync freshness, last publish outcome, scope coverage) across `oauth_connections`, `connected_accounts`, and env-managed rows including `meta_ads`; operator controls (connect, reconnect, manual refresh, verify-now, page re-pick, disconnect with real blast-radius confirm + role gate); truthful status via auth-failure writeback from publish/insights through ONE chokepoint; proactive detection (auto-refresh + verify probes); per-tenant Slack + dashboard alerting with rollup; consumer gating (defer, don't burn, on dead sessions).

**Non-goals:** multi-account-per-platform (UNIQUE(tenant_id, platform) stays — the multi-brand workspaces program owns that via workspace-per-brand); **cross-workspace session overview** (deferred to the multi-brand program; noted in §10); per-tenant provider selection (`COMPOSIO_ENABLED` stays process-wide); consolidating the two stores; Hermes-side changes; TikTok publisher; next-auth login sessions.

## 3. Design principles (judge-panel consensus)

1. **One chokepoint.** All status transitions flow through a single `backend/integrations/connection-health.ts` module (`recordConnectionAuthFailure`, `recordConnectionOk`, `recordConnectionStatus`) that owns the flip, the `status_changed_at` stamp, the `session_health_events` row, the audit event, and the Slack fire — mirroring the `notifyApprovalRequired` convergence discipline. No other writer.
2. **Verify before flip.** A text-signature auth match on a `ComposioToolError` never flips status or terminalizes a retry by itself — a live `gateway.getConnection` probe must confirm non-ACTIVE first (the composio-capability-provider idiom).
3. **Observability before writeback.** Classifiers land with writeback OFF so `kind='auth'` shows up in the `scheduled_post_dispatches` error taxonomy and logs first; the writeback flag flips only after at least one real prod auth failure classifies correctly.
4. **Structurally unreachable > carefully avoided.** The unverified Meta refresh path (fb_exchange_token on a page token) is excluded by an `ARIES_TOKEN_REFRESH_PROVIDERS` allowlist (default: non-Meta) until a live smoke test passes — not merely observed in dry-run.
5. **Operator-visible every phase.** Visibility ships first (Phases 0-1) on the mounted screen, so every later backend phase renders the day it lands.

## 4. Per-platform token lifecycle policy

The uniform "expiring soon" / auto-refresh semantics must respect per-platform reality; the worker consults this table (constant in `backend/integrations/sessions/lifecycle-policy.ts`):

| Platform / path | Access-token TTL | Refresh | Policy |
|---|---|---|---|
| Meta FB/IG direct (page token) | often non-expiring; user long-lived ~60d | `fb_exchange_token` unverified for page tokens | **debug_token probe first** for true expiry; refresh only on real approaching expiry AND allowlisted; else verify+alert |
| LinkedIn | ~60d | refresh token (60d) | auto-refresh at lead window |
| X (OAuth2) | ~2h | rotating refresh token | auto-refresh; rotation-safe via existing row lock |
| Reddit | ~1h | permanent refresh token | **exempt from expiring-soon alerts** (would always be "expiring"); refresh on demand/lead |
| TikTok | ~24h | refresh ~365d | auto-refresh at lead window |
| Composio (all) | provider-managed, opaque | Composio-managed | **no expiry countdown UI** (structurally unavailable); show `last_verified_at` + status instead |
| env-managed (`META_ACCESS_TOKEN`, `meta_ads`) | ~60d, invisible | manual rotation | verify-probe only; card labeled "server-managed credential" |

## 5. Phase overview

| Phase | Ships | Flag |
|---|---|---|
| 0 | Truth bugfixes (status mapping, stranded pending, openai CHECK, settings-hub deep-link) | none (bugfix) |
| 1 | Unified session read model + mounted UI (absorbs 2026-06-01 plan) | `ARIES_SESSION_MANAGER_ENABLED` |
| 2 | Schema + the connection-health chokepoint | none (additive schema; display rides Phase 1 flag) |
| 3 | Auth classifiers (observability first) → writeback | `ARIES_SESSION_AUTH_WRITEBACK_ENABLED` |
| 4 | Session-health worker (refresh/verify) + Composio verify leg on existing reconciler + Meta expiry capture | `ARIES_SESSION_HEALTH_ENABLED`, `ARIES_META_EXPIRY_CAPTURE_ENABLED` |
| 5 | Alerting: per-tenant Slack (rolled up) + dashboard banner | `ARIES_SESSION_ALERTS_ENABLED` |
| 6 | Control hardening: RBAC, blast-radius confirms, identity-preserving reconnect, picker encryption | `ARIES_SESSION_RBAC_ENABLED` |
| 7 | Consumer gating: dispatch defer, insights skip-with-reason, insights_accounts prune | `ARIES_SESSION_CONSUMER_GATING_ENABLED` |

Each phase is an independently shippable PR; later phases degrade gracefully when earlier flags are off.

---

## Phase 0 — Truth bugfixes (no flag; `fix(integrations)`)

The states that already exist stop lying. **Meta expiry capture is deliberately NOT here** — populating `token_expires_at` immediately activates the existing `token_expired`/reauth card states with no refresher yet live to heal them (an alarm nobody can auto-heal is worse than "unknown"); it moves to Phase 4 behind its own flag.

1. **Reauth renders as reauth.** `statusFromInternal` (backend/integrations/status.ts:97) stops collapsing `reauthorization_required` into `pending_oauth`; cards get the `reauth_required` state + `[reconnect, view_permissions]` actions. Update `lib/api/integrations.ts` types.
2. **Failed callbacks stop stranding `pending`.** Error paths in callback.ts (933-947, 1019-1041) upsert `status:'error'` + `last_error_code`/`last_error_message` alongside the existing state delete + audit.
3. **Reconcile the `openai` mismatch.** Remove `'openai'` from `PROVIDERS` (connect.ts:75) — refresh is unimplemented and the DB CHECK rejects it anyway.
4. **Settings-hub disconnect divergence.** For Composio-served rows (`integration_id` undefined), the settings screen deep-links to Channel Integrations instead of firing the legacy disconnect that 404s.

**Tests:** status-mapping units (reauth→reauth_required), callback-failure writes error, flag-none golden on unrelated cards; `npm run verify`.

## Phase 1 — Unified read model + mounted surface (`ARIES_SESSION_MANAGER_ENABLED`)

One screen showing every live session — identity, provider path, health, expiry (where knowable), sync freshness, last publish outcome — with working buttons. Flag helper `backend/integrations/sessions/session-manager-env.ts` (parses 1/true/yes/on, default OFF), compose + `.env.example` two-place wiring.

**Read model** (`backend/integrations/sessions/read-model.ts` → `loadTenantSessions(tenantId)`):
- **One SQL statement** unioning `oauth_connections` + `connected_accounts` (+ lateral latest-token expiry, + AA-102 sync telemetry — extract `loadSyncTelemetryByAccount` out of app/api/integrations/handlers.ts into `backend/insights/freshness/telemetry.ts` so backend owns it, + latest per-platform `scheduled_post_dispatches` outcome). No `Promise.all` (guardrail #1); no N-query fan-out.
- **Refactor `countConnectedMetaPlatforms` (lib/onboarding-gate.ts:75-104) onto this union** so exactly one canonical two-store authority resolution exists.
- Authority per platform follows the provider seam (`COMPOSIO_ENABLED` + selectors, status.ts:179-242): Composio-backed platforms read `connected_accounts`; direct/native read `oauth_connections`; env-managed rows surface as `providerPath:'env_managed'`. **`meta_ads` is included** (labeled "Meta Ads"). **Dual-store conflict** (both stores hold a row for one platform — possible for x/linkedin/reddit): authority row wins, card shows a "duplicate legacy connection" badge with a cleanup action; crosspost fan-out authority remains `connected_accounts`.
- `SessionView` is frontend-safe (never tokens or raw Graph bodies): platform, providerPath, status, health, statusReason, external identity, expiresAt (null for Composio — UI shows `last_verified_at` instead), lastSyncAt/syncState, lastPublishOkAt, lastError{code,message,at}, sinceWhen (`status_changed_at`), grantedScopes vs required-per-capability (**scope-coverage badge**: "limited permissions" when App-Review-gated scopes like `pages_manage_engagement`/`instagram_manage_comments` are absent — today `scopes_outdated` checks only `pages_show_list`), availableActions[].

**Routes:** `GET /api/integrations/sessions` (flag off → real 404; `loadTenantContextOrResponse`). Mutations reuse existing: Composio connect/DELETE, broker reconnect, and the never-consumed `POST /api/oauth/[provider]/refresh` gets its first UI consumer ("Refresh token" on direct-path cards).

**UI:** enrich the **mounted** Channel Integrations screen (server-component flag prop, the `imageEditEnabled` pattern); port expiry/freshness/identity/error rendering from the orphaned `frontend/settings/platform-card.tsx`, then delete the orphan (ends the AA-102 dead-code split). `reauthorization_required` rows get a primary **Reconnect** CTA. Settings-hub channels panel gains a health dot + "Manage sessions →" link.

**Tests:** union/authority-selection units per `COMPOSIO_ENABLED` combination; frontend-safety (no token field serializes); flag-off 404 + `GET /api/integrations` byte-identical golden; requires-infra live-schema read-model test (indexed in tests/REQUIRES_INFRA.md).
**Rollout:** land dark → staging flip → **screenshot-verify rendered cards on a live tenant** → prod flip.

## Phase 2 — Schema + connection-health chokepoint (additive; `feat(integrations)`)

- `connected_accounts` ADD `status_reason`, `last_error_code`, `last_error_message`, `last_verified_at`, `last_success_at`, `status_changed_at`.
- `oauth_connections` ADD `last_success_at`, `last_verified_at`, `status_changed_at`, `next_refresh_attempt_at` (the `scheduled_posts.next_attempt_at` backoff idiom — transient refresh failures get DB-diagnosable backoff instead of every-tick re-attempts against a flapping provider).
- New `session_health_events` (tenant_id, store CHECK('oauth'|'composio'), platform, event_type, detail JSONB, occurred_at; index (tenant_id, platform, occurred_at DESC)) — the Composio lifecycle writes no audit today and disconnect DELETEs the row; this is the cross-store timeline that survives. Retention: prune >180d rows — sign-off-gated follow-up alongside the oauth_tokens rotation-chain GC (nothing purges revoked token rows today; the worker multiplies them).
- Partial indexes for the sweep predicates (`WHERE status='connected' AND token_expires_at IS NOT NULL`; `WHERE status='connected'`) — the `idx_insights_sync_runs_running_started` idiom.
- **`backend/integrations/connection-health.ts`** (design principle 1): the only status writer; resurrects/absorbs `updateConnectionStatus`; persists Composio `GatewayConnection.statusReason` (captured then dropped today at composio-client.ts:22); predicate-re-checking idempotent UPDATEs; stamps `status_changed_at`; writes the event row; Slack firing (Phase 5) lives only here.
- All schema in scripts/init-db.js **+** `migrations/20260720…` (two-place schema rule); migration idempotency test; requires-infra live-schema test.

## Phase 3 — Auth classifiers → writeback (`ARIES_SESSION_AUTH_WRITEBACK_ENABLED`)

**Stage A (flag OFF — observability).** Classifiers merge and only tag:
- Meta: parse Graph error body; `OAuthException` code 190 (+subcodes 458-467, 102) → `META_AUTH_FAILURE_CODES` → `kind='auth'` (joins the existing #519 taxonomy; retry policy unchanged).
- Composio: `backend/integrations/composio/auth-signature.ts` — conservative signature match over `ComposioToolError` (`expired`, `invalid_grant`, `revoked`, 401/403 broker status; exact strings confirmed against live before widening).
- Insights dispatcher leg errors run the same classifier; auth-classified legs tagged `auth:` in `insights_sync_runs.error_message`.
Watch prod until ≥1 real auth failure classifies correctly. **Flip gate is empirical, not calendar.**

**Stage B (flag ON — writeback).** On `kind='auth'`:
- Direct path: fire-and-forget `recordConnectionAuthFailure(tenantId, provider, code, message)` from the dispatch route + manual publish handlers. **Fail-open — a writeback error never changes the publish outcome**; claim/rollback semantics untouched.
- Composio path: signature match → **live `gateway.getConnection` probe**; non-ACTIVE → chokepoint flip to `reauthorization_required` **and** the error becomes terminal (`retryable:false`, beside `PERMANENT_REDDIT_ERROR_TOKENS`) so the worker stops the 10/180-min retry loop. Flag off → byte-identical behavior.
- Publish/sync success paths stamp `last_success_at` (same fail-open wrapper).
- Intended downstream: a flipped row now correctly fails `requireActiveConnection`, drops out of `resolveCrosspostPlatforms`, and stops the weekly gate burning 4 pipeline stages on a zombie connection.

**Tests:** classifier fixtures (real Graph 190 payloads; Composio shapes); double-fire idempotency; fail-open; flag-off golden; terminal-vs-retryable matrix.
**Rollout:** staging drill with a deliberately revoked credential; prod flip together with Phase 5 so the flip is *seen*.

## Phase 4 — Proactive detection (`ARIES_SESSION_HEALTH_ENABLED` + `ARIES_META_EXPIRY_CAPTURE_ENABLED`)

**New sidecar** `scripts/automations/session-health-worker.ts` (tsx-run, `tickSafe` overlap guard with `finally` release, dormant-idle when off, `DB_POOL_MAX: 3`, own compose service **+ deploy.yml force-recreate block** — deploy-manifest parity test enforces). Logic in `backend/integrations/sessions/health-sweep.ts`. Sequential legs, per-row isolation, bounded batches (`MAX_VERIFY_BATCH` 40), **per-leg rate-limit guard**: on a 429/368/4/17/613-class response the leg aborts for this tick and the row's `next_refresh_attempt_at` (or verify skip) backs off — probes must never sustain the throttle they're probing.

1. **Direct-OAuth auto-refresh:** connected rows with `token_expires_at < now() + ARIES_SESSION_REFRESH_LEAD_HOURS` (default 72) and `next_refresh_attempt_at` passed, **filtered by `ARIES_TOKEN_REFRESH_PROVIDERS` allowlist (default: linkedin,x,reddit,tiktok,youtube — Meta excluded until the live page-token `fb_exchange_token` smoke test passes**; a failed smoke test needs zero code change to keep Meta on verify+alert). Calls `oauthRefresh` — already concurrency-safe (FOR UPDATE + 5s freshness skip) and already flips `reauthorization_required` on `unauthorized`; this is its first automated caller since the old sweeper was deleted.
2. **Meta true-expiry probe:** for facebook/instagram rows, probe **`debug_token` first** (new `backend/integrations/meta/debug-token.ts`, read-only) — page tokens are often non-expiring; persist the TRUE `expires_at` for the countdown UI, attempt exchange only on real approaching expiry, and on `is_valid:false`/code 190 → `recordConnectionAuthFailure`. **Companion flag `ARIES_META_EXPIRY_CAPTURE_ENABLED`**: callback.ts stops discarding `expiresInSeconds` (801-802) so new connects persist expiry — flipped only after this worker is live (no unhealable alarms). Sign-off-gated backfill CLI `scripts/marketing/backfill-meta-token-expiry.ts` populates existing NULL-expiry rows via debug_token.
3. **env-managed verify:** when Composio is off and env tokens serve Meta (status reads unconditionally connected today, status.ts:229-241), probe with `META_ACCESS_TOKEN`; failures surface on the "server-managed credential" card + alerts (no auto-heal possible).
4. **Composio connected-row verify — rides the EXISTING `aries-composio-reconciler-worker`** as a second, independently flag-gated leg (`ARIES_COMPOSIO_VERIFY_ENABLED`): it already has Composio creds + the verified tickSafe pattern; no second Composio-credentialed sidecar. Sweeps `status='connected'` rows on a 24h per-row cadence → `gateway.getConnection` → chokepoint on change (EXPIRED/REVOKED/INACTIVE → `reauthorization_required` — finally reachable post-connect), always stamping `last_verified_at`.

**Knobs (compose-wired, garbage→default):** `ARIES_SESSION_HEALTH_INTERVAL_MS` (900000), `ARIES_SESSION_REFRESH_LEAD_HOURS` (72), `ARIES_SESSION_VERIFY_INTERVAL_HOURS` (24), `ARIES_SESSION_HEALTH_DRY_RUN` (**one read-only prod observation cycle before first enable** — the draft-expiry pattern), `ARIES_TOKEN_REFRESH_PROVIDERS`.
**UI:** cards render "Verified 2h ago" + per-card **Verify now** (`POST /api/integrations/sessions/[platform]/verify`, admin, flag-gated 404).
**Tests:** predicate SQL units, batch bound, rate-limit abort, dry-run mutates nothing, tick-guard finally-release (mirror insights-sync-worker-tick-reset), requires-infra sweep test, deploy-parity auto-covers the service.

## Phase 5 — Alerting (`ARIES_SESSION_ALERTS_ENABLED`)

- `backend/integrations/slack/session-notifications.ts` mirroring `notifyApprovalRequired`: session-alerts flag AND the existing `isSlackNotificationsEnabled` master; per-tenant `loadSlackConfigForTenant` (fail-open null → skip, no global fallback); never-throws client; `slack_notifications` dedupe.
- **Rollup:** one credential death can flip FB+IG+meta_ads in one tick — notifications aggregate per tenant per tick into ONE message listing all affected platforms (no triple-ping).
- Kinds: `session_reauth_required` (dedupe key `session:<tenant>:<platform>:reauth:<status_changed_at epoch>` — the real column, so reconciler re-deliveries never re-ping but a re-break after repair does), `session_expiring_soon` (key on `token_expires_at` ISO; fired only when refresh failed or is unavailable per the §4 policy — Reddit exempt; default lead `ARIES_SESSION_EXPIRY_WARN_DAYS` 7), optional `connection_recovered` on reauth→connected (decide at phase review; drop if noisy).
- **Fire point: inside `connection-health.ts` only.**
- **Dashboard banner** (absorbs the 2026-06-01 plan): attention strip on the operator dashboard sourced from the read model — and *truthful* about consequences: "Instagram needs reconnect — N scheduled posts paused", the count derived from pending/deferred `scheduled_posts` for that platform. Renders nothing when healthy or flag off. Covers tenants with no Slack connection.

**Tests:** dedupe semantics (re-delivery no-repeat, re-break re-pings), rollup single-message, no-tenant-config skip, Slack outage never throws into the writeback path, flag-off zero writes, banner golden.

## Phase 6 — Control hardening (`ARIES_SESSION_RBAC_ENABLED`)

1. **RBAC:** `require-session-admin.ts` resolves role via `getTenantContext()` — which, under `ARIES_MULTI_WORKSPACE_ENABLED`, already sources role authority from the **membership row**, not `users.role` (the resolver must not read the legacy mirror directly). Viewer: read-only (403 `role_required` on destructive routes); analyst: refresh/verify/reconnect, no disconnect; admin: all. Default OFF (mounted-route behavior change); role-matrix staging pass before flip.
2. **Blast-radius confirm dialogs (real counts, not copy):** disconnect/clear modals query and display the actual consequences — N queued `scheduled_posts` (and whether `campaign_end_date` will silently expire them), the `marketing_schedule` weekly row (offer pause), linked `insights_accounts`. Typed-platform-name confirm.
3. **Identity-preserving Composio reconnect:** `POST /api/integrations/composio/[platform]/reconnect` snapshots `external_account_id/name`, runs the relink, and on reconcile warns if a *different* account was authorized — **and reconciles the linked `insights_accounts` row** on identity change so metrics stop attributing to the old account. (Open question: native Composio re-auth API for an existing connected account — swap internals if it exists; route contract unchanged.)
4. **Meta page re-pick outside onboarding:** "Change page" → existing `reauthenticate` → select-page flow; **encrypt `picker_payload` page tokens with `encryptToken`** (plaintext-at-rest fix, callback.ts:849-855); the re-pick also updates `insights_accounts`.
5. **Provider-side revoke on disconnect:** LinkedIn/X/Reddit revocation endpoints wired into `oauthDisconnect`; Meta documented honestly on the dialog (page token remains valid at Meta until expiry — no user token persisted to revoke with) + audit `revoke_provider_token:false`.
6. **Dead-surface cleanup:** delete `GET /api/platform-connections` (zero consumers) and the unrouted unauthenticated `handleOauth*Http` exports (cross-tenant foot-gun).

## Phase 7 — Consumer gating (`ARIES_SESSION_CONSUMER_GATING_ENABLED`)

Stop burning work on known-dead sessions; preserve posts across a quick reconnect:
- **Scheduled-dispatch pre-check DEFERS** (retryable, reusing `scheduled_posts.next_attempt_at` backoff) when the target session is `reauthorization_required`, instead of attempting a doomed publish. Interaction with `campaign_end_date` is explicit: deferred rows past campaign end are excluded by design (never publish after the window) — the Phase 5 banner's "N posts paused" count and the Phase 6 dialog make that consequence visible *before* it happens, and the reconnect flow surfaces "M deferred posts will resume; K are past their campaign window and will not".
- **Insights dispatcher skips** reauth-required accounts with a distinct `connection_reauth_required` leg error so freshness copy says *why* it's stale (no more silent quota burn).
- **`insights_accounts` prune** for connections deleted ≥7d (ends the eternal 30-min sync attempts against removed accounts). Sign-off-gated, dry-run first.

---

## 6. Flags & rollout summary

| Flag | Default | Prod flip gate |
|---|---|---|
| `ARIES_SESSION_MANAGER_ENABLED` | OFF | screenshot-verified cards on a live tenant |
| `ARIES_SESSION_AUTH_WRITEBACK_ENABLED` | OFF | ≥1 real prod auth failure classified correctly (Stage A) + staged revoked-credential drill; flip with alerts |
| `ARIES_SESSION_HEALTH_ENABLED` (+ interval/lead/verify/dry-run/allowlist knobs) | OFF | one prod DRY_RUN observation cycle |
| `ARIES_META_EXPIRY_CAPTURE_ENABLED` | OFF | flip only after the health worker is live |
| `ARIES_COMPOSIO_VERIFY_ENABLED` (reconciler leg) | OFF | rides the reconciler's existing rollout |
| `ARIES_SESSION_ALERTS_ENABLED` (+ `ARIES_SESSION_EXPIRY_WARN_DAYS`) | OFF | screenshot Slack message + banner |
| `ARIES_SESSION_RBAC_ENABLED` | OFF | role-matrix verified in staging (multi-workspace ON and OFF) |
| `ARIES_SESSION_CONSUMER_GATING_ENABLED` | OFF | writeback live + one observed defer/resume cycle |

All flags parse `1/true/yes/on`, default OFF, process-wide, two-place rule (compose service env block + `.env.example`).

## 7. Risks

1. **fb_exchange_token on page tokens unverified** → allowlist keeps Meta refresh structurally unreachable until the smoke test passes; debug_token probe + alerts still cover Meta.
2. **False-positive reauth flips gate the weekly pipeline** (`countConnectedMetaPlatforms`) → verify-before-flip, code-190-only Meta signature, observability-first rollout, idempotent predicate-re-checked UPDATEs, dry-run, `session_health_events` trail.
3. **Composio auth-error signatures unknown until observed** → conservative classifier; a miss degrades to today's retry behavior, never worse.
4. **Probe fan-out cost / rate limits** → bounded batches, 24h cadence, per-leg rate-limit abort + backoff column.
5. **Terminalizing auth ComposioToolErrors changes retry semantics** → flag-gated, live-probe-confirmed only, full error_message kept for manual reconciliation, claim/rollback untouched.
6. **Alert noise** → per-tenant rollup, transition-timestamp dedupe, Reddit exemption, `connection_recovered` optional.
7. **Two-store union drift** → single read model + `countConnectedMetaPlatforms` refactored onto it; golden tests pin authority per selector combination.
8. **Table growth** (oauth_tokens chains, session_health_events) → retention sweep follow-up, sign-off-gated.

## 8. Open questions

1. Does the Composio SDK expose native re-auth for an existing connected account (vs delete+relink)?
2. Exact Composio auth-error signatures/payload shapes for expired vs revoked (confirm against a live dead connection before widening the classifier).
3. Does Graph accept `fb_exchange_token` with a page token? (Smoke test decides the allowlist.)
4. Meta App Review timeline for `pages_manage_engagement`/`instagram_manage_comments` — governs the scope-coverage badge copy.
5. `meta_ads` card semantics: connect/disconnect UX for an ads account vs a page (v1 may render read-only).

## 9. Verification appendix

14 load-bearing claims about the current system were adversarially verified against code before this plan was finalized: 6 CONFIRMED, 8 PARTIAL (precision refinements folded into §1), 0 REFUTED. Key confirmations: Graph 190 is not classified auth today; direct-OAuth refresh is already lock-protected and flips reauth on `unauthorized`; Slack per-tenant infra + dedupe table is reusable as-is; failed callbacks strand `pending`; AA-102 telemetry lives in the app layer (extracted to backend/ in Phase 1).

## 10. Deferred (out of scope, tracked)

- **Cross-workspace session overview** (all brands' session health in one place) — belongs to the multi-brand workspaces program (docs/plans/2026-07-08-multi-brand-workspaces.md); this plan's read model is the per-workspace building block it would aggregate.
- **Store consolidation** (`oauth_connections` ∪ `connected_accounts` → one table) — revisit only if the read-model seam proves insufficient.
- **Retention/GC** for `oauth_tokens` rotation chains + `session_health_events` — sign-off-gated follow-up (extend the GC-worker family).
- **TikTok/YouTube publisher enablement** — separate track; sessions render for them, publishing stays gated on their own flags.
