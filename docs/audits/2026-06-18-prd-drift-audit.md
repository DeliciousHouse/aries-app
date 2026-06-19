# Aries AI PRD Drift Audit

**Date:** 2026-06-18
**Target assessed:** `docs/product/aries-ai-prd.md` (the canonical PRD copy in this repo; previously "Last consolidated 2026-05-10")
**Source of truth:** the `aries-app` codebase @ v0.1.15.27 (~363 commits since the PRD was consolidated)
**Canonical PRD copy:** this file. The internal-docs mirror at `aries-docs-internal/product/aries-ai-prd.md` was reconciled in parallel.
**Method:** 11 PRD section-groups each investigated against live code by a dedicated agent, every finding adversarially re-verified against `aries-app`, then synthesized. 193 candidate findings examined → 99 confirmed drift items.

---

## Executive summary

The docs-internal PRD (`/home/node/docker-stack/aries-docs-internal/product/aries-ai-prd.md`, "Last consolidated 2026-05-10") is drifted on two axes at once: it lags the app-repo's own PRD copy (which already carries the §16 reconciliation status blocks and the §9 durable-reconciler note), and both copies lag current code at v0.1.15.27 (~363 commits). Three structural shifts dominate the drift. First, **execution architecture**: OpenClaw/Lobster is fully removed (Hermes is the sole provider) yet the PRD still calls it a deprecated fallback, and Hermes is a *polled* API whose delivery is owned by a durable reconciler — but the PRD repeatedly describes Hermes as *pushing* authenticated callbacks (the exact model whose failure caused the 2026-05-27 outage). Second, **autonomy**: a default-ON single-tenant autonomous mode (`ARIES_AUTO_APPROVE_MARKETING_PIPELINE=1`) synthesizes `ai-orchestrator` approvals and auto-schedules publishes, directly contradicting the PRD's absolute "human approval is mandatory" / "AI must never approve its own output" invariants. Third, whole **net-new subsystems** are absent: the Composio provider layer, multi-platform publishing (X/YouTube/Reddit/LinkedIn), the insights/analytics subsystem, scheduling/calendar, and Slack notifications. Honcho memory has gone live in production (the PRD still treats it as hypothetical), and most of §16's open questions and §17's "future" items have shipped. Severity: **1 critical, 20 high, 46 medium, 31 low**.

## Severity counts

| Severity | Count |
|---|---|
| Critical | 1 |
| High | 20 |
| Medium | 47 |
| Low | 31 |
| **Total** | **99** |

*(98 from the verified workflow payload + 1 recovered §14.6 finding whose verify agent was dropped to a transient rate-limit and was re-verified by hand. 5 other dropped verifies were "no-change" confirmations — no loss.)*

## Findings by PRD section

### §1 Executive Summary / §1.4 Core Product Philosophy

| § / lines | Type | Stale vs reality | Evidence | Sev | Recommended edit |
|---|---|---|---|---|---|
| §1.4 principle 3 (L80) | wrong | "Human approval is mandatory for publishing" is false in the shipped default — `ARIES_AUTO_APPROVE_MARKETING_PIPELINE` defaults 1, synthesizing an `ai-orchestrator` approval. | docker-compose.yml:76; hermes-callbacks.ts:1159,1244; auto-schedule.ts | High | Qualify: human approval mandatory UNLESS autonomous mode is configured (current single-tenant prod default); cross-ref §20. |
| §1.4 principle 4 (L81) | no-change | Accurate — Honcho writes are approval-gated, tenant-scoped, redacted. | honcho-env.ts:19-31; pseudonym.ts:5; write-events.ts | Low | No change. |
| §1.4 principle 5 (L82) | (none) | Vendor-agnostic text is accurate; substantive Composio gap belongs in §8/§11, not here. | provider-factory.ts:54-83 | Low | Leave as-is. |

### §2 Product Vision

| § / lines | Type | Stale vs reality | Evidence | Sev | Recommended edit |
|---|---|---|---|---|---|
| §2.1 (L97) | terminology | "campaign-based content planning" — product noun is now social content / one-off campaign. | app/campaigns/page.tsx:4 (redirect); orchestrator.ts:99 | Low | "weekly and one-off (event) social content planning". |
| §2.2 (L108) | now-resolved | Most of "future workflows" shipped: competitor research, creative production, performance analysis (insights), content calendars, multi-channel publishing. | CLAUDE.md pipeline; app/api/insights/*; init-db.js:872-1059; app/calendar; docker-compose.yml:200-211 | High | Demote shipped items to present-tense; reserve only landing-page generation + contributor workflows as future. |
| §2.3 (L133-135) | wrong | "AI must not publish without explicit approval" is absolute, but autonomous default synthesizes approval + auto-schedules to Meta. | docker-compose.yml:76; hermes-callbacks.ts:1159; auto-schedule.ts | Medium | Qualify L135 with autonomous-mode carve-out; refresh L129 to reflect auto-scheduling. |

### §3 Core Product Concepts / Personas

| § / lines | Type | Stale vs reality | Evidence | Sev | Recommended edit |
|---|---|---|---|---|---|
| §3.3 User (L164-166) | wrong | "creator, operator, approver, admin, viewer" doesn't map to the 3 real tenant roles (tenant_admin/analyst/viewer). | tenant-context.ts:6; auth-tenant-membership.ts:15; runtime-state.ts:195 | Medium | "Exactly one of tenant_admin/tenant_analyst/tenant_viewer"; note operator/approver are usage personas, creator is a per-job ownership check. |
| §3.5 Approver (L172-174) | missing | Definition correct; omits non-human `ai-orchestrator` auto-approval and Slack approval notifications. | hermes-callbacks.ts:1244; slack/notify-env.ts | Low | Keep definition; add the two new participants. |
| §3.13 Artifact (L216-220) | terminology | "campaign briefs" relabeled "Content brief" at API boundary. | handler.ts:72; runtime-views.ts:969 | Low | "content briefs"; optionally add insights narratives. |
| §3.15 Provider (L226-228) | missing | Example list omits AnalyticsProvider (4th capability port) + multi-impl provider seam. | composio-analytics-provider.ts:32; interfaces.ts:5-11 | Low | Add "analytics/insights providers". |
| §3.16 Publishing (L230-232) | terminology | "campaign assets" is legacy; entity is post/social content; publishing now multi-platform. | init-db.js:462; composio resolvers; integration-config.ts:36-59 | Medium | "approved posts / social content"; note multi-platform. |
| §3.18 Callback (L238-240) | stale | "provider-to-Aries request" misleads — Hermes is polled, Aries self-delivers via reconciler. | hermes.ts:787; hermes-reconciler.ts; inv-14 | Low | Soften origin clause to "invoked by Aries' own reconciler/poll-bridge"; keep provider-general. |
| §3 missing: Post/Social Content (L147) | missing | Central product entity (`posts` table) has no glossary entry. | init-db.js:462; app/social-content; app/posts | Medium | Add "Post / Social Content" entry. |
| §3 missing: Schedule/Scheduled Post (L147) | missing | Scheduling subsystem (scheduled_posts, calendar, marketing_schedule) undefined. | init-db.js:551; scheduled-posts-worker.mjs | Low | Add "Schedule / Scheduled Post" entry. |
| §3 missing: Insights/Analytics (L147) | missing | Whole insights_* subsystem undefined. | app/api/insights; init-db.js:872-1059; insights-sync-worker.ts | Medium | Add "Insights / Analytics" entry. |
| §3 missing: Taste Profile (L147) | missing | Brand taste-learning loop undefined (distinct from Memory). | init-db.js:641,652; taste-profile-store.ts | Low | Add "Taste Profile" entry; cross-ref §3.6. |
| §4.3 Strategist (L278-287) | terminology | "campaign planning" mixed; strategy runs on aries-strategist profile; no distinct DB role. | hermes.ts:83; orchestrator.ts:99 | Low | Soften to "content/campaign planning". |
| §4.4 Approver/Reviewer (L289-299) | wrong | "manager, client, designated reviewer" roles don't exist; only tenant_admin holds approve. | permission-check.ts:79-104; tenant-context.ts:6 | Medium | Map approver to tenant_admin; add ai-orchestrator auto-approval + Slack notify. |
| §4.5 Platform Operator (L301-311) | stale | "monitors Hermes callbacks" understates polled+reconciler model; omits 6 sidecar workers. | hermes-reconciler.ts; stale-run-reaper.ts; scripts/automations/ | Low | Update to reconciler/reaper + 6 sidecars. |

### §5 Primary User Flows

| § / lines | Type | Stale vs reality | Evidence | Sev | Recommended edit |
|---|---|---|---|---|---|
| §5.1 Onboarding (L346-358) | missing | Variant-board onboarding (3-variant pick → taste profile) not described. | onboarding/variants/*; variant-board-env.ts | Low | Add gated variant-board flow note. |
| §5.3 step 7 (L404-407) | wrong | "Hermes returns results through callback" — Hermes is polled; reconciler delivers. | hermes.ts:787; hermes-reconciler.ts | High | Rewrite steps 7-8: durable reconciler polls + ingests via idempotent handler. |
| §5.3 flow start (L398-403) | missing | Omits automated weekly-trigger path (marketing_schedule claim). | weekly-trigger/route.ts; weekly-job-trigger-worker.ts | Medium | Add automated per-tenant cadence trigger sub-bullet. |
| §5.3 (L419) | stale | "Drafts must not publish automatically" — autonomous default auto-approves + auto-schedules. | docker-compose.yml:76; hermes-callbacks.ts:1244 | Medium | Qualify with autonomous-mode exception. |
| §5.3 (L415) | now-resolved | Lobster "must not hard-code" is a removed concept, not an ongoing prohibition. | inv-06 test; approval-store.ts | Low | Reframe as completed removal. |
| §5.4 (L429-433) | missing | Omits autonomous auto-approval + Slack approval notifications. | hermes-callbacks.ts:1159; slack/notifications.ts; CHANGELOG v0.1.15.27 | Medium | Note human-OR-ai-orchestrator approver + Slack deep-link. |
| §5.4 (L440) | terminology | "campaign or content strategy" mildly ambiguous (campaign survives as one-off). | orchestrator.ts:99 | Low | Optional disambiguation only. |
| §5.5 step 7 (L453-465) | missing | Generic dispatch; omits provider seam + multi-platform. | provider-registry.ts; publish-dispatch.ts; integration-config.ts:96 | Medium | Add provider seam (direct Meta vs Composio) + platform set. |
| §5.5 (L457-464) | missing | Omits scheduled-dispatch back-half + post-publish insights loop. | scheduled_posts; scheduled-posts-worker.mjs; scheduled-dispatch/route.ts; insights | Medium | Add scheduled-dispatch path + Stage-4 optimize loop. |
| §5.6 (L483) | wrong | "resume through callback" — durable reconciler is the real driver; stale-run reaper FAILS (not resumes). | hermes.ts:787; hermes-reconciler.ts; stale-run-reaper.ts:18-20 | Medium | Clarify in-process handler vs reconciler; do NOT list reaper as a resume trigger; update L982 poll-bridge note. |

### §6 Functional Requirements

| § / lines | Type | Stale vs reality | Evidence | Sev | Recommended edit |
|---|---|---|---|---|---|
| §6.1 FR-UI-1 (L529) | missing | Screen list omits calendar/scheduling and analytics/insights surfaces. | app/calendar; app/dashboard/analytics; app/api/insights | Medium | Add scheduling/calendar + analytics/insights screens. |
| §6.2 FR-ONB (L539-551) | missing | Variant-board / taste-profile onboarding path absent. | variant-board-env.ts; taste-profile-store.ts | Low | Add gated variant-board FR note. |
| §6.3 FR-BRAND-3 (L559) | missing | Enrichment framed as optional but is default-ON LLM pipeline; taste loop + logo compositing exist (gated, default-OFF). | docker-compose.yml:86,93,100,105; brand-kit.ts; frame-overlay.ts | Low | Clarify default-on enrichment; note taste/logo as gated rollouts (not live by default). |
| §6.4 FR-SOC-6 (L577) | now-resolved | Lobster clause references removed concept; credentials half still valid. | inv-06; inv-12 | Low | Drop Lobster clause; keep credentials prohibition. |
| §6.7 FR-APP-4 (L617) | stale | Auto-approval is process-wide deployment flag, not per-tenant "narrow". | hermes-callbacks.ts:1036; CLAUDE.md | Low | Note process-wide scope; per-tenant narrowing remains open. |
| §6.8 FR-INT-1 (L623) | missing/now-resolved | §17 #3/#4 (multi-platform, analytics) shipped; Composio absent everywhere. | integration-config.ts; insights; composio/* | Medium | Update §17 #3/#4 + add Composio note to FR-INT/§7.1. |
| §6.9 FR-PUB (L633-645) | missing | No multi-platform / provider-seam / scheduled-dispatch coverage. | composio-publisher-provider.ts; provider-factory.ts; scheduled-posts-worker.mjs | High | Add multi-platform + provider-abstraction + durable scheduled-dispatch FRs. |
| §6.9 FR-PUB-1,3,4,5 (L635-643) | no-change | Prep/dispatch/retry, validation, idempotency all accurate. | publish-dispatch.ts:130; publish-outcome.ts:16; meta-media-validation.ts | Low | No change. |
| §6.10 FR-EXEC-5 (L657) | now-resolved | "Legacy providers may remain as fallback" — none exist; Hermes is sole. | provider-factory.ts; inv-06 | High | Rewrite/remove; Hermes is sole provider, naming allowlist only. |

### §7 AI System Requirements

| § / lines | Type | Stale vs reality | Evidence | Sev | Recommended edit |
|---|---|---|---|---|---|
| §7.1 Provider Abstraction (L673-690) | missing | Frames abstraction only around Hermes/model vendors; publish/analytics provider seam (DirectMeta/Composio/Auto) absent. | provider-factory.ts:54-135; integration-config.ts:95-100; docs/integrations/composio.md | High | Add ASR-PROV for publish/analytics capability ports + Composio default layer. |
| §7.2 ASR-DET-5 (L702) | stale | "must be callback-based, not polling" — Hermes IS polled; reconciler is durable delivery. | CLAUDE.md guardrail #5; hermes-reconciler.ts; hermes.ts:951 | Medium | Reword: async + durable reconciler that polls to completion; no synchronous request-path polling. |
| §7.5 ASR-APR-5 (L730-738) | stale | "AI must never approve its own output" contradicted by default-ON autonomous mode. | hermes-callbacks.ts:1159-1252; docker-compose.yml:76; variant-pick-finalize.ts:230 | High | Add autonomous-mode carve-out; ASR-APR-5 not absolute. |
| §7.5 ASR-APR-1/2/3 (L730-736) | no-change | Gating mechanisms intact (inv-07/08/09); but APR-1/APR-5 need autonomous caveat (cited range omits L738). | inv-07/08/09 tests | Medium | Keep APR-2/3; caveat APR-1/APR-5; fix cited line range. |

### §8 Architecture Overview

| § / lines | Type | Stale vs reality | Evidence | Sev | Recommended edit |
|---|---|---|---|---|---|
| §8.1 Diagram (L804-806) | stale | "Authenticated Callback to Aries" implies Hermes pushes; Aries polls + self-delivers. | hermes.ts:787-803; hermes-reconciler.ts; docker-compose.yml:71 | Low | Replace arrow with Aries-driven poll + idempotent ingestion; note Hermes doesn't push. |
| §8.2 Frontend (L812-820) | missing | Omits analytics, comments/reply, calendar, multi-platform selector. | analytics-screen.tsx; comments-screen.tsx; platform-selector.tsx; calendar-screen.tsx | Medium | Add the four new UI surfaces. |
| §8.4 Backend Services (L838-848) | missing | Omits insights ingestion, scheduling/weekly automation, taste-learning, Slack dispatch. | backend/insights/; weekly-job-trigger-worker.ts; taste-profile-store.ts; slack/notifications.ts | Medium | Add the four backend domains + sidecars. |
| §8.6 Exec Providers (L865) | now-resolved | "Legacy OpenClaw/Lobster: deprecated fallback" — FULLY REMOVED. | provider-factory.ts; inv-06; CHANGELOG v0.1.6.0 | **Critical** | Replace with removal statement; Hermes sole provider, allowlist only. |
| §8.6 (L858-867) | missing | Composio provider layer absent; 4 capability ports + DirectMeta/Composio impls. | provider-factory.ts; interfaces.ts; composio/ (18 files); docs/integrations/composio.md | High | Add publishing/analytics provider-abstraction subsection. |
| §8.6 (L867) | stale | "Publishing providers" generic; Composio is default layer; 5 platforms. | integration-config.ts:36-80; composio resolvers | Medium | Add Composio + platform set (keep detail in publishing section). |
| §8.8 (L883) | stale | "optional Honcho ... when enabled" — Honcho flags default ON (writes need URL/JWTs). | docker-compose.yml:162-165 | Low | "flags enabled by default; writes require base URL + JWTs else no-op". |
| §8.8 (L879-884) | missing | Omits insights_* + scheduling tables from canonical persistence. | init-db.js:872-1059,462,551,849,641 | Medium | Name insights_* + scheduled_posts/marketing_schedule. |
| §8.9 (L897) | now-resolved | "future research job APIs" — research is live with dedicated routes. | aries-research/callback; research/review-queue; retry-research; hermes.ts:82 | Low | Drop "future"; list shipped research routes. |
| §8.9 (L888-896) | missing | Omits insights, scheduling/calendar, Composio connect, Slack events APIs. | app/api/insights/*; calendar/sync; composio/[platform]; slack/events | Medium | Add the four API families. |
| §8.10 Webhooks (L901-903) | stale | Slack Events inbound webhook is a third category beyond internal/OAuth callbacks. | slack/events/route.ts; events/verify.ts; init-db.js:812 | Medium | Acknowledge Slack Events inbound webhook (sig-auth, event_id dedupe). |

### §9 Workflow Architecture

| § / lines | Type | Stale vs reality | Evidence | Sev | Recommended edit |
|---|---|---|---|---|---|
| §9.2 (L932-944) | stale | Table is "recommended canonical" (OK), but implemented enum is 6-state subset; spelling is "cancelled" not "canceled". | run-store.ts:21-27,36; research-jobs.ts:6-12 | Low | Note implemented subset; align spelling to "cancelled". |
| §9.4 reconciler (L964-982) | missing | Documents only v0.1.2.7 poll-bridge; durable reconciler note (app-copy L984-985) absent. | hermes-reconciler.ts; hermes-reconciler-worker.ts:28,43; CHANGELOG v0.1.15.1 | High | Insert v0.1.15.1 reconciler note verbatim from app-repo copy. |
| §9.4 poll-bridge (L982) | stale | Poll-bridge presented as delivery mechanism; it's now best-effort fast path only (reconciler guarantees). | hermes.ts:534,796,813,855-874; CLAUDE.md #5 | Medium | Demote poll-bridge; reconciler is the guarantee. |
| §9.4 steps 4-5 (L971-972) | stale | Collapses 4-stage pipeline (research→strategy→production→publish) into one submission. | workflow-catalog.ts:28-36; orchestrator.ts | Medium | Reflect multi-stage Hermes pipeline, per-stage approval gates. |
| §9.4 scope (L964-966) | missing | Omits one_off_post / one_off_campaign (auto-stop-on-deadline) workflow types. | orchestrator.ts:99,319-334,1685-1689; lib/api/marketing.ts | Medium | Add one-off workflow variants subsection. |

### §10 Memory Architecture (Honcho)

| § / lines | Type | Stale vs reality | Evidence | Sev | Recommended edit |
|---|---|---|---|---|---|
| §10 framing (L1038-1124) | now-resolved | Written as aspirational design; Honcho is LIVE (default ON, v3 API, dual-plane JWT). | docker-compose.yml:162-165; honcho-env.ts; CHANGELOG v0.1.8.7 | Medium | Add production-status preamble. |
| §10.2 (L1053-1080) | missing | Omits the dominant "continuous profile writes" subsystem (7 event producers + idempotency table). | write-events.ts:176-1025,83; index.ts:78-106; init-db.js:687; inv-03 | High | Add §10.2.1 continuous profile writes. |
| §10.8 Retrieval (L1170-1180) | wrong | Peer-scoped recall unimplemented — reads without session return []; research memory context always empty. | honcho-client.ts:182-212; orchestrator.ts:55-62; CHANGELOG v0.1.8.8 | High | Rewrite: session-scoped only; cross-peer recall returns empty until built. |
| §10.10 Hard Reject (L1201-1225) | missing | Omits prompt-injection-residue drop + operator-label PII scrubbing. | curator.ts:27-33,100-101; write-events.ts:871-882 | Medium | Add injection-residue to list; note label PII scrubbing separately. |
| §10.12 Deletion (L1238-1240) | now-resolved | "must be verified before production reliance" — deletion implemented + tested. | tenant-deletion.ts:21-116; honcho-client.ts:214-222; memory-tenant-deletion.test.ts | Medium | Replace caveat with implemented DELETE + bounded poll-verify. |

### §11 API / Integration

| § / lines | Type | Stale vs reality | Evidence | Sev | Recommended edit |
|---|---|---|---|---|---|
| §11.2 (L1264-1271) | now-resolved | "future research jobs" — research is live (HONCHO/ARIES_RESEARCH gated). | research-env.ts:9; aries-research/callback; review-queue; retry-research | Medium | Drop "future"; list live research routes. |
| §11.2 (L1262-1272) | missing | Omits insights, scheduling/calendar, Composio connect, Slack events route families. | app/api/insights/*; calendar/sync; composio/[platform]; slack/events | High | Add the four route families. |
| §11.4 OAuth (L1285-1297) | missing | Only direct OAuth described; Composio provider-managed connection model absent (X/YT/Reddit/LinkedIn exclusive). | reconnect.ts:53; oauth/[provider]; composio/[platform]/connect; interfaces.ts:31-53 | High | Add provider-managed (Composio) connection model. |
| §11.5 (L1299-1310) | missing/now-resolved | Scheduled + multi-platform publish shipped but §11.5 omits them and §16.5/§17 still mark them future. | scheduled-dispatch/route.ts:236-242; scheduled_posts; integration-config.ts:36-80 | Medium | Add scheduled/multi-platform publish; also resolve §16.5 + §17 #2/#3/#4. |
| §11.6 (L1312-1324) | missing | Aspirational text now literally implemented: 4 seams, DirectMeta + Composio, factory-selected. | interfaces.ts:30-80; integration-config.ts:96-100; provider-factory.ts:52-101 | High | Rewrite naming real implementation + composio-only platforms. |

### §13 Publishing / Automation

| § / lines | Type | Stale vs reality | Evidence | Sev | Recommended edit |
|---|---|---|---|---|---|
| §13.1 class 4 (L1421-1428) | (none) | "campaign creation" = paid Meta ad campaigns — correct; §13.3 already disambiguates. | direct-meta-provider.ts:146; composio-publisher-provider.ts:5 | Low | Optional "paid ad campaign creation" polish only. |
| §13.2 (L1430-1442) | missing | Omits auto-schedule-on-approval, autonomous auto-approve, draft expiry, insights ingestion. | hermes-callbacks.ts:1053,1159; draft-expiry-sweep-worker.ts; insights-sync-worker.ts | Medium | Add the four automatic behaviors. |
| §13.4 (L1456-1467) | no-change | Prohibitions hold as design defaults; but auto-approve DOES cover the publish gate (hermes-callbacks.ts:1185). | ingest-production-assets.ts:93; hermes-callbacks.ts:1185 | Low | Keep list; add autonomous-mode reconciliation sentence. |
| §13.5 (L1469-1485) | missing | Meta-centric; omits per-platform capability-preflight (Reddit/YouTube/TikTok/LinkedIn limits). | capability-preflight.ts:36-46; composio-capability-provider.ts | Medium | Generalize beyond Meta; reference CapabilityProvider/preflight. |

### §12 / §14 / §15 (Security / NFR / Operational)

| § / lines | Type | Stale vs reality | Evidence | Sev | Recommended edit |
|---|---|---|---|---|---|
| §12.4 (L1377-1389) | missing | Approval gates framed inviolable; doesn't surface default-ON marketing autonomous mode. (Keep "paid campaign activation" — valid requirement.) | docker-compose.yml:76,81; hermes-callbacks.ts:1031-1058 | Medium | Add autonomous-mode note + cross-ref FR-APP-3; do NOT touch paid-campaign bullet. |
| §14.6 (L1563-1574) | stale | "optional Honcho memory configuration" (now live default), singular "Hermes endpoint and key" (now multi-profile), and "unless explicitly operating in legacy mode" (legacy removed). | docker-compose.yml:162-165 (HONCHO_ENABLED:-true); hermes.ts:82-91 (3 profiles); provider-factory.ts; inv-06 | Medium | Honcho = live default backend (degrades silently if unconfigured); per-profile Hermes gateways; drop "legacy mode" clause. *(recovered: verify dropped to rate-limit; re-verified by main loop against the cited lines.)* |
| §14.7 (L1576-1585) | stale | "compatibility with multiple execution adapters" — single-provider now; leakage tests are inv-05/06/15. | provider-factory.ts:13-19; inv-05/06/15 | Low | "single-provider execution-port abstraction"; cite invariant suite. |
| §15.1 (L1603-1614) | stale | "optional Honcho" + singular Hermes; omits insights, 6 sidecars, Composio. | docker-compose.yml:30-35,162-165,173; hermes.ts:89-91; scripts/automations/ | Medium | Honcho default; per-profile Hermes; add insights/sidecars/Composio. |
| §15.2 (L1616-1627) | stale | "keep legacy execution disabled" — removed; omits mandatory sidecar force-recreate on deploy. | provider-factory.ts; deploy-manifest-parity.test.ts; CHANGELOG v0.1.15.26; deploy.yml | High | State removal + sidecar force-recreate deploy assumption. |
| §15.3 (L1629-1639) | stale | Human review framed unconditional; autonomous default substitutes ai-orchestrator. (Autoschedule + weekly trigger default OFF.) | docker-compose.yml:76,81,400; hermes-callbacks.ts:1149-1234 | Medium | Qualify: reviews required in human-in-loop mode; autonomous prod ships ON. |
| §15.4 (L1641-1654) | no-change | Safeguards accurate; gap is §20 lacks enforcement cross-ref. | tests/prd-invariants/inv-01..15 | Low | Leave §15.4; add §20 cross-ref. |
| §15.5 (L1656-1666) | now-resolved | 3 debt items resolved: Honcho live, aries-research wired, stage-cache fixed+tested. | docker-compose.yml:151-165; hermes.ts:82-91; artifact-store.ts:52-62; tests | High | Strike resolved items; §16.1/§16.2 cross-refs now stale. |

### §16 Open Questions

| § / lines | Type | Stale vs reality | Evidence | Sev | Recommended edit |
|---|---|---|---|---|---|
| §16.1 Honcho (L1687-1698) | stale | Honcho live (default ON, control/data-plane JWT). | docker-compose.yml:162-168; honcho-env.ts; #441 | Medium | Add status note; keep rotation/delete/redaction sub-questions. |
| §16.2 aries-research (L1700-1707) | now-resolved | 3-profile map registered with per-profile creds. | hermes.ts:82-91; app-copy already rewrote this | High | Adopt app-copy 2026-05-25 status; scope remainder to Hermes-side. |
| §16.3 route drift (L1709-1717) | stale | Rename partially executed; /dashboard/campaigns gone; /campaigns redirects. | app/campaigns/page.tsx; social-content+posts routes; ~185 files | Medium | "partially executed"; drop /dashboard/campaigns example. |
| §16.4 legacy execution (L1719-1725) | now-resolved | Closed by inv-06; only DB-column allowlist remains. | inv-06:19-57; 0 OPENCLAW_ reads | High | Adopt app-copy 2026-05-25 resolved status. |
| §16.5 publishing boundary (L1727-1736) | now-resolved | Scheduled publishing implemented; only retry-approval + paid-campaign open. | init-db.js:551,775-795; scheduled-posts-worker.mjs; publish-dispatch.ts | High | Adopt app-copy 2026-05-26 status block. |
| §16.6 memory UI (L1738-1747) | stale | Label redaction shipped (default ON, even app-copy's "off" is stale). | write-events.ts:852,871; docker-compose.yml:140 | Medium | Add redaction status; keep inspection-UI questions open. |

### §17 Future Expansion

| § / lines | Type | Stale vs reality | Evidence | Sev | Recommended edit |
|---|---|---|---|---|---|
| §17 #2 Content calendar (L1778) | now-resolved | Shipped (calendar UI + scheduled_posts + worker + per-tenant tz). | app/calendar; init-db.js:551; #375/#428/#465 | Medium | Move out of future. |
| §17 #3 Multi-platform (L1779) | now-resolved | X/YT/Reddit/LinkedIn shipped; TikTok remains scaffold (no live publish). | insights/adapters/*; provider-factory.ts:113 | Medium | Mark IG/FB/LinkedIn/X/YT/Reddit shipped; keep TikTok future. |
| §17 #4 Performance loop (L1780) | now-resolved | Analytics ingestion shipped (insights subsystem + workers). | app/api/insights; init-db.js:872+; honcho-performance-worker.ts | Medium | Mark ingestion shipped; keep optimization-recs future. |
| §17 #5 A/B testing (L1781) | now-resolved | Partially addressed by onboarding variant board. | onboarding-variant-batch.ts; variant-pick-finalize.ts | Low | Note variant board; keep general A/B future. |
| §17 #1,#6-12 (L1777,1782-1788) | no-change | Genuinely future (read-only workflow catalog exists, but admin registry still future). | app/api/tenant/workflows/route.ts; creative-memory (dev-only) | Low | No change; optional workflow-catalog note. |

### §18 Glossary / §19 Deprecated / §20 Invariants

| § / lines | Type | Stale vs reality | Evidence | Sev | Recommended edit |
|---|---|---|---|---|---|
| §18 Hermes (L1810) | stale | "intended default" — Hermes is sole provider. | CLAUDE.md; provider-factory.ts | Medium | "sole AI execution provider". |
| §18 missing terms (L1792-1834) | missing | Omits Composio, Insights/Analytics, Scheduled Post, Reconciler, Social Content/Post. | composio/; app/api/insights; hermes-reconciler.ts; social-content/posts routes | Medium | Add the missing glossary entries. |
| §19.1 OpenClaw/Lobster (L1840-1844) | now-resolved | "explicit fallback / opt-in legacy compatibility" — no runtime path exists. | inv-06; approval-store.ts:187-203 (DB-column shim) | Medium | Rewrite: fully removed; bounded compat allowlist only. |
| §19.4 sync polling (L1864-1868) | wrong | "fire-and-forget submission with authenticated callbacks" — inverted; that model failed (2026-05-27). | hermes.ts:787,820,855-875; hermes-reconciler.ts; CLAUDE.md #5; CHANGELOG v0.1.15.1 | High | Rewrite to durable poll/reconciler delivery. |
| §19.5 campaign terminology (L1870-1872) | terminology | "rename has not been executed" stale; use-runtime-campaigns hook gone; ~184 files remain. | grep (0 hook hits); app/campaigns redirect; social-content/posts | Medium | "partially executed (#493/#494)"; drop hook example. |
| §20 section (L1876-1892) | missing | Invariants now machine-enforced (inv-01..15 + inv-01b); §20 doesn't say so. | tests/prd-invariants/ | Low | Add enforcement lead-in mapping invariants→tests. |
| §20 #6 (L1883) | stale | "compatibility-only unless explicitly selected" — no selection path. | inv-06:19-57 | Medium | "No OpenClaw/Lobster execution path; naming allowlist only". |
| §20 #1-5,7-15 (L1878-1892) | no-change | Accurate, each with passing test; #14 callback wording still Aries-side correct. | inv-01..15; hermes-callbacks (execution/) | Low | Optional cross-ref from #14 to §19.4. |

## Net-new sections the PRD is missing entirely

| Subsystem | Status in code | Where it belongs |
|---|---|---|
| **Composio provider layer** | Default publish/analytics provider selector (COMPOSIO_ENABLED gated, direct_meta effective until enabled); 4 capability ports; sole path for X/Reddit/LinkedIn/YouTube. | New §8.6 subsection + §7.1 + §11.6 rewrite + glossary; ref docs/integrations/composio.md. |
| **Multi-platform publishing** | Meta FB/IG + X/YouTube/Reddit/LinkedIn behind ARIES_*_ENABLED flags (TikTok scaffold). | §5.5, §6.9 (new FR-PUB), §8.6, §13.5; demote §17 #3. |
| **Insights / Analytics** | app/api/insights (~14 routes), 10 insights_* tables, insights-sync + honcho-performance sidecars. | New §3 concept, §6 FR group, §8.4/§8.8, §11.2; demote §17 #4. |
| **Scheduling / Calendar** | scheduled_posts + marketing_schedule tables, calendar UI, scheduled-posts + weekly-trigger sidecars, scheduled-dispatch route. | New §3 concept, §5.3/§5.5, §6.1, §8.x, §11.2/§11.5; demote §17 #2. |
| **Slack notifications + Events webhook** | Outbound approval notifications (ARIES_SLACK_NOTIFICATIONS_ENABLED) + inbound Slack Events webhook. | §3.5/§5.4, §8.4, §8.9/§8.10 (inbound webhook), §11.2. |
| **Brand taste-learning / variant board** | marketing_taste_profile/_signal, read+write flags (default OFF), onboarding variant board. | New §3 concept, §5.1, §6.2/§6.3. |
| **Durable Hermes reconciler** | Standing sidecar; the delivery guarantee replacing the poll-bridge. | §3.18, §8.1, §9.4, §19.4, glossary. |

## Now-resolved items to update

| Location | PRD says | Reality | Action |
|---|---|---|---|
| §8.6, §6.10 FR-EXEC-5, §6.4 FR-SOC-6, §14.7, §15.2, §16.4, §19.1, §20 #6 | OpenClaw/Lobster deprecated/fallback/opt-in | Fully removed; allowlist only (inv-06) | Rewrite all as completed removal. |
| §16.1, §10 framing, §8.8, §15.1, §15.5 | Honcho optional/hypothetical/unverified | Live in production (#441, default ON) | Add production status. |
| §16.2, §15.5 | aries-research profile registration open | 3-profile map wired | Adopt app-copy status. |
| §16.5, §11.5, §17 #2 | Scheduled publishing / calendar future/open | Shipped | Adopt app-copy 2026-05-26 block; demote §17 #2. |
| §17 #3/#4/#5, §2.2 | Multi-platform / analytics / A/B future | Shipped (TikTok partial) | Demote to shipped. |
| §10.12 | Deletion "must be verified" | Implemented + tested | Replace caveat. |
| §16.3, §19.5 | "rename not executed" | Partially executed (#493/#494) | Update to partial. |
| §8.9, §11.2 | "future research APIs" | Live | Drop "future". |
| §16.6 | redaction open | Shipped (default ON) | Add status. |
| §20 | invariants as prose | Machine-enforced inv-01..15 | Add enforcement note. |

## Recommended update plan

> **Canonical source note:** `/home/node/docker-stack/aries-app/docs/product/aries-ai-prd.md` is the canonical PRD copy. The docs-internal target already lags it by the §16.1/§16.2/§16.4/§16.5 reconciliation status blocks and the §9.4 durable-reconciler note — *before* any of the new code-drift work below. **Batch 0: first re-sync the docs-internal copy to the app-repo copy** (port §16 status blocks + §9.4 reconciler note + the §16.2 2026-05-25 and §16.5 2026-05-26 blocks verbatim), then apply the batches below to both copies.

**Batch 1 — Critical/high correctness (architecture truth):**
- [ ] §8.6 + §6.10 FR-EXEC-5 + §14.7 + §15.2 + §16.4 + §19.1 + §20 #6: OpenClaw/Lobster fully removed; Hermes sole provider (inv-06). *(the one critical item is §8.6)*
- [ ] §3.18, §5.3 (steps 7-8), §5.6, §7.2, §8.1, §9.4, §19.4: Hermes is polled; durable reconciler delivers (never a provider push). Insert §9.4 reconciler note.
- [ ] §10.8: retrieval is session-scoped only; cross-peer recall returns empty.
- [ ] §10.2: add continuous-profile-writes subsystem.

**Batch 2 — Autonomy honesty (safety invariants vs shipped default):**
- [ ] §1.4 p3, §2.3, §5.3 (L419), §5.4, §6.7 FR-APP-4, §7.5 ASR-APR-1/5, §12.4, §13.2, §13.4, §15.3: document default-ON autonomous mode (`ARIES_AUTO_APPROVE_MARKETING_PIPELINE`, `ai-orchestrator`) + `ARIES_AUTOSCHEDULE_ON_APPROVAL`; stop stating human approval as absolute.

**Batch 3 — Net-new subsystems (add the missing surfaces):**
- [ ] Composio provider layer: §7.1, §8.6, §11.4, §11.6, glossary.
- [ ] Multi-platform publishing: §3.16, §5.5, §6.9, §8.6, §13.5.
- [ ] Insights/analytics: new §3 concept, §6, §8.4/§8.8, §11.2.
- [ ] Scheduling/calendar: new §3 concept, §5.3/§5.5, §6.1, §8.x, §11.2/§11.5.
- [ ] Slack notifications + inbound Events webhook: §3.5/§5.4, §8.4, §8.9/§8.10, §11.2.

**Batch 4 — Now-resolved demotions:**
- [ ] §17 #2/#3/#4/#5 + §2.2 + §8.9/§11.2 (research) + §10.12 + §16.1/§16.6 + §15.5: move shipped items out of "future"/"open"; add Honcho live status.

**Batch 5 — Terminology + glossary + low-priority polish:**
- [ ] campaign→post/social-content: §2.1, §3.13, §3.16, §4.3, §16.3, §19.5; add Post/Social Content + Insights + Scheduled Post + Reconciler + Composio glossary entries; §18 Hermes wording.
- [ ] Roles: §3.3, §4.4 (3 tenant roles); §4.5 operator persona; §9.2 enum/"cancelled".
- [ ] §3.15, §6.2, §6.3, §8.8, §20 enforcement note, §13.1 (optional).