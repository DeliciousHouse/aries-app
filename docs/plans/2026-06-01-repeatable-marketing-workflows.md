# Repeatable Marketing WORKFLOWS — productize Campaign Plan, Creative Production, Landing Brief, Competitor Research, Performance Review, Public Preview

> Status: draft plan (2026-06-01). Epic, multi-PR. Roadmap area **#15** ("move from weekly content to repeatable marketing workflows"), priority 9. This plan **surfaces** deterministic product workflows that already have a real Hermes side as first-class operator products — each with typed input, stages, job status, artifacts, approval gates, memory candidates, and retry/resume rules. It is **not** a request to invent new Hermes agents, and it adds **zero** placeholder workflow files (banned-pattern check stays green).

## Context

Weekly Social Content is the live core. It runs the 4-stage marketing pipeline (`backend/marketing/orchestrator.ts`, 2353 lines) and is *also* exposed atomically through `/api/tenant/workflows/*` against `backend/execution/workflow-catalog.ts` (`marketing_stage1_research` … `marketing_stage4_publish_finalize`, all `mode: 'real'`). The orchestrator's `job_type` union already reads/writes **three** shapes — `weekly_social_content | one_off_post | one_off_campaign` (`orchestrator.ts:99,121,1689`; handler `app/api/marketing/jobs/handler.ts:35`). So the runtime already speaks more than "weekly content"; what is missing is a **product surface** that names each repeatable workflow, gives it a typed intake, a stage timeline, an artifact list, and approval gates the operator can see and act on in the dashboard.

The roadmap order is fixed: **Weekly Social Content (core, shipped) → Campaign Plan → Creative Production → Landing Page Brief (structured copy/sections, NOT full-page gen) → Competitor Research (bounded/sourced/human-reviewed) → Performance Review → Public Campaign Preview.** Each of these maps onto a Hermes skill that **already exists** in `skills/`:

| Product workflow | Real Hermes skill(s) backing it (verified in `skills/`) |
|---|---|
| Campaign Plan | `social-content-planner`, `head-of-marketing` |
| Creative Production | `creative-director` (→ `ad-designer`, `scriptwriter`, `page-designer`) |
| Landing Page Brief | `landing-page-analysis`, `page-designer` (brief only — copy + sections, not a rendered page) |
| Competitor Research | `meta-ads-extractor`, `meta-ads-analyser`, `ads-analyst`, `landing-page-analysis` |
| Performance Review | `performance-marketer`, `reporting/client-reporting` |
| Public Campaign Preview | (no Hermes — pure Aries render of already-approved artifacts via `backend/marketing/public-pages.ts`) |

This is an **L epic, not a one-line flag.** It adds a workflow-product registry, a generic job/stage/artifact read model that the existing `SocialContentRuntimeState` shape already prefigures (`backend/social-content/types.ts`), per-product intake forms, and dashboard screens. A single rollout flag `ARIES_REPEATABLE_WORKFLOWS_ENABLED` (default OFF) gates whether the new product surface is reachable; the work itself is sequenced PRs.

## Who cares

- **Operators / @sugarandleather** — today the only "start a job" entry point is the weekly intake. A client who wants "just a competitor teardown" or "just the campaign plan, I'll handle creative" has no product to start.
- **Product** — "marketing OS" positioning requires named, repeatable products, each with its own intake and its own review surface, not one mega-pipeline.
- **Eng** — the orchestrator already carries `one_off_campaign`/`one_off_post` read-both/write-new compat (`orchestrator.ts:1685-1689`). Productizing these is mostly **surfacing** existing runtime state, not new execution code — but only for the workflows whose Hermes side is real.

## Decisions (locked — do not re-litigate)

1. **Surface order is the roadmap order.** Ship Campaign Plan first (highest reuse: it is the existing strategy stage), then Creative Production, then Landing Brief, then Competitor Research, then Performance Review, then Public Preview. One product per PR; do not batch.
2. **Only wire workflows whose Hermes side is real.** Each product maps to a skill that exists in `skills/` (table above). **No placeholder workflow files, no `mode:'stub'` product entries dressed up as products, nothing that trips `scripts/check-banned-patterns.mjs`.** If a product's Hermes contract is not yet emitting the required output shape, the product stays behind the flag and out of the registry until it is — exactly the discipline `ARIES_SOCIAL_COPY_FINALIZE_ENABLED` already models in CLAUDE.md.
3. **Reuse the existing job runtime, do not fork it.** The new product surface reads the *same* `SocialContentJobRuntimeDocument` (`runtime-state.ts:149`) and the same `SocialContentRuntimeState` stage/approval shape (`types.ts:79-88`). A "workflow product" is a typed **view + intake + scope preset** over the existing pipeline, distinguished by a new `workflow_product` discriminator, **not** a parallel state machine.
4. **Landing Page Brief is BRIEF-ONLY.** Structured copy + section outline (hero headline/subhead, section list, CTA copy, proof points). It does **not** render or publish a full HTML page. The public-preview render path (`public-pages.ts`) is a *separate* product (#6) and only ever renders **already-approved** artifacts.
5. **Competitor Research is bounded, sourced, human-reviewed.** Findings carry a `source_url` and route through the existing memory curation queue (`backend/memory/research-jobs.ts` → `aries_research_jobs`, `pending_approval`) — never auto-promoted to durable memory, never surfaced as an unsourced claim. This honors roadmap "What NOT to prioritize: unsourced competitor claims."
6. **Approval-gated, never autonomous.** Every product that can lead to a publish keeps the existing approval checkpoints (`SocialContentApprovalStep`, `types.ts:27-32`). No product introduces a new autonomous-publish path. `ARIES_AUTO_APPROVE_MARKETING_PIPELINE` is unchanged and orthogonal.
7. **Resumability is mandatory (CLAUDE.md).** Each product run preserves partial artifacts on transient failure and resumes from the runtime doc — the orchestrator already does this; products must not bypass it. Idempotency keys stay job-scoped.
8. **Rollout flag `ARIES_REPEATABLE_WORKFLOWS_ENABLED` (default OFF).** When OFF, the only reachable product is Weekly Social Content (today's behavior, byte-for-byte). When ON, the registered products appear in a "Workflows" launcher and each gets its intake + status surface. The flag gates **reachability of the new surface**, not execution.

## Current State (VERIFIED — branch `fix/story-composer-serving` @ HEAD 3ad77e6)

**Workflow registry — `backend/execution/workflow-catalog.ts`:**
- `AriesWorkflowKey` union (lines 1-15) holds 14 keys; the 7 atomic `marketing_stage*` keys are `mode:'real'` (lines 54-88) and listed in `ARIES_ATOMIC_MARKETING_WORKFLOW_KEYS` (lines 28-36). `demo_start`/`sandbox_launch`/`onboarding_start`/`publish_dispatch`/`publish_retry`/`calendar_sync`/`integrations_sync` are `mode:'stub'`.
- `GET /api/tenant/workflows` (`app/api/tenant/workflows/route.ts:8-24`) returns the **entire** catalog including stubs, typed `'hermes' | 'hermes_stub'` (`mode === 'real' ? 'hermes' : 'hermes_stub'`, line 19). **No notion of a customer-facing "product"** — it dumps execution primitives.
- `POST /api/tenant/workflows/[workflowId]/runs` (`.../runs/route.ts:31-59`) runs a key via `runAriesWorkflow`, returns `{status:'accepted', workflow_status, result}` (202) or a 501 `not_implemented` for unbacked routes (line 45-51). There is **no list/status/artifact read model** for a product run here.

**Job runtime / stage / approval model — already generic:**
- `SocialContentRuntimeState` (`backend/social-content/types.ts:79-88`): `currentStage`, `stageOrder`, `stages: Record<stage, {status, artifacts[], output}>`, `activeApproval`, `publishingRequested`. **This is already a product-agnostic stage timeline.**
- `SocialContentArtifact` (`types.ts:35-43`): `{id,type,title,status,summary,url,metadata}` — already a generic artifact shape.
- `SocialContentApprovalStep` (`types.ts:27-32`): 6 named gates (`approve_weekly_plan`, `approve_post_copy`, `approve_image_creatives`, `approve_video_script`, `approve_video_render`, `approve_publish`).
- `SocialContentJobRuntimeDocument` (`runtime-state.ts:149`); `createSocialContentJobRuntimeDocument` (`runtime-state.ts:300`) already branches on `job_type` (`runtime-state.ts:326`, `resolvedJobType`).
- Orchestrator `job_type` union `weekly_social_content | one_off_post | one_off_campaign` (`orchestrator.ts:99,121`); accept-list `orchestrator.ts:1689`; `buildOneOffBriefForArgs` (`orchestrator.ts:331`) already builds a one-off brief. **Note:** `requestedJobTypeFromDoc` (`orchestrator.ts:509`) currently hard-returns `'weekly_social_content'` for *every* doc — so the orchestrator's downstream branches at 916/2079/2095/2144/2153/2187 all treat any run as weekly today. Productizing must teach this resolver (or the product projection layer) to read the new `workflow_product` discriminator; do **not** assume it already distinguishes products.

**Intake / job creation:**
- `app/api/marketing/jobs/handler.ts`: `PublicJobType = 'weekly_social_content' | 'one_off_post' | 'one_off_campaign'` (line 35); `resolveRequestedJobType` (line 429) currently **defaults everything to `weekly_social_content`** (lines 431,436) and validates one-off briefs (lines 283,317,530). `/api/social-content/jobs` (`app/api/social-content/jobs/route.ts`) delegates here with `responseDialect:'social-content'`.
- Typed weekly intake shape `WeeklySocialContentPayload` (`types.ts:90-116`) with `DEFAULT_SOCIAL_CONTENT_COUNTS` (`types.ts:132-139`, `staticPostCount:7`, `imageCreativeCount:6`, `storyCount:0`). Weekly Hermes request `buildSocialContentWeeklyRequest` (`workflow-request.ts:159`) with `workflow_key='social_content_weekly'` (`defaults.ts:1`). Scope defaults live in `SOCIAL_CONTENT_DEFAULT_SCOPE` (`backend/social-content/defaults.ts:5`) — fields `image_creative_count`, `video_render_count`, `story_count` (line 15), `static_post_count`, `video_script_count`, `channels`, `window_days`.

**Competitor research / memory queue (already real):**
- `backend/memory/research-jobs.ts`: `aries_research_jobs` table (line 42), `ResearchJobStatus`, `ResearchFinding` with sourcing, `pending_approval` status, `recordFinding` (line 161), `listQueuedResearchFindingsForTenant` (line 224). `GET /api/tenant/research/review-queue` exists (admin-only: `role !== 'tenant_admin'` rejected, route line 18; raw list via `listQueuedResearchFindingsForTenant`, line 30).
- Memory curation engine `backend/memory/curator.ts` — `curateFinding` (line 84) returns `drop` / `queue_for_review` / `auto_approve` (line 120).

**Public campaign preview (already real, partial):**
- `backend/marketing/public-pages.ts`: `resolvePublicMarketingArtifact` (line 407) resolves `public-{brandSlug}-campaign` static contracts, injects design-system CSS (line 424); catch-all route `app/[...publicPath]/route.ts`. **Renders only what is on disk under the public contract dir** — already "approved-artifacts-only" by construction.
- **Guardrail substrate:** `lib/marketing-public-mode.ts` reads `MARKETING_STATUS_PUBLIC` — must NOT be set in prod (operator status surface, not the public preview).

**Dashboard surfaces:**
- App pages under `app/dashboard/*`: `social-content/new`, `social-content`, `social-content/[postId]`, `strategy-review`, `creative-review`, `brand-review`, `publish-status`, `results`, `calendar`, `posts`, `settings`. `app/review/*` (`app/review/page.tsx`, `app/review/[reviewId]`) is the cross-cutting review queue. **There is no "Workflows" launcher** that lists named products. The approve resume route exists at `app/api/marketing/jobs/[jobId]/approve`.

**Hermes skills that back the products (verified `skills/`):** `social-content-planner`, `head-of-marketing`, `creative-director`, `landing-page-analysis`, `website-brand-analysis`, `meta-ads-extractor`, `meta-ads-analyser`, `ads-analyst`, `performance-marketer`, `reporting/client-reporting` (the real leaf SKILL.md lives at `skills/reporting/client-reporting/SKILL.md`; `skills/reporting/` itself is a namespace), `page-designer`, `scriptwriter`, `ad-designer`. **These are real.** No new skill is required by this plan (Hermes-side workflow registration remains out of scope, exactly as for `social_copy_finalize`).

## Architecture (target)

```
                         ┌─────────────────────────────────────────────┐
                         │ backend/marketing/workflow-products.ts (NEW) │
                         │   WORKFLOW_PRODUCTS registry:                │
                         │   { key, label, jobType, scopePreset,        │
                         │     stageOrder, approvalSteps, intakeSchema, │
                         │     hermesBacked: true }   ← ONLY real ones  │
                         └───────────────┬─────────────────────────────┘
                                         │
   GET /api/tenant/workflow-products ────┤ (NEW: lists products, flag-gated)
                                         │
   /dashboard/workflows (NEW launcher) ──┤ renders one card per registered product
        │ "Start" ─────────────────────► │
        ▼                                 ▼
   /dashboard/workflows/:productKey/new   reuses marketing jobs handler with
        (NEW intake, per-product schema)  jobType = product.jobType, scope = preset
                                         │
                                         ▼
            backend/marketing/orchestrator.ts (UNCHANGED execution)
                 runtime doc (SocialContentJobRuntimeDocument)
                 stages + activeApproval + artifacts
                                         │
   /dashboard/workflows/:productKey/:jobId (NEW status view) ◄── reads runtime state
        stage timeline · artifacts · approval gate · memory candidates · retry
                                         │
                 approval gate ──► existing /api/.../approve resume path
                 competitor findings ──► aries_research_jobs (pending_approval)
                 approved campaign artifacts ──► public-pages.ts (Public Preview)
```

No new execution provider, no new orchestrator state machine. A **product** = registry entry + intake schema + dashboard view over the existing runtime.

## Child phases

| # | Phase | Product | Priority | Effort (human / CC) | Hermes-backed? | Depends |
|---|-------|---------|----------|---------------------|----------------|---------|
| A | Workflow-product registry + read model + `/dashboard/workflows` launcher (flag-gated) | infra | Critical | 4h / 1.5h | n/a | none |
| B | Campaign Plan product (intake + stage view + approve) | Campaign Plan | High | 5h / 2h | yes (`social-content-planner`) | A |
| C | Creative Production product | Creative Production | High | 5h / 2h | yes (`creative-director`) | A, B |
| D | Landing Page **Brief** product (structured copy/sections only) | Landing Brief | High | 5h / 2h | yes (`landing-page-analysis`) | A |
| E | Competitor Research product (bounded/sourced → memory queue) | Competitor Research | High | 6h / 2.5h | yes (`meta-ads-*`/`ads-analyst`) | A |
| F | Performance Review product | Performance Review | Medium | 5h / 2h | yes (`performance-marketer`/`reporting/client-reporting`) | A |
| G | Public Campaign Preview product (render approved artifacts only) | Public Preview | Medium | 4h / 1.5h | no (Aries render) | A |
| H | Rollout flag, docs, route-manifest sync, live E2E, ship | infra | Medium | 4h / 1.5h | n/a | B–G |

**Sequencing:** A first (registry + read model + launcher gate everything). B→C are the natural plan→produce pair (C consumes B's approved plan). D, E, F, G are independent of each other and parallel after A. H last (needs ≥1 product live to verify the launcher renders).

```
A ─┬─> B ─> C ──┐
   ├─> D ───────┤
   ├─> E ───────┼─> H
   ├─> F ───────┤
   └─> G ───────┘
```

---

### A — Registry + read model + launcher (Critical, 4h)

**New files:**
- `backend/marketing/workflow-products.ts` — `WorkflowProductKey = 'campaign_plan' | 'creative_production' | 'landing_brief' | 'competitor_research' | 'performance_review' | 'public_preview'`; `WORKFLOW_PRODUCTS: Record<WorkflowProductKey, WorkflowProductDef>` where each def has `{ key, label, blurb, jobType, scopePreset, stageOrder, approvalSteps, intakeSchemaName, hermesBacked: true, route }`. **A product is registered ONLY when `hermesBacked` is true AND the Hermes skill is verified real** (table above). The registry is the single source of truth the launcher reads.
- `backend/marketing/workflow-product-view.ts` — `buildWorkflowProductRunView(doc)`: projects a `SocialContentJobRuntimeDocument` into a product-neutral `{ productKey, jobId, status, stages: {stage,status,artifacts[]}[], activeApproval, memoryCandidates[], canRetry }`. Reuses `SocialContentRuntimeState` (`types.ts:79`) and `SocialContentArtifact` (`types.ts:35`) — **no new artifact schema.**
- `app/api/tenant/workflow-products/route.ts` — `GET` returns the registered products **only when `ARIES_REPEATABLE_WORKFLOWS_ENABLED` is on**; OFF returns `{ products: [{ key:'weekly_social_content', ... }] }` (today's single product) so the surface is inert.
- `app/dashboard/workflows/page.tsx` + `frontend/aries-v1/workflows-launcher.tsx` — renders one card per product (label, blurb, "Start" link to `/dashboard/workflows/:productKey/new`). When flag OFF, route either 404s or redirects to `/dashboard/social-content/new` (decide in review; default: redirect, so no dead surface ships).

**Reused (not new):** orchestrator, runtime-state, approval-store, the marketing jobs handler.

**Acceptance (user-visible):** with `ARIES_REPEATABLE_WORKFLOWS_ENABLED=1`, navigating to `/dashboard/workflows` **renders a launcher with one card per registered product** in Brendan's dashboard; with the flag OFF, `/dashboard/workflows` is not reachable as a new surface (redirects) and the existing weekly flow is unchanged. (Rendered UI only — the registry JSON does not count.)

### B — Campaign Plan product (High, 5h)

Campaign Plan == the existing **strategy** stage as a standalone product. It reuses `one_off_campaign` job_type (already in the orchestrator accept-list, `orchestrator.ts:1689`) with a scope preset that requests *plan only* (no image/video generation).

**Implementation:**
1. Registry entry `campaign_plan`: `jobType:'one_off_campaign'`, `scopePreset:{ image_creative_count:0, video_render_count:0, story_count:0 }`, `stageOrder:['intake','research','planning','plan_review','completed']`, `approvalSteps:['approve_weekly_plan']`.
2. `app/dashboard/workflows/campaign_plan/new/page.tsx` + `frontend/aries-v1/intake/campaign-plan-intake.tsx` — typed intake (brand URL, goal, audience, offer, channels, competitor URL). Reuses `sanitizeWeeklySocialContentPayload`/`buildOneOffBriefForArgs` (`orchestrator.ts:331`). POSTs to the existing marketing jobs handler with `jobType:'one_off_campaign'` + scope preset.
3. `app/dashboard/workflows/campaign_plan/[jobId]/page.tsx` — stage timeline + the campaign-plan artifact + **approve/deny** via the existing approval resume path. **Artifact step name:** the `social-content-planner` skill writes its strategy-stage payload under the step name **`social_content_planner`** (`artifact-collector.ts:325`, `dashboard-content.ts:785`); read that. The old `campaign_planner` step name is **legacy-compat only** for in-flight runs (`artifact-collector.ts:326,340`; `dashboard-content.ts:786`) — do **not** target it for new product reads, but keep the legacy fallback the existing readers already have.

**Reused:** `social-content-planner` skill (real), `buildOneOffBriefForArgs`, approval-store, `app/api/marketing/jobs/[jobId]/approve`.

**Acceptance (user-visible):** an operator starts a Campaign Plan from `/dashboard/workflows`, the run reaches `plan_review`, and the **rendered plan artifact + an Approve button** appear in the dashboard; approving advances/closes the run. No images are generated (plan-only scope verified in the rendered stage list).

### C — Creative Production product (High, 5h)

Productizes the **production** stage driven by `creative-director`. Consumes an approved Campaign Plan (`jobId` of a completed `campaign_plan` run) as input, or runs standalone from brand kit.

**Implementation:**
1. Registry entry `creative_production`: `jobType:'one_off_campaign'`, `scopePreset:{ image_creative_count: 6, video_render_count: 0 }` (6 = the existing weekly default, `DEFAULT_SOCIAL_CONTENT_COUNTS.imageCreativeCount`), `stageOrder` includes `image_briefing,image_generation,creative_review`, `approvalSteps:['approve_image_creatives']`.
2. Intake `frontend/aries-v1/intake/creative-production-intake.tsx` — optional "from plan" picker (lists completed `campaign_plan` jobs for the tenant), creative count, channels.
3. Status view renders generated creatives (reuse the existing creative-review presenter components) + `approve_image_creatives` gate.

**Reused:** `creative-director`/`ad-designer` skills (real), existing creative-review UI components (`app/dashboard/creative-review`), `synthesize-publish-posts` downstream untouched. **Video stays OFF** (gated by `ARIES_VIDEO_PUBLISH_ENABLED`, separate plan; do not light it here).

**Acceptance (user-visible):** an operator starts Creative Production, generated images render in the dashboard with an `approve_image_creatives` gate; approving them makes them available to the publish path exactly as the weekly flow does.

### D — Landing Page **Brief** product (High, 5h) — BRIEF ONLY

Structured copy + section outline. **No full-page render, no publish.** Backed by `landing-page-analysis` (analysis) + a structured-brief output.

**Implementation:**
1. Registry entry `landing_brief`: `jobType:'one_off_campaign'` (or a thin `one_off_post`), `scopePreset:{ image_creative_count:0, video_render_count:0 }`, `stageOrder:['intake','research','planning','plan_review','completed']`, `approvalSteps:['approve_weekly_plan']` (reuse the plan gate; the artifact is a brief, not posts).
2. New typed artifact projection in `workflow-product-view.ts`: `landing_brief` artifact = `{ hero_headline, hero_subhead, sections: [{title, copy, proof_points[]}], primary_cta }` — projected from the Hermes brief output. **Aries does not synthesize HTML.**
3. Intake collects offer + target audience + desired sections; status view renders the structured brief (headline, section list, CTA) with an approve gate.

**Reused:** `landing-page-analysis` + `page-designer` skill outputs (real, brief-shaped). The brand URL CTA in any rendered copy must be **aries.sugarandleather.com**, never bare sugarandleather.com (guardrail; same rule story-composer already follows).

**Acceptance (user-visible):** an operator starts a Landing Brief; the run produces a **rendered structured brief** (hero headline + subhead + section outline + CTA copy) in the dashboard with an approve gate. No HTML page is generated or published.

### E — Competitor Research product (High, 6h) — bounded / sourced / human-reviewed

Backed by `meta-ads-extractor` + `meta-ads-analyser` + `ads-analyst` + `landing-page-analysis`. Every finding is **sourced** and routed to the existing memory curation queue — never auto-promoted, never surfaced as an unsourced claim.

**Implementation:**
1. Registry entry `competitor_research`: `jobType:'one_off_campaign'` with a research-only scope preset; `stageOrder:['intake','research','completed']`; `approvalSteps: []` at the campaign level — **approval happens at the finding/memory level**, not via the publish gate.
2. Intake `competitor-research-intake.tsx` — competitor URL, Meta ad-library URL, FB page URL (these map to existing fields in `WeeklySocialContentPayload`, `types.ts:97-100`: `competitorUrl` (97), `competitorBrand` (98), `facebookPageUrl` (99), `adLibraryUrl` (100); use those exact field names, not `fbPageUrl`/`metaAdLibraryUrl`). **Bound the scope:** N competitors max, no open-ended crawling.
3. Findings persist via the **existing** `backend/memory/research-jobs.ts` path (`aries_research_jobs`, `recordFinding` line 161, status `pending_approval`) — each `ResearchFinding` carries its `source_url`. The status view renders findings with their source link + a **per-finding approve/reject** that routes through `backend/memory/curator.ts` (`curateFinding` line 84) into the memory queue. **Findings without a source are dropped, not displayed.**
4. Surface the queue in the dashboard (today only `GET /api/tenant/research/review-queue` raw-list exists, admin-only — `role !== 'tenant_admin'` rejected at route line 18) — add a tenant-facing review view scoped to this product's job.

**Reused:** `aries_research_jobs` schema + `curator.ts` + the curation queue (all real). **New:** the product intake + a sourced-findings status/review view.

**Acceptance (user-visible):** an operator runs Competitor Research; the dashboard renders a list of **sourced** findings (each with a clickable source URL) plus per-finding Approve/Reject that pushes approved findings into the memory queue. An unsourced finding never appears. (This directly serves roadmap "What NOT to prioritize: unsourced competitor claims.")

### F — Performance Review product (Medium, 5h)

Backed by `performance-marketer` + `reporting/client-reporting`. Produces a weekly-results read model: published vs skipped/blocked, top channel, best/weakest post, "what Aries learned," and **one recommended next action + memory candidate** the operator can Approve/Edit/Reject. This is the productized face of roadmap #11.

**Implementation:**
1. Registry entry `performance_review`: research/report scope; `stageOrder:['intake','research','completed']`; `approvalSteps: []` at job level (the *learning* is the approval unit).
2. Reuse the Honcho performance-insights write-leg (`backend/memory/write-events.ts:recordPerformanceEvent` line 652, gated by `HONCHO_WRITE_PUBLISH_ENABLED`) — when a performance learning is **approved** by the operator, it routes through the existing memory candidate path. Note `recordPerformanceEvent` already requires a verifiable https `source_url` (skips otherwise, line 675), reinforcing the sourced-only discipline. **Do not auto-write learnings**; the learning is a memory candidate requiring owner approval (roadmap #11 + #14).
3. Status view renders the report + the single "Approve this learning?" affordance (Approve memory / Edit / Reject).

**Reused:** `performance-marketer`/`reporting/client-reporting` skills (real), the Honcho write-events path (already shipped via #522, gated OFF), results presenter components (`frontend/aries-v1/presenters/results-presenter.tsx`).

**Acceptance (user-visible):** an operator runs Performance Review; the dashboard renders a results summary plus **one approvable learning/memory candidate**. Approving it enqueues a memory candidate (visible in the memory queue); rejecting it discards. No learning is written without the click.

### G — Public Campaign Preview product (Medium, 4h) — approved artifacts only

Productizes the existing `public-pages.ts` render as a named workflow: turn an approved campaign into a shareable read-only client preview. **Renders only already-approved artifacts on disk under the public contract dir** — it never generates new content and never publishes to Meta.

**Implementation:**
1. Registry entry `public_preview`: `hermesBacked:false`, `jobType:'one_off_campaign'` linkage by source `jobId`. No Hermes call; this product *assembles a preview* from an approved campaign's artifacts.
2. "Create preview" action on a completed Campaign Plan / Creative Production run: writes the approved artifacts into the `public-{brandSlug}-campaign` contract dir that `resolvePublicMarketingArtifact` (`public-pages.ts:407`) already serves. CTA links use **aries.sugarandleather.com**.
3. Status view shows the public preview URL (`/public-:brandSlug/campaign`) + an explicit "approved sections only" badge. **Read-only link with expiry/password is tracked as a follow-on (roadmap #9 depth); the MVP is the read-only render of approved artifacts.**

**Guardrail:** **Never expose `MARKETING_STATUS_PUBLIC=1` in prod** (read by `lib/marketing-public-mode.ts`). The public preview is the approved-campaign artifact render, not the operator status surface. The preview is approval-gated by construction (it only reads artifacts that already passed their approval gate).

**Acceptance (user-visible):** from a completed approved campaign, an operator creates a Public Preview and the dashboard renders a **working `/public-:brandSlug/campaign` link** whose page shows only approved sections, with the aries.sugarandleather.com CTA. Unapproved drafts never appear on the public page.

### H — Rollout flag + docs + manifest + live E2E + ship (Medium, 4h)

**Implementation:**
1. `ARIES_REPEATABLE_WORKFLOWS_ENABLED` (default OFF): document in `CLAUDE.md` "Environment Variables" (flag-entry style: what it gates, default, when to flip), `.env.example`, `docker-compose.yml`. Accept `1|true|yes|on` (same parser convention as `ARIES_VIDEO_PUBLISH_ENABLED`/`ARIES_SOCIAL_COPY_FINALIZE_ENABLED` — `.trim().toLowerCase()`, see `orchestrator.ts:524` and `synthesize-publish-posts.ts:116`).
2. Update `ROUTE_MANIFEST.md` with the new `/dashboard/workflows*` and `/api/tenant/workflow-products` routes (manifest/docs sync is a public-readiness item). Re-run `npm run validate:banned-patterns` (the new product surface must not introduce any banned string).
3. Live E2E on the @sugarandleather tenant for each shipped product: start → reach review/approval → render in dashboard. Per memory, **only rendered-on-dashboard counts as done.**
4. `/ship-triage-deploy`; bump `VERSION` (minor) + `CHANGELOG.md`.

**Acceptance:** flag OFF ⇒ zero new reachable surface, weekly flow byte-for-byte unchanged; flag ON ⇒ `/dashboard/workflows` renders the registered products and each shipped product runs to a rendered review state on the live tenant; `full-suite` CI gate green.

## Feature flag

`ARIES_REPEATABLE_WORKFLOWS_ENABLED=1` — gates **reachability** of the repeatable-workflows product surface (`/dashboard/workflows` launcher, `GET /api/tenant/workflow-products`, per-product intake/status routes). Aries treats `1`, `true`, `yes`, or `on` as enabled. **Default OFF.** When OFF, the only product is Weekly Social Content and the new routes redirect to the existing weekly flow (no dead surface). When ON, products whose Hermes side is verified real (and only those) appear in the launcher. This is a rollout switch over a multi-PR epic, **not** the feature itself, and it never changes execution behavior — it only decides what the operator can reach. Process-wide (single-tenant prod). Leave OFF until at least Campaign Plan (Phase B) is live-verified on the @sugarandleather tenant.

## Data / contract changes

- **No new DB tables.** Reuses `aries_research_jobs` (E) and the marketing runtime doc store (all products). The only additive persistence is in the existing `public-{brandSlug}-campaign` contract dir (G), which already exists.
- **New discriminator (in-memory/runtime only):** a `workflow_product` tag on the intake → carried as job metadata so the status view knows which product projection to render. If persisted, it is additive on the runtime doc JSON (no migration; the doc is a JSON blob). Absent ⇒ treat as `weekly_social_content` (read-both/write-new compat, exactly like the `one_off_campaign` widening at `orchestrator.ts:1685-1689`). **Caution:** `requestedJobTypeFromDoc` (`orchestrator.ts:509`) today hard-returns `'weekly_social_content'`; if the product projection layer needs the orchestrator to branch per product, that resolver (or a sibling) must be taught the discriminator — it is not currently product-aware.
- **Per CLAUDE.md memory "widening union → grep inequalities":** the new `WorkflowProductKey` union and any widening of `PublicJobType`/`job_type` require grepping every `=== 'weekly_social_content'` / `!== 'weekly_social_content'` site-wide (`orchestrator.ts:509,916,2079,2095,2144,2153,2187`; `handler.ts:429,431,436,482,489`) — TS will not catch literal-inequality checks. This bug shipped 3× before.
- **Hermes contract:** **no new Hermes workflow is registered by this plan.** Each product calls a skill that already exists. If a product's Hermes output is not yet brief/plan/findings-shaped, the product stays out of the registry (not stubbed). This mirrors the `social_copy_finalize` discipline already in CLAUDE.md.

## Test + verify steps (fixture-primary)

| Layer | What | Count |
|-------|------|-------|
| Unit | `WORKFLOW_PRODUCTS` registry: every entry `hermesBacked:true` maps to a real skill; no stub leaks into products | +2 |
| Unit | `buildWorkflowProductRunView`: projects runtime doc → product view (stages, artifacts, activeApproval, memoryCandidates) | +4 |
| Unit | scope presets: campaign_plan ⇒ image/video counts 0; creative_production ⇒ images>0,video=0 (video stays OFF) | +3 |
| Unit | `landing_brief` artifact projection = headline/subhead/sections/CTA; never emits HTML | +2 |
| Unit | competitor finding without `source_url` is dropped, not surfaced; sourced finding routes to `pending_approval` | +3 |
| Unit | `workflow_product` discriminator read-both/write-new: absent ⇒ weekly; grep-verified no stale literal-inequality | +2 |
| Integration | `GET /api/tenant/workflow-products`: flag OFF ⇒ weekly-only; flag ON ⇒ registered products | +2 |
| Integration | intake POST routes through marketing jobs handler with correct jobType + scope preset; idempotent replay no-op | +2 |
| Integration | approve gate resume for campaign_plan / creative_production uses existing approval path | +2 |
| Integration (banned) | `npm run validate:banned-patterns` stays green with the new surface | +1 |
| Live-DB | competitor finding insert + curation-queue route against real DB (precedent: `tests/marketing/ingest-production-assets-live-db.test.ts`) | +1 |
| E2E (live, manual) | each shipped product: start → render review/approval in @sugarandleather dashboard | manual |

**~26 automated + manual.** New test files allowlisted in `scripts/verify-regression-suite.mjs` (it runs an explicit per-file args list, not a glob — new files must be added there). All tests set `APP_BASE_URL=https://aries.example.com`. Before push run, in order: `npm run guardrails:agent` (parallel-worktree dup-work check), `npm run verify`, then `npm run test:concurrent` (touches routes + backend + handler) and the **CI-exact `full-suite`** gate (required check on master). Teammate-worktree note (memory): if verifying in a fresh worktree, `NODE_ENV=development npm ci` first and re-run `npm run verify` yourself before merging.

## Resumability / idempotency

- Every product run is a marketing job through the existing orchestrator, which already preserves partial artifacts on transient failure and resumes from the runtime doc (CLAUDE.md resumability rule). Products add **no** new execution path, so they inherit this for free.
- Idempotency keys stay job-scoped (the marketing jobs handler already de-dupes; intake replays are no-ops).
- Competitor findings use the existing `aries_research_jobs` idempotency; re-running research does not duplicate findings.
- Public Preview write into the contract dir is idempotent (overwrite-in-place of approved artifacts).

## Rollout

1. Land Phase A behind `ARIES_REPEATABLE_WORKFLOWS_ENABLED=0` (no reachable surface change).
2. Land B (Campaign Plan); flip flag ON in a canary check on @sugarandleather; verify the launcher + Campaign Plan render in the dashboard.
3. Land C–G incrementally; each adds exactly one product card. A product appears in the launcher **only after** its live E2E renders in the dashboard.
4. Keep the flag ON in prod only once ≥1 product is live-verified; OFF is the instant kill switch (launcher redirects to weekly).

## Out of Scope

- **Registering new Hermes workflows / agents.** Hermes-side skill registration is a separate repo and out of scope (same boundary as `social_copy_finalize`). This plan only surfaces products whose Hermes side already exists.
- **Any placeholder/stub product.** A product that lacks a real Hermes output shape is **not** added (banned-pattern discipline).
- **Full landing-page generation or publishing.** Landing Brief is structured copy/sections only; full-page render/publish is explicitly excluded.
- **Video / Reels / Stories generation in Creative Production.** Gated separately by `ARIES_VIDEO_PUBLISH_ENABLED` (see `2026-05-30-story-reel-video-publishing.md`, shipped as surfaces in #520); not lit here.
- **Public Preview password/expiry, comment collection, client sign-off routing.** That is roadmap #9 depth; MVP is the read-only render of approved artifacts.
- **New roles for approval routing.** Reuses existing `tenant_admin/analyst/viewer`; the approver-role split is roadmap #14, tracked elsewhere.
- **Autonomous publishing of any product output.** Approval gates are mandatory; no product introduces auto-publish.

## Risks

- **Union-widening literal-inequality bug (HIGH, shipped 3× before).** New `WorkflowProductKey` + any `PublicJobType`/`job_type` change must be grepped for `=== '<old>'` / `!== '<old>'` at every call site (`orchestrator.ts`, `handler.ts`). Mitigation: explicit grep checklist in the PR + a unit test asserting the discriminator default.
- **`requestedJobTypeFromDoc` is not product-aware (HIGH).** It hard-returns `'weekly_social_content'` (`orchestrator.ts:509`), so all downstream orchestrator branches treat every run as weekly today. Any product needing per-product orchestrator behavior must teach this resolver (or route projection-only through the new view layer, leaving execution weekly-shaped). Mitigation: keep products as *view + scope-preset* over the weekly execution wherever possible; only touch the resolver with a grep-verified, test-covered widening.
- **Stale artifact step name (MEDIUM).** The campaign-plan artifact is written under step `social_content_planner`, not `campaign_planner` (the latter is legacy-compat for in-flight runs). Reading the wrong step yields an empty plan view. Mitigation: read `social_content_planner` with the existing legacy fallback; a unit test asserts the projection resolves the live step name.
- **Surfacing a not-yet-real Hermes output (HIGH).** A product card that runs but produces nothing the dashboard can render = a worse experience than no product. Mitigation: a product is registered only after its live E2E renders on the @sugarandleather tenant; `hermesBacked` gate + the banned-pattern check.
- **Dashboard list-perf regression (MEDIUM).** The list-perf memory is explicit: read-time full-projection is INFEASIBLE; only write-time projection is safe. The product launcher must read the cheap registry + count scalars, **not** full-hydrate every job (CLAUDE.md guardrail #1 + the social-content list-perf memory). Mitigation: launcher reads registry + `pendingApprovals` scalar only; per-job hydration happens on detail open.
- **Competitor-research scope creep into unsourced claims (MEDIUM).** Mitigation: drop-if-no-source enforced in the projection + curation queue; bound the competitor count in intake.
- **Treat-as-production (ALWAYS).** This VM is live prod. Validate every product against the live DB/tenant; mock/test passing does not count. Flag stays OFF in prod until live-verified.
