# Aries AI Canonical Product Requirements Document

**Status:** Canonical operating specification  
**Audience:** Engineers, AI agents, contributors, operators, reviewers  
**Scope:** Aries AI application runtime, Hermes-native orchestration, social content generation, onboarding, memory-aware execution, tenant isolation, approval-gated publishing, and future platform extension  
**Last consolidated:** 2026-05-10  

This PRD is intentionally implementation-aware. It describes the intended product and architecture without overfitting to transient file names, temporary implementations, or deprecated execution systems.

## Source Precedence

When repository documents, runtime behavior, tests, and historical plans conflict, Aries AI uses this precedence order:

1. Verified runtime behavior, tests, logs, and health checks.
2. Current repository code, configuration, and active documentation.
3. Durable project memory and implementation plans.
4. Reasoned inference.

Anything not verified at runtime must be treated as a design intent, planned requirement, compatibility path, or open question, not as a live production fact.

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Product Vision](#2-product-vision)
3. [Core Product Concepts](#3-core-product-concepts)
4. [User Types and Personas](#4-user-types-and-personas)
5. [Primary User Flows](#5-primary-user-flows)
6. [Functional Requirements](#6-functional-requirements)
7. [AI System Requirements](#7-ai-system-requirements)
8. [Architecture Overview](#8-architecture-overview)
9. [Workflow Architecture](#9-workflow-architecture)
10. [Memory Architecture](#10-memory-architecture)
11. [API and Integration Expectations](#11-api-and-integration-expectations)
12. [Multi-Tenant and Security Requirements](#12-multi-tenant-and-security-requirements)
13. [Publishing and Automation Rules](#13-publishing-and-automation-rules)
14. [Non-Functional Requirements](#14-non-functional-requirements)
15. [Operational Constraints](#15-operational-constraints)
16. [Open Questions and Risks](#16-open-questions-and-risks)
17. [Future Expansion Areas](#17-future-expansion-areas)
18. [Glossary](#18-glossary)
19. [Deprecated and Historical Concepts](#19-deprecated-and-historical-concepts)
20. [Canonical Behavioral Invariants](#20-canonical-behavioral-invariants)

---

## 1. Executive Summary

### 1.1 What Aries AI Is

Aries AI is an AI-native orchestration and social content generation platform. It is built around deterministic workflow execution, approval checkpoints, tenant-safe runtime boundaries, provider abstraction, and memory-aware continuation.

The current product center is weekly social content automation. Aries ingests brand and business context, generates structured social content plans and assets, coordinates AI execution through Hermes, surfaces draft artifacts for review, and supports approval-gated publishing workflows. Aries is not a free-form chatbot. Aries is a workflow product in which AI agents perform bounded work under explicit state machines, API contracts, and human review policies.

### 1.2 What Problem Aries Solves

Social content and marketing operations increasingly depend on AI systems, but most AI tooling fails in operational settings because it lacks:

- deterministic execution state;
- approval checkpoints before irreversible actions;
- tenant isolation;
- durable memory with provenance and curation;
- separation between product state and agent execution state;
- provider abstraction;
- reliable retry and resume semantics;
- traceable artifact generation;
- safe publishing boundaries.

Aries solves this by making AI execution a controlled subsystem of a product workflow. The application owns tenancy, authorization, state, approvals, memory promotion, and artifact persistence. Execution providers perform bounded work and return structured results.

### 1.3 Why Aries Exists

Aries exists to make AI-assisted marketing and content operations repeatable, inspectable, and safe enough for real tenant workflows. Its purpose is not to maximize autonomous behavior. Its purpose is to let users delegate repetitive research, planning, drafting, and content production while preserving human control over strategy, memory, and publishing.

### 1.4 Core Product Philosophy

Aries follows these product principles:

1. **Deterministic orchestration over unconstrained chat.** Every production workflow must have an explicit lifecycle, typed inputs, stage boundaries, retry semantics, and terminal states.
2. **Aries owns product truth.** Postgres and Aries-managed runtime records are canonical. Hermes execution traces and Honcho derived memory are not sources of truth.
3. **AI proposes; humans approve high-impact actions.** Human approval is mandatory for publishing, risky automation, strategic memory promotion, and sensitive generated media actions.
4. **Memory is curated, not automatic recall.** Durable memory may only contain approved, tenant-scoped, provenance-bearing facts. Raw tool output, speculative findings, and unapproved candidates must not become memory.
5. **Providers are replaceable.** Workflows should request capabilities such as `image.generate`, `video.generate`, `research.run`, and `publish.dispatch`, not hard-code model vendors into product behavior.
6. **Tenant isolation is a product feature, not only an infrastructure concern.** Tenant context is server-derived, never client-selected, and must shape API access, storage paths, memory namespaces, callbacks, and publishing boundaries.

---

## 2. Product Vision

### 2.1 Long-Term Direction

Aries AI should become a tenant-safe AI operations layer for content, marketing, publishing, and adjacent business workflows. The near-term platform focus is social content generation and publishing. The long-term direction is a workflow operating system where teams can define repeatable AI-assisted processes with memory, approvals, artifacts, integrations, and auditability.

Aries should support:

- structured onboarding and business profile creation;
- brand context ingestion;
- weekly and campaign-based content planning;
- social post, image, and video script generation;
- approval-gated publishing;
- integrations with social platforms and calendars;
- curated tenant memory;
- bounded research jobs;
- contributor-defined workflow extensions;
- provider-agnostic execution adapters.

### 2.2 Intended Platform Evolution

Aries should evolve from a weekly social content workflow into a generalized workflow platform without losing deterministic execution rules. Future workflows may include competitor research, campaign planning, creative production, landing page creation, performance analysis, content calendars, and multi-channel publishing.

Platform expansion must preserve the existing boundary model:

- frontend routes collect user intent and display safe read models;
- backend services validate and normalize tenant-scoped inputs;
- workflow state lives in Aries-owned persistence;
- long-running AI work leaves through an execution provider boundary;
- callbacks re-enter through authenticated internal APIs;
- generated outputs remain drafts until review policy allows promotion, rendering, publishing, or memory persistence.

### 2.3 AI Assistance and Human Approval

Aries should treat AI as an execution assistant, not an independent operator. AI may:

- summarize first-party brand context;
- propose content ideas;
- draft social posts;
- generate images or image requests;
- create video scripts;
- perform bounded research;
- suggest publication schedules;
- prepare platform-specific publish payloads;
- identify memory candidates.

AI must not, without explicit approval:

- publish or activate external content;
- store speculative or third-party findings as durable memory;
- mutate tenant settings;
- connect or disconnect integrations;
- modify secrets;
- send messages to users or customers;
- write directly to Aries canonical data stores;
- bypass workflow state transitions;
- reuse cross-job or cross-tenant execution memory.

---

## 3. Core Product Concepts

### 3.1 Tenant

A tenant is the primary isolation boundary in Aries. All user-visible resources, jobs, artifacts, integrations, memory, publishing state, and audit records belong to exactly one tenant.

Tenant identity must be derived server-side from authenticated user context. The client must not supply arbitrary tenant IDs for access control decisions.

### 3.2 Workspace

In product language, a workspace is the tenant-scoped operating environment where users manage content workflows, integrations, approvals, and artifacts. In memory architecture, the term workspace also refers to a Honcho memory namespace. The two are related but not identical:

- **Aries workspace/product workspace:** the user-facing tenant environment.
- **Honcho workspace:** a derived memory namespace named `aries-tenant-<pseudonym>`.

The PRD uses **tenant** for the authoritative product boundary and **Honcho workspace** when referring specifically to memory storage.

### 3.3 User

A user is an authenticated person associated with one or more tenants. User privileges are tenant-scoped. A user may act as a creator, operator, approver, admin, or viewer depending on tenant membership and role.

### 3.4 Operator

An operator is a user actively configuring or running workflows. Operators may create jobs, review outputs, connect platforms, and trigger publish dispatches if authorized.

### 3.5 Approver

An approver is a user or role authorized to approve workflow stages, content artifacts, publishing actions, or memory promotion. Approvals must be recorded with actor identity, time, target resource, decision, and resulting transition.

### 3.6 Onboarding

Onboarding is the structured process that creates or enriches tenant context. It may collect brand data, target audience, channels, business goals, integration preferences, and initial content constraints. Onboarding can produce brand profile candidates and memory seed candidates, but those candidates must be curated before becoming durable memory.

### 3.7 Brand Profile / Business Profile

The brand or business profile is Aries-owned canonical context describing a tenant’s brand identity, positioning, voice, channels, constraints, and content preferences. It may be assembled from onboarding, website ingestion, user-entered data, or approved research findings.

### 3.8 Workflow

A workflow is a deterministic, multi-stage process with typed inputs, expected outputs, state transitions, retry policies, and approval gates. A workflow may include AI execution but is not defined by the AI model. It is defined by Aries product behavior and orchestration policy.

Examples:

- weekly social content generation;
- onboarding and brand ingestion;
- bounded brand or market research;
- creative asset generation;
- publish dispatch and retry.

### 3.9 Job

A job is a tenant-scoped instance of a workflow. Jobs have stable IDs, statuses, input payloads, execution references, artifacts, audit history, and terminal states. Jobs must be resumable or explicitly non-resumable.

### 3.10 Execution / Run

An execution or run is a provider-level attempt to perform some portion of a job. Hermes runs are execution records. Aries jobs are product records. The distinction is mandatory: a Hermes run may fail, retry, or return partial results without becoming canonical product truth until Aries validates and records the outcome.

### 3.11 Stage

A stage is a named phase inside a workflow. Stages define what work is allowed, what inputs are required, what output schema is expected, and whether approval is required before continuing.

Typical stages include intake, validation, research, planning, drafting, review, rendering, publish preparation, publish dispatch, and completion.

### 3.12 Approval

An approval is a durable decision made by a qualified actor or a narrowly defined auto-approval rule. Approvals can unblock a workflow transition, promote a draft to an artifact, allow publishing, or allow memory persistence.

Approval is not the same as completion. A completed generation stage may still require approval before publishing or memory promotion.

### 3.13 Artifact

An artifact is a generated or uploaded output associated with a tenant and job. Examples include social post drafts, image previews, video scripts, campaign briefs, reports, publishing payloads, brand kits, screenshots, and structured research results.

Artifacts must be tenant-scoped, addressable, auditable, and safe to render in the UI. Raw provider responses should not be exposed directly to users unless explicitly normalized.

### 3.14 Memory

Memory is curated, tenant-scoped context that can be used to improve future execution. Memory is not a dump of conversation history or tool output. Durable memory must have provenance, approval state, confidence, kind, and lifecycle metadata.

### 3.15 Provider

A provider is an execution implementation behind a capability boundary. Examples include Hermes for long-running AI execution, publishing providers for social platforms, and model providers for text, image, or video generation. Product workflows must depend on provider capabilities, not specific vendor names.

### 3.16 Publishing

Publishing is the act of sending approved content or campaign assets to an external platform. Publishing includes preparation, validation, dispatch, retry, and platform response handling. Publishing must be approval-gated and platform-specific constraints must be enforced.

### 3.17 Orchestration

Orchestration is the Aries-owned coordination of workflow stages, execution providers, state updates, approvals, retries, callbacks, artifacts, and memory. Orchestration is deterministic and must not be delegated wholesale to an AI agent.

### 3.18 Callback

A callback is an authenticated provider-to-Aries request carrying execution results. Callbacks are internal, authenticated, schema-validated, and bound to a specific run or job. They are not general-purpose webhooks.

### 3.19 Resume

Resume is the act of continuing a workflow after an approval, callback, repair, retry, or partial failure. Resume must use current Aries state and must not rely on hidden provider memory.

### 3.20 Curation

Curation is the process that evaluates candidate memory or generated findings before persistence. It includes schema validation, reject-list filtering, auto-approval policy evaluation, human review queueing, and final write to durable memory if approved.

---

## 4. User Types and Personas

### 4.1 Tenant Admin

The tenant admin configures the workspace, manages users, connects social platforms, controls sensitive settings, and authorizes publish-capable integrations. Tenant admins can usually approve high-risk workflow actions unless tenant policy restricts approval to specific roles.

Usage pattern:

- sets up the tenant;
- manages OAuth connections and platform integrations;
- approves publishing policies;
- reviews audit logs;
- resolves authorization issues.

### 4.2 Content Operator

The content operator creates content jobs, reviews drafts, edits generated posts, and manages weekly publishing workflows. This user is the primary day-to-day user for social content generation.

Usage pattern:

- starts weekly social content jobs;
- provides goals, themes, constraints, and target channels;
- reviews generated posts, scripts, and image drafts;
- requests revisions;
- submits content for approval or publication.

### 4.3 Marketing Strategist

The marketing strategist uses Aries for brand context, campaign planning, competitive research, and social content strategy. This persona needs structured outputs, not generic copy.

Usage pattern:

- enters brand positioning and audience context;
- reviews campaign or content strategy proposals;
- approves direction before creative production;
- promotes reliable first-party findings to memory.

### 4.4 Approver / Reviewer

The approver is responsible for policy, quality, legal, brand, and publishing approval. The approver may be a tenant admin, manager, client, or designated reviewer.

Usage pattern:

- reviews generated assets;
- rejects risky, off-brand, or inaccurate outputs;
- approves publish dispatch;
- approves durable memory promotion for inferred or strategic findings;
- leaves feedback that can become approved constraints or preferences.

### 4.5 Platform Operator

The platform operator or engineer manages deployment, runtime health, environment configuration, provider integration, and incident response.

Usage pattern:

- validates environment variables;
- monitors Hermes callbacks and job status;
- reviews logs and database health;
- handles provider outages;
- manages production rollouts and feature gates.

### 4.6 Contributor / Open-Source Developer

The contributor uses the PRD, route contracts, tests, and architecture docs to safely extend Aries. Contributors must understand which systems are canonical and which are compatibility or historical paths.

Usage pattern:

- adds workflow capabilities behind provider boundaries;
- writes tests for tenant isolation and approval behavior;
- extends UI read models;
- avoids hard-coding provider credentials or model vendors into product flows.

### 4.7 AI Execution Agent

An AI execution agent is not a user. It is a bounded executor invoked by Aries or Hermes. It receives structured inputs and must return structured outputs. It has no independent product authority.

Usage pattern:

- performs bounded research or generation;
- runs inside a provider-controlled session;
- returns schema-valid output;
- cannot approve its own work;
- cannot publish or mutate Aries state directly.

---

## 5. Primary User Flows

### 5.1 Onboarding Flow

#### Goal

Create or enrich tenant context so Aries can generate relevant social content while preserving tenant boundaries and approval rules.

#### Flow

1. User enters onboarding through the public or authenticated onboarding surface.
2. Aries derives tenant context server-side or creates the appropriate tenant-scoped onboarding record after authentication rules permit it.
3. User provides business identity, website, brand details, channels, goals, audience, content preferences, and constraints.
4. Aries validates the payload and creates an onboarding run.
5. Aries may invoke enrichment through Hermes or another execution provider if enabled.
6. Enrichment output is normalized into a brand/business profile draft and candidate memory facts.
7. User reviews onboarding output before it becomes authoritative brand context where policy requires review.
8. Approved brand facts are written into Aries canonical state.
9. Memory seed candidates are curated; only approved memory candidates enter the tenant memory store.
10. Dashboard and workflow UIs use the approved profile and safe read models.

#### Required Behavior

- Tenant ID must not be accepted from request bodies for authorization.
- Onboarding status must be queryable through safe route handlers.
- Onboarding output must be stored as Aries canonical state before being used as future workflow context.
- Candidate memory from onboarding must not enter durable memory until curation policy permits it.
- Inferred brand conclusions, strategy, tone, positioning, and third-party-derived claims should require human review unless explicitly covered by a narrow first-party auto-approval rule.

### 5.2 Brand Ingestion Flow

#### Goal

Generate usable brand context from a tenant website, explicit user input, or approved existing artifacts.

#### Flow

1. User submits a website URL, brand brief, or existing business profile input.
2. Aries validates URL and tenant authorization.
3. Aries captures first-party context through approved ingestion mechanisms.
4. Aries extracts brand voice, positioning, visual style, product/service ladder, CTAs, target audience, and content constraints.
5. Aries produces a brand profile draft and optional design/content guidance artifacts.
6. User reviews and approves the brand profile or requests changes.
7. Approved brand profile becomes canonical tenant state.
8. Durable memory promotion follows memory curation rules.

#### Required Behavior

- Website or external content must be treated as untrusted input.
- Extracted content must be normalized and schema-validated.
- Brand profile state must be editable and supersedable.
- Brand context used in future workflows must come from Aries canonical state or approved memory, not raw scrape results.

### 5.3 Weekly Social Content Generation Flow

#### Goal

Generate a weekly package of social content drafts and optional media requests that match tenant brand context, target channels, and review policies.

#### Flow

1. User opens a social content job creation surface.
2. User provides objective, theme, audience, competitors if relevant, target channels, constraints, and requested asset counts.
3. Aries validates input, clamps unsafe counts, and derives tenant context server-side.
4. Aries loads approved brand and memory context within a fixed budget.
5. Aries creates a job record and execution request.
6. Aries submits a provider-abstract workflow request to Hermes.
7. Hermes performs bounded planning and generation and returns results through an authenticated callback.
8. Aries validates callback credentials, callback token, run ID, job ID, output schema, tenant association, and idempotency.
9. Aries stores normalized content drafts and artifact metadata.
10. User reviews posts, image previews, scripts, and optional media render requests.
11. User approves, revises, rejects, or requests generation changes.
12. Approved items may proceed to publishing preparation or scheduling.

#### Required Behavior

- Active social-content workflow must use Hermes-native execution by default.
- Product code must not hard-code legacy Lobster/OpenClaw paths into active social-content behavior.
- Media requests must be abstract capability requests rather than provider-specific requests.
- Text planning may run even when media generation is unavailable.
- Video render requests must require human approval.
- Generated drafts must not publish automatically.

### 5.4 Approval Workflow

#### Goal

Ensure that generated strategy, content, media, memory, and publishing actions are reviewed before high-impact transitions.

#### Flow

1. Workflow reaches an approval checkpoint.
2. Aries creates or updates an approval record with target resource, actor requirements, current state, and payload summary.
3. UI displays a safe review model, not raw provider output.
4. Approver chooses approve, reject, request changes, or hold.
5. Aries records the decision and actor metadata.
6. Approval decision triggers a deterministic state transition.
7. If approved, workflow may resume from the next allowed stage.
8. If rejected or changes requested, workflow enters revision or terminal rejected state.

#### Required Approval Checkpoints

- campaign or content strategy before asset production when applicable;
- generated content before publishing;
- generated media render requests when they may incur cost or produce externally visible artifacts;
- publish dispatch to external platforms;
- durable memory promotion for strategic, inferred, third-party, or lower-confidence findings;
- integration connection changes if platform policy requires tenant admin consent.

### 5.5 Publishing Workflow

#### Goal

Dispatch approved content to configured external platforms without bypassing review or platform constraints.

#### Flow

1. User connects platform account through OAuth or another supported integration mechanism.
2. Aries stores integration state and encrypted credentials according to security rules.
3. User selects approved content for publishing.
4. Aries prepares platform-specific payloads and validates required fields.
5. Aries displays a publish review summary.
6. Authorized approver confirms dispatch.
7. Aries dispatches through the appropriate publishing provider.
8. Provider response is recorded in Aries.
9. UI shows success, failure, or retryable error.
10. Retry can be triggered only for approved content and must preserve idempotency where possible.

#### Required Behavior

- Publishing must be explicit and approval-gated.
- Default campaign creation behavior for ad platforms should create paused/draft entities unless explicitly authorized otherwise and supported by tenant policy.
- Publish retry must not regenerate content unless user requests a new generation workflow.
- Publishing providers must not receive secrets unrelated to the platform action.

### 5.6 Execution Resume and Retry Flow

#### Goal

Allow long-running workflows to continue after callbacks, failures, approvals, or manual retries without losing state or duplicating side effects.

#### Flow

1. Job enters a waiting, submitted, retryable failure, or approval-required state.
2. Aries stores state, current stage, attempt count, maximum attempts, last error, and next allowed transition.
3. Resume trigger occurs through callback, approval, retry endpoint, or operator action.
4. Aries revalidates tenant authorization and current job state.
5. Aries determines whether the transition is allowed.
6. Aries resumes from the last known stage or starts a new provider execution with an idempotency key.
7. Aries records transition history.
8. Job reaches completed, partial, failed, canceled, or another waiting state.

#### Required Behavior

- Resumption must depend on Aries state, not hidden provider state.
- Retry must distinguish retryable from non-retryable errors.
- Duplicate callbacks must be idempotently ignored or merged.
- Partial results must be represented explicitly, not silently treated as success.

### 5.7 Memory and Context Continuation Flow

#### Goal

Use approved tenant memory to improve future AI executions without leaking tenants, preserving bad data, or treating unverified conclusions as fact.

#### Flow

1. Aries starts a memory-aware workflow.
2. Aries derives tenant context server-side.
3. Aries loads current, approved, non-superseded memory relevant to the workflow type.
4. Aries caps retrieved context to a fixed budget.
5. Aries excludes raw scrape, unapproved candidates, superseded messages, secrets, cross-tenant identifiers, and speculative summaries.
6. Aries sends curated context snippets to Hermes as bounded context.
7. Hermes returns findings or outputs with sources, uncertainty, and structured fields.
8. Aries validates and stores raw result in canonical DB if needed.
9. Curator rejects, queues, or approves candidate memory.
10. Approved memory is written to the relevant tenant memory peer with provenance and supersession metadata.

#### Required Behavior

- Hermes payloads must not include real tenant IDs.
- Memory retrieval must never use another tenant’s workspace.
- Honcho-derived synthesized responses must not be treated as authoritative facts unless backed by stored approved messages.
- Memory updates must be append-only and supersede prior messages instead of mutating history.

---

## 6. Functional Requirements

### 6.1 Operator Interface Requirements

**FR-UI-1:** Aries must provide authenticated operator screens for dashboard, onboarding, social content job creation, job status, approvals, integrations, and publishing actions.

**FR-UI-2:** The UI must consume safe read models from Aries APIs. It must not require raw provider envelopes, internal execution traces, secrets, or unrestricted tenant identifiers.

**FR-UI-3:** Job status screens must display current state, current stage, last update, approval requirements, generated artifacts, and retry/publish actions when allowed.

**FR-UI-4:** Review screens must make it clear which artifacts are drafts, which are approved, which are rejected, and which are published or dispatch-ready.

**FR-UI-5:** UI must avoid exposing real tenant IDs when a pseudonym or display name is sufficient.

### 6.2 Tenant Onboarding Requirements

**FR-ONB-1:** Aries must support structured onboarding creation through a server-side route handler.

**FR-ONB-2:** Onboarding inputs must be validated and normalized before any execution provider receives them.

**FR-ONB-3:** Onboarding runs must have queryable status.

**FR-ONB-4:** Onboarding output must produce or update tenant-scoped brand/business profile state.

**FR-ONB-5:** Onboarding may produce candidate memory, but candidate memory must pass curation before durable memory persistence.

**FR-ONB-6:** Onboarding must fail closed if tenant context is missing, malformed, or unauthorized.

### 6.3 Brand and Business Profile Requirements

**FR-BRAND-1:** Aries must maintain a canonical tenant brand/business profile.

**FR-BRAND-2:** Brand profiles should include, at minimum, brand name, channels, audience, tone, style constraints, content goals, offers/services, and disallowed content patterns.

**FR-BRAND-3:** Brand profile updates must be traceable to user action, onboarding, approved memory, or approved enrichment.

**FR-BRAND-4:** Brand profile context must be available to social content generation and publishing preparation.

**FR-BRAND-5:** External brand ingestion must treat website and scraped data as untrusted until normalized and validated.

### 6.4 Social Content Job Requirements

**FR-SOC-1:** Aries must support creation of weekly social content jobs.

**FR-SOC-2:** Job creation must validate objectives, channels, requested counts, constraints, and tenant authorization.

**FR-SOC-3:** Default content generation should support a bounded weekly scope and clamp unsafe or unsupported requested counts.

**FR-SOC-4:** Aries must support static post drafts, image preview requests, video script drafts, and optional video render requests.

**FR-SOC-5:** Active social-content workflows must use Hermes-native execution by default.

**FR-SOC-6:** Active social-content payloads must not depend on legacy Lobster workflow files or direct provider credentials.

**FR-SOC-7:** Content outputs must be stored as tenant-scoped artifacts or draft records before they are rendered in the UI.

**FR-SOC-8:** Generated content must include enough metadata to support review, revision, scheduling, publishing, and audit.

### 6.5 Research Requirements

**FR-RES-1:** Aries should support bounded research jobs when the feature gate is enabled.

**FR-RES-2:** Research jobs must be tenant-scoped and persisted in Aries canonical state.

**FR-RES-3:** Research execution should route through a dedicated Hermes `aries-research` profile or equivalent bounded execution path.

**FR-RES-4:** Research findings must include kind, claim, sources, confidence, uncertainty, and provenance metadata.

**FR-RES-5:** Research findings must not become durable memory until they pass curation.

**FR-RES-6:** Strategic, inferred, third-party, or speculative findings must require human review before memory promotion.

### 6.6 Artifact Requirements

**FR-ART-1:** Aries must persist generated artifacts in tenant-scoped locations or canonical records.

**FR-ART-2:** Artifact paths must not allow traversal, absolute path injection, cross-tenant references, or provider-controlled write targets.

**FR-ART-3:** Artifacts must be associated with job ID, tenant ID, workflow stage, creation time, source execution, and approval state when applicable.

**FR-ART-4:** UI-facing artifact previews must remove secrets, internal provider metadata, and unsafe raw content.

**FR-ART-5:** Artifacts should be versioned or supersedable when users request revisions.

### 6.7 Approval Requirements

**FR-APP-1:** Aries must support approval records for workflow stages, artifacts, publish dispatch, and memory promotion.

**FR-APP-2:** Approval records must include actor, tenant, target, decision, timestamp, decision payload, and resulting state transition.

**FR-APP-3:** Workflows must not proceed past approval-gated stages without a valid approval or explicitly configured safe auto-approval policy.

**FR-APP-4:** Auto-approval must be narrow, auditable, configurable, and revocable.

**FR-APP-5:** Rejection or revision requests must be represented as workflow state, not as informal comments only.

### 6.8 Integration Requirements

**FR-INT-1:** Aries must support tenant-scoped integration states for supported social and publishing platforms.

**FR-INT-2:** Integration status must distinguish disconnected, pending, connected, syncing, ready, paused, repairing, failed, and reauthorization-required conditions where applicable.

**FR-INT-3:** OAuth connect, callback, reconnect, and disconnect flows must be tenant-authorized.

**FR-INT-4:** Integration credentials must be stored according to secure token storage rules.

**FR-INT-5:** Integration failures must be visible in UI with repair or reconnect options when allowed.

### 6.9 Publishing Requirements

**FR-PUB-1:** Aries must support publish preparation, dispatch, response recording, and retry.

**FR-PUB-2:** Publishing must only operate on approved content or approved campaign assets.

**FR-PUB-3:** Publishing must validate platform-specific required fields before dispatch.

**FR-PUB-4:** Publishing must record provider response, external IDs when available, status, error details, and retryability.

**FR-PUB-5:** Publish retries must not duplicate external entities when idempotency controls or provider semantics allow deduplication.

**FR-PUB-6:** Publishing must not activate paid campaigns automatically unless the tenant has explicitly approved that exact action and platform policy supports it. Default ad-platform behavior should create paused or draft entities.

### 6.10 Execution Provider Requirements

**FR-EXEC-1:** Aries must expose execution through provider ports, not direct workflow implementation calls from UI routes.

**FR-EXEC-2:** Hermes is the default provider for long-running social content execution.

**FR-EXEC-3:** Execution submissions must include callback URL, callback token, run/job IDs, workflow key, workflow version, tenant-safe context, and idempotency where applicable.

**FR-EXEC-4:** Execution providers must return structured results, either synchronously for explicitly short operations or asynchronously through callbacks for long-running workflows.

**FR-EXEC-5:** Legacy providers may remain only as explicit compatibility or fallback paths, not active default behavior.

### 6.11 Audit Requirements

**FR-AUD-1:** Aries must record workflow state transitions, approval decisions, publish dispatch attempts, integration changes, and memory promotion events.

**FR-AUD-2:** Audit records must be tenant-scoped and actor-attributed where applicable.

**FR-AUD-3:** Cross-tenant denial attempts and malformed tenant access attempts should be logged for operational review.

**FR-AUD-4:** Audit logs must redact secrets and provider credentials.

---

## 7. AI System Requirements

### 7.1 Provider Abstraction

**ASR-PROV-1:** Aries workflows must request capabilities, not vendors. Examples:

- `text.plan`
- `text.generate`
- `image.generate`
- `video.script`
- `video.render`
- `research.run`
- `publish.prepare`
- `publish.dispatch`

**ASR-PROV-2:** Hermes or another execution provider may map capabilities to concrete model vendors, but Aries product behavior must not depend on the vendor name.

**ASR-PROV-3:** Active social-content requests must not include direct model provider credentials.

**ASR-PROV-4:** Provider-specific failures must be normalized into Aries runtime states and error models.

### 7.2 Deterministic Orchestration

**ASR-DET-1:** AI execution must operate inside deterministic workflow stages.

**ASR-DET-2:** Every AI request must have typed inputs and expected output schema.

**ASR-DET-3:** Every AI output must be validated before updating canonical product state.

**ASR-DET-4:** Workflows must define allowed transitions. AI output may influence content, but must not invent state transitions.

**ASR-DET-5:** Long-running AI jobs must be callback-based, not synchronous polling, except for explicitly short development or test paths.

### 7.3 Memory Handling

**ASR-MEM-1:** AI executions may receive curated tenant context only through Aries-controlled retrieval.

**ASR-MEM-2:** Context snippets sent to execution providers must exclude secrets, raw tool logs, raw scrape dumps, unapproved memory candidates, and unrelated tenant data.

**ASR-MEM-3:** Memory context must fit a bounded token or size budget.

**ASR-MEM-4:** Superseded memory must not be injected into future execution context except for explicit audit/debug tasks.

**ASR-MEM-5:** AI output must not directly write to memory. Aries curation controls memory persistence.

### 7.4 Hallucination Boundaries

**ASR-HAL-1:** AI outputs must distinguish sourced facts, inferred claims, creative suggestions, and uncertain conclusions.

**ASR-HAL-2:** Research outputs must include source URLs and fetch timestamps when claiming externally sourced facts.

**ASR-HAL-3:** AI must not invent citations, platform results, publish status, external IDs, or runtime state.

**ASR-HAL-4:** Scraped or external content must be treated as untrusted input and wrapped or labeled accordingly in prompts and intermediate representations.

**ASR-HAL-5:** Outputs that fail schema validation, contain prompt-injection artifacts, or include secrets must be rejected before persistence or display.

### 7.5 Approval Requirements

**ASR-APR-1:** AI-generated social posts are drafts until approved.

**ASR-APR-2:** AI-generated images and previews require review before publishing.

**ASR-APR-3:** Video render requests require explicit human approval.

**ASR-APR-4:** Strategic, inferred, third-party, or lower-confidence research findings require human approval before durable memory persistence.

**ASR-APR-5:** AI must never approve its own output for publishing or memory promotion.

### 7.6 Safety Constraints

**ASR-SAFE-1:** AI execution providers must not receive real tenant IDs when pseudonyms are sufficient.

**ASR-SAFE-2:** AI execution providers must not receive access tokens, refresh tokens, API keys, cookies, raw headers, or unrelated credentials.

**ASR-SAFE-3:** Research agents must not have tools that write Aries DB state, publish to user channels, or access Aries tenant memory workspaces.

**ASR-SAFE-4:** Generated content must be checked for tenant policy, platform policy, brand constraints, and obvious unsafe content before publishing.

**ASR-SAFE-5:** Agent prompt injection defenses must be part of research and scrape workflows.

### 7.7 Retry Semantics

**ASR-RETRY-1:** AI execution retries must use stable job/run identifiers and idempotency keys where applicable.

**ASR-RETRY-2:** Retryable errors must be distinguished from non-retryable validation, authorization, or policy failures.

**ASR-RETRY-3:** Retrying must not cause duplicate publish dispatch or duplicate memory writes.

**ASR-RETRY-4:** Partial AI results must be preserved if useful and safe, but must be labeled partial.

### 7.8 Context Management

**ASR-CTX-1:** Context sent to AI must be purpose-specific and bounded.

**ASR-CTX-2:** Aries must prefer current approved brand profile and memory over stale or deprecated artifacts.

**ASR-CTX-3:** When context conflicts, Aries should prefer newer approved non-superseded memory and canonical profile state over older artifacts.

**ASR-CTX-4:** AI must not assume access to files, tools, or integrations that were not included in its explicit execution payload.

### 7.9 Tool Access Expectations

**ASR-TOOL-1:** Tool access must be declared by execution profile.

**ASR-TOOL-2:** The research profile may use web fetch and scrape tools if enabled, but must not write Aries state directly.

**ASR-TOOL-3:** Publishing tools may only be invoked through Aries publishing providers after approval.

**ASR-TOOL-4:** Memory tools must be controlled by Aries, not general-purpose AI agents.

---

## 8. Architecture Overview

### 8.1 High-Level Architecture

Aries is a Next.js App Router application with backend services, route handlers, Postgres persistence, runtime file storage, and an execution-provider boundary.

Canonical flow:

```text
Browser / Operator UI
        ↓
Next.js Pages and Server Components
        ↓
Route Handlers / UI API Contracts
        ↓
Aries Backend Services
        ↓
Execution Provider Ports
        ↓
Hermes / Provider Runtime
        ↓
Authenticated Callback to Aries
        ↓
Postgres + Runtime Artifacts + Approval State + Derived Memory
```

### 8.2 Frontend

The frontend provides:

- public marketing and onboarding pages;
- authenticated dashboard and operator shell;
- workflow creation screens;
- job status and artifact review screens;
- approval surfaces;
- integration settings;
- publishing review and retry surfaces.

Frontend code must not own security decisions. It displays server-provided safe read models and submits user intent to route handlers.

### 8.3 Route Handlers

Route handlers are the browser-facing API contract. They must:

- authenticate users;
- derive tenant context server-side;
- validate request bodies;
- call backend services;
- return typed safe responses;
- avoid exposing provider internals;
- fail closed on missing or invalid tenant context.

### 8.4 Backend Services

Backend services own domain behavior:

- onboarding and business profile state;
- social content job creation and status;
- execution submission;
- approval state;
- artifact normalization;
- publishing preparation and dispatch;
- integration state;
- memory loading and curation;
- audit logging.

Backend services must be testable independent of UI rendering.

### 8.5 Orchestration Layer

The orchestration layer coordinates workflow stages, job state, execution providers, callbacks, approvals, retries, and artifacts. It is Aries-owned and deterministic.

The orchestration layer must not defer product policy decisions to Hermes. Hermes executes bounded tasks. Aries decides what happens next.

### 8.6 Execution Providers

Execution providers are adapters that perform long-running or specialized work.

Current intended provider posture:

- **Hermes:** default for long-running AI execution and social content workflows.
- **Legacy OpenClaw/Lobster:** deprecated compatibility or explicit fallback only.
- **Model vendors:** hidden behind Hermes or provider adapters.
- **Publishing providers:** platform-specific integration adapters behind Aries approval and dispatch policies.

### 8.7 Memory Systems

Memory architecture separates canonical state from derived recall:

- **Postgres:** canonical source of truth for jobs, findings, profiles, approvals, artifacts, integrations, and audit.
- **Honcho:** derived tenant memory store for approved durable facts only.
- **Hermes sessions:** execution traces, not Aries state and not tenant memory.

### 8.8 Persistence Layers

Aries persistence includes:

- Postgres for canonical state;
- tenant-scoped runtime files under configured data roots;
- derived memory in Honcho when memory features are enabled;
- provider-side execution traces that are useful for audit but not canonical.

### 8.9 APIs

Aries APIs include:

- onboarding APIs;
- social content job APIs;
- job status APIs;
- approval APIs;
- integration and OAuth APIs;
- publish dispatch and retry APIs;
- internal execution callback APIs;
- future research job APIs.

APIs should be browser-safe unless explicitly internal. Internal APIs must authenticate with internal secrets and per-run tokens where applicable.

### 8.10 Webhooks

Aries does not expose a general inbound webhook model as a product primitive. Existing callback-style endpoints are internal execution callbacks or OAuth callbacks. Future external webhook support must define authentication, tenant mapping, replay protection, schema validation, and authorization rules before being treated as supported product behavior.

---

## 9. Workflow Architecture

### 9.1 Workflow Lifecycle

Every workflow must define:

- workflow key;
- workflow version;
- tenant scope;
- input schema;
- stage list;
- output schema;
- approval checkpoints;
- execution provider capabilities;
- retry limits;
- terminal states;
- artifact types;
- audit events.

A workflow instance becomes a job. A job may have one or more provider executions/runs.

### 9.2 Core Execution States

Aries should normalize runtime state across workflows. Recommended canonical states:

| State | Meaning |
|---|---|
| `accepted` | Request accepted and persisted, not yet executing. |
| `queued` | Waiting for execution or scheduler availability. |
| `submitted` | Submitted to provider; waiting for callback or completion. |
| `running` | Aries or provider work in progress. |
| `awaiting_approval` | Blocked on human approval. |
| `waiting_repair` | Blocked on repairable issue or missing information. |
| `retrying` | Retry has been scheduled or is executing. |
| `partial` | Some useful output exists, but workflow did not fully complete. |
| `completed` | Workflow completed successfully. |
| `failed` | Workflow failed with no automatic continuation. |
| `canceled` | Workflow was intentionally canceled. |

Workflow-specific states may exist, but they should map to these canonical states for UI and API consistency.

### 9.3 Stage Transitions

Stage transitions must be explicit. A workflow stage may transition because of:

- successful synchronous work;
- provider callback;
- human approval;
- user revision request;
- retry trigger;
- timeout;
- cancellation;
- validation failure;
- policy failure.

A stage transition must record previous state, new state, actor or trigger, timestamp, and reason.

### 9.4 Weekly Social Content Workflow Stages

The intended weekly social content lifecycle:

1. **Intake:** collect objective, channels, scope, constraints, and content counts.
2. **Validation:** normalize inputs, clamp counts, derive tenant context, check integration prerequisites.
3. **Context Assembly:** load approved brand profile and bounded memory context.
4. **Execution Submission:** submit workflow request to Hermes using workflow key and version.
5. **Provider Execution:** Hermes generates structured drafts and abstract media requests.
6. **Callback Validation:** Aries validates callback authentication, callback token, run/job IDs, schema, and idempotency.
7. **Artifact Normalization:** Aries stores draft posts, scripts, images/previews, and metadata.
8. **Review:** user reviews generated content.
9. **Revision or Approval:** user requests changes or approves artifacts.
10. **Publish Preparation:** Aries creates platform-specific draft payloads for approved content.
11. **Publish Approval:** authorized approver confirms external dispatch.
12. **Dispatch:** Aries sends approved payloads to external platforms.
13. **Completion:** Aries records final statuses and exposes results.

**Implementation note (v0.1.2.7 — poll-bridge):** The lifecycle above describes the intended callback-native model. In the current runtime, Hermes `/v1/runs` does not invoke the `callback_url` field submitted with the request — it is a polling API only. `HermesMarketingPort` compensates with a poll-bridge: after submitting a run, it spawns a background task that polls `GET /v1/runs/{id}` until the run reaches a terminal status, then calls `handleHermesRunCallback` in-process (bypassing the HTTP route, since we are already inside the trusted backend). This makes step 6 above (Callback Validation) execute in-process rather than over HTTP. The behavioral contract is identical; the transport is different. The poll-bridge is enabled by default and can be disabled with `HERMES_POLL_BRIDGE_ENABLED=0` (e.g., in tests that supply their own callback). See `backend/marketing/ports/hermes.ts` for the implementation.

**Update (v0.1.15.1 — durable reconciler):** The per-request poll-bridge above did not survive the Next.js production request lifecycle, so completed runs were never ingested and every marketing job was eventually reaped (no marketing success 2026-05-27 → fix). The durable delivery mechanism is now the **Hermes run reconciler** (`backend/marketing/hermes-reconciler.ts` + `scripts/hermes-reconciler-worker.ts`), a standing worker spawned by `start-runtime.mjs` as a sibling of the stale-run reaper. Every `ARIES_RECONCILER_INTERVAL_MS` (default 60s) it re-discovers in-flight marketing runs and ingests any Hermes has finished, via the same idempotent `handleHermesRunCallback` path (deterministic `event_id = reconcile-<hermesRunId>`). Gated by `ARIES_RECONCILER_ENABLED` (default ON). The poll-bridge remains present as a best-effort fast path, but the reconciler is what guarantees delivery.

### 9.5 Research Workflow Stages

The intended bounded research lifecycle:

1. **Job Submission:** authenticated user or scheduled task requests research.
2. **Tenant Derivation:** Aries derives tenant context server-side.
3. **Job Persistence:** Aries creates a research job and callback token.
4. **Memory Context Load:** Aries loads approved non-superseded memory relevant to the task.
5. **Hermes Dispatch:** Aries sends pseudonymized payload to Hermes.
6. **Research Execution:** Hermes uses approved research tools and returns structured findings.
7. **Callback Validation:** Aries validates callback and schema.
8. **Canonical Storage:** Aries stores raw findings in Postgres.
9. **Curation:** Aries rejects, auto-approves, or queues findings for human review.
10. **Memory Promotion:** approved findings are written to tenant memory.
11. **Result Surface:** UI shows completed, partial, failed, or approval-pending outcome.

### 9.6 Approval Checkpoints

Approval checkpoints are required when a transition would:

- make generated content externally visible;
- activate or publish paid campaigns;
- incur significant provider cost or generate sensitive media;
- persist strategic or inferred findings as memory;
- change tenant policy or compliance constraints;
- connect, disconnect, or repair sensitive integrations;
- resume a workflow after policy-related repair.

### 9.7 Retry and Resumability

Workflows must support retry and resume through Aries state. Requirements:

- Retryable errors must be flagged explicitly.
- Attempt count and max attempts must be recorded.
- Last error must include safe reason, retryability, and stage.
- Retry must use idempotency where possible.
- Resume after approval must re-read current Aries state.
- Provider callbacks after terminal states must be ignored or recorded as late events without mutating terminal outcomes unless explicitly designed otherwise.

### 9.8 Callback Handling

Internal callbacks must:

- require internal bearer authentication;
- include a per-run callback token;
- include run and job identifiers;
- validate schema before write;
- derive tenant association from stored job records, not callback payload claims;
- handle duplicate callbacks idempotently;
- record raw envelopes only in Aries canonical DB, not memory;
- normalize results before UI exposure.

---

## 10. Memory Architecture

### 10.1 Memory Goals

Aries memory exists to provide safe continuity across workflows. It should help Aries remember approved facts, preferences, constraints, research conclusions, rejected angles, and tenant-specific context while avoiding cross-tenant leaks and unreviewed hallucination persistence.

Memory goals:

- improve future generated content quality;
- retain approved first-party facts;
- preserve user preferences and style constraints;
- remember rejected angles and policy constraints;
- maintain provenance and auditability;
- avoid storing sensitive, speculative, raw, malformed, or cross-tenant data.

### 10.2 System Responsibilities

Aries owns:

- tenant authorization;
- canonical state;
- memory read/write API;
- pseudonymization;
- curation policy;
- approval queue;
- durable memory promotion;
- memory lifecycle.

Hermes owns:

- bounded execution;
- ephemeral execution traces;
- structured result generation;
- research tool use when enabled.

Honcho stores:

- approved durable memory only;
- tenant-scoped workspaces;
- messages on peers;
- sessions grouping approved memories when needed.

Honcho must not store raw scrape, failed envelopes, malformed output, credentials, logs, unapproved candidates, or provider traces.

### 10.3 Tenant Isolation

Each tenant must have a separate Honcho workspace:

```text
aries-tenant-<tenantPseudonym>
```

The tenant pseudonym should be derived from a keyed HMAC over the real tenant ID:

```text
HMAC_SHA256(ARIES_TENANT_PSEUDONYM_SALT, tenantId).hex.slice(0, 32)
```

This pseudonym is identifier hygiene. It prevents real tenant IDs from appearing in Honcho and Hermes payloads. It is not access control by itself.

### 10.4 Memory Peers

Recommended peer structure per tenant workspace:

| Peer | Purpose | First-party? |
|---|---|---|
| `peer-brand` | Tenant brand identity and approved brand facts. | Yes |
| `peer-policy` | Tenant compliance, style, voice, and content constraints. | Yes |
| `peer-user-<userPseudonym>` | Individual user preferences. | Yes |
| `peer-approver-<userPseudonym>` | Approval trail attribution when needed. | Yes |
| `peer-competitor-<competitorPseudonym>` | Approved competitor facts. | Usually no |
| `peer-audience-<segmentId>` | Approved audience segment context. | Mixed |
| `peer-market-signal-<topic>` | Approved market signals. | No |

### 10.5 Memory Sessions

Honcho sessions must be bounded grouping containers, not long-lived memory stores.

Recommended sessions:

| Session ID | Purpose |
|---|---|
| `session-curated-<jobId>` | Approved facts from one curation cycle. |
| `session-onboarding-<runId>` | Approved facts from one onboarding run. |
| `session-strategy-<jobId>` | Approved facts from one strategy workflow. |

In-flight research jobs should not create tenant Honcho sessions. Hermes execution traces live in Hermes’s own workspace.

### 10.6 Message Schema

Every approved memory message should use a structured body:

```json
{
  "kind": "fact | preference | constraint | rejected_angle | research_conclusion",
  "claim": "string",
  "sources": [
    {
      "url": "string",
      "fetched_at": "iso8601",
      "trust": "first_party | third_party"
    }
  ],
  "confidence": 0.0,
  "approved_by": "userPseudonym | system",
  "approved_at": "iso8601",
  "supersedes": "previous_message_id | null",
  "research_job_id": "string | null"
}
```

### 10.7 Persistence Boundaries

Postgres is canonical. Honcho is derived memory.

Aries Postgres should store:

- jobs;
- findings;
- approvals;
- artifacts;
- raw provider envelopes when needed;
- integration state;
- audit logs;
- brand/business profiles.

Honcho should store only:

- approved memory messages;
- approved peer/session associations;
- derived recall over approved messages.

### 10.8 Retrieval Semantics

Memory retrieval must:

- derive tenant workspace from server-side tenant context;
- load only current approved non-superseded messages by default;
- exclude audit-only superseded messages unless explicitly requested;
- select peers relevant to workflow type;
- cap context size;
- include source/provenance metadata when useful;
- avoid treating synthesized recall as authoritative without backing messages.

### 10.9 Curation Rules

Candidate memory has three outcomes:

1. **Drop:** never leaves Aries DB.
2. **Auto-approve:** promoted to durable memory under narrow policy.
3. **Queue for review:** awaits human decision.

Recommended auto-approval criteria:

- kind is first-party factual, preference, or constraint;
- source is first-party or explicitly user-entered;
- confidence meets configured threshold;
- candidate maps to first-party peer;
- no secrets or cross-tenant identifiers;
- schema-valid and discrete.

Strategic, inferred, competitor, market, audience, or third-party-sourced findings should require human review.

### 10.10 Hard Reject List

The curator must reject:

- raw scraped HTML;
- DOM dumps;
- raw page text excerpts unless explicitly approved and safe;
- tool logs;
- request/response bodies;
- headers;
- cookies;
- bearer tokens;
- API keys;
- refresh tokens;
- JWT-shaped strings;
- AWS keys;
- base64 PEMs;
- OpenAI, Anthropic, Gemini, or similar provider key prefixes;
- malformed provider output;
- schema-violating responses;
- findings referencing another tenant’s pseudonym;
- unapproved candidate facts;
- low-confidence claims below configured threshold;
- speculative claims without provenance;
- narrative summaries that are not discrete factual statements.

### 10.11 Memory Lifecycle

Memory lifecycle states:

1. **Candidate:** stored in Aries DB only.
2. **Rejected:** retained for audit if appropriate, never injected into future context unless explicitly requested for audit/debug.
3. **Pending approval:** waiting on human review.
4. **Approved/current:** eligible for retrieval.
5. **Superseded:** retained for audit, excluded from default retrieval.
6. **Archived/deleted:** removed or inaccessible according to tenant deletion and retention policy.

### 10.12 Tenant Deletion and Archive

Tenant deletion or archival must include durable memory cleanup. Workspace-per-tenant enables a single workspace-level deletion or archive operation rather than multi-peer cleanup. The exact Honcho deletion mechanism must be verified before production reliance.

---

## 11. API and Integration Expectations

### 11.1 API Philosophy

Aries APIs are product contracts. They must be stable, typed, tenant-safe, and explicit about state. They should not expose raw internal provider behavior.

API rules:

- derive tenant context server-side;
- validate body shape and allowed transitions;
- use safe response models;
- return explicit status and error shape;
- redact secrets;
- avoid provider-specific leakage;
- maintain idempotency for callbacks, publish dispatch, and retry where applicable.

### 11.2 Route Families

Expected API route families:

- onboarding start and status;
- social content jobs and job status;
- approvals and stage decisions;
- integrations sync/status;
- OAuth connect, callback, reconnect, disconnect;
- publish dispatch and retry;
- internal Hermes callback handling;
- future research jobs and research status;
- health checks and operational validation routes.

### 11.3 Internal APIs

Internal APIs such as Hermes callbacks must:

- require `INTERNAL_API_SECRET` or equivalent bearer authentication;
- require per-run callback tokens;
- validate callback schema;
- map callbacks to stored jobs;
- not trust tenant IDs in callback payloads;
- be excluded from browser-facing route assumptions.

### 11.4 OAuth and Integrations

OAuth and platform integrations must support:

- connect;
- callback;
- reconnect;
- disconnect;
- status;
- reauthorization-required states;
- token refresh where applicable;
- secure token storage;
- tenant-scoped visibility.

### 11.5 Publishing APIs

Publishing APIs must support:

- publish preparation;
- dispatch;
- retry;
- platform response recording;
- external ID tracking;
- failure handling;
- idempotency or deduplication policy;
- approval verification before dispatch.

### 11.6 Provider Integration Model

Providers should be adapters implementing typed capability ports. Aries should be able to swap provider implementations without rewriting product workflow behavior.

Provider adapters must normalize:

- request payloads;
- callback formats;
- error formats;
- retry hints;
- partial results;
- provider metadata;
- artifact references.

---

## 12. Multi-Tenant and Security Requirements

### 12.1 Tenant Isolation Requirements

**SEC-TEN-1:** Every tenant-scoped operation must derive tenant context server-side.

**SEC-TEN-2:** Missing, malformed, or unauthorized tenant context must deny access.

**SEC-TEN-3:** Client-supplied tenant IDs must not authorize access.

**SEC-TEN-4:** List responses must filter by tenant.

**SEC-TEN-5:** Artifact paths must be tenant-scoped.

**SEC-TEN-6:** Cross-tenant access attempts must be denied and auditable.

**SEC-TEN-7:** Execution payloads must use pseudonyms where provider execution does not require real tenant identity.

### 12.2 Authorization Expectations

Aries should support role-based authorization for:

- tenant admin settings;
- onboarding and profile updates;
- job creation;
- artifact review;
- publish approval;
- integration management;
- memory approval;
- operational admin/debug views.

Roles should be enforced server-side. UI hiding is not authorization.

### 12.3 Secret Handling

Secrets include API keys, OAuth tokens, refresh tokens, session cookies, platform credentials, internal callback secrets, provider keys, database credentials, and encryption keys.

Rules:

- secrets must not be sent to Hermes unless required for a specific provider action and explicitly permitted;
- provider credentials should be held by provider runtimes or secure Aries backend services;
- access tokens should not be stored in browser storage;
- refresh/session tokens must be encrypted and scoped;
- logs and audit records must redact secrets;
- raw request headers and provider envelopes containing credentials must not be written to memory;
- internal and outbound secrets must be distinct.

### 12.4 Approval Boundaries

Approval boundaries are security boundaries. Workflows must not bypass approval because a provider returned a confident answer.

Approvals are required for:

- external publishing;
- paid campaign activation;
- video render requests;
- strategic memory persistence;
- third-party or inferred research memory;
- sensitive integration changes;
- policy constraints that affect future generation.

### 12.5 Auditability

Aries must audit:

- job creation;
- stage transitions;
- provider submissions;
- callbacks;
- approval decisions;
- publish dispatch attempts;
- integration changes;
- memory promotions and supersessions;
- rejected cross-tenant attempts.

Audit records must be queryable by tenant and must preserve enough detail for incident review without leaking secrets.

### 12.6 Execution Restrictions

Hermes and other execution providers must not:

- mutate Aries DB directly;
- read or write Aries tenant memory workspaces;
- publish to user-facing channels without Aries-approved dispatch;
- retain tenant facts across jobs;
- choose tenant context;
- bypass callback validation;
- reuse long-lived sessions as Aries memory.

---

## 13. Publishing and Automation Rules

### 13.1 Automation Classes

Aries distinguishes four automation classes:

1. **Safe internal automation:** validation, normalization, status updates, read model projection.
2. **Draft generation:** AI content creation that remains internal and reviewable.
3. **Review-gated automation:** rendering, publish preparation, memory promotion, or platform draft creation requiring approval.
4. **External side-effect automation:** publishing, campaign creation, account changes, messages, and activation. Requires explicit approval and platform-specific safeguards.

### 13.2 What Can Run Automatically

The following may run automatically if tenant-authorized and within configured limits:

- input validation;
- brand profile draft creation;
- weekly content draft generation;
- static post draft generation;
- safe image preview generation under policy limits;
- video script generation;
- publish payload preparation;
- first-party high-confidence factual memory auto-approval under configured policy;
- retry of internal non-side-effect stages.

### 13.3 What Requires Approval

The following require explicit approval:

- publishing to external social platforms;
- activating or modifying paid campaigns;
- video rendering when cost, likeness, brand risk, or external visibility is involved;
- durable memory promotion for strategic, inferred, competitor, market, audience, or third-party claims;
- revision adoption when it changes approved strategy or brand constraints;
- integration disconnect/reconnect when it affects scheduled publishing;
- any workflow stage marked as approval-gated by tenant policy.

### 13.4 What Must Not Be Automated

Aries must not automatically:

- publish generated content without approval;
- activate paid ads by default;
- store unapproved raw research as memory;
- connect platforms without user consent;
- expose or copy credentials into generated prompts;
- let AI approve its own artifacts;
- convert provider output into canonical facts without validation and curation;
- reuse another tenant’s context.

### 13.5 Provider-Specific Concerns

Publishing providers may impose constraints such as:

- account permissions;
- page or business ownership;
- payment method requirements;
- platform policy checks;
- region-specific disclosures;
- campaign objective restrictions;
- media aspect ratios;
- rate limits;
- OAuth token expiry;
- review delays;
- draft versus active status controls.

Aries must validate known requirements before dispatch and surface unknown provider failures as repairable or failed states.

### 13.6 Meta and Paid Ads Safety Posture

When creating paid advertising entities, Aries should default to paused or draft status. The system must perform a holistic pre-publish review that checks copy, creative, landing pages, CTA, targeting, budget, compliance fields, and technical asset requirements before any external creation. Active launch should require explicit approval beyond draft creation unless tenant policy explicitly allows otherwise.

---

## 14. Non-Functional Requirements

### 14.1 Scalability

Aries should scale by offloading long-running work to Hermes and keeping browser-facing APIs responsive.

Requirements:

- route handlers should avoid long blocking execution;
- long-running workflows should be callback-driven;
- Postgres connection pools must be sized for deployment concurrency;
- runtime artifacts should be stored outside ephemeral application bundle paths;
- UI should poll or subscribe to status instead of holding long requests open.

### 14.2 Resiliency

Aries must remain usable when providers fail partially.

Requirements:

- text planning should continue when media generation is unavailable when possible;
- failed provider executions should produce clear job states;
- retryable failures should be identifiable;
- late callbacks should not corrupt terminal jobs;
- partial outputs should be preserved and labeled;
- publish failures should be repairable where possible.

### 14.3 Observability

Aries must provide enough runtime visibility for operators to debug workflows.

Requirements:

- health checks for database and critical services;
- run records and job status;
- callback audit entries;
- provider submission records;
- approval logs;
- publish dispatch logs;
- error categories;
- environment validation outputs;
- testable workflow contracts.

### 14.4 Performance

Performance goals:

- browser-facing APIs should return quickly for accepted jobs;
- long-running work should be asynchronous;
- status and dashboard pages should use projected read models;
- memory retrieval should be bounded;
- artifacts should be previewed through safe lightweight representations when possible;
- publishing preparation should validate before dispatch to avoid avoidable provider round trips.

### 14.5 Fault Tolerance

Aries must handle:

- provider timeouts;
- duplicate callbacks;
- failed callbacks;
- partially generated outputs;
- expired OAuth tokens;
- missing integrations;
- schema-violating model output;
- prompt injection attempts;
- database connectivity issues;
- stale UI state;
- retry collisions.

### 14.6 Portability

Aries should support deployment with:

- external Postgres;
- containerized application runtime;
- configurable data root;
- Hermes endpoint and key configuration;
- optional Honcho memory configuration;
- provider abstraction for models and publishing.

No active product workflow should require a developer’s local filesystem layout or a legacy workflow file path unless explicitly operating in legacy mode.

### 14.7 Provider Independence

Provider independence requires:

- no hard-coded vendor names in product behavior;
- no provider secrets in browser payloads;
- abstract media and execution requests;
- normalized callback and error handling;
- compatibility with multiple execution adapters;
- tests that forbid legacy provider leakage in active workflows.

### 14.8 Data Integrity

Requirements:

- schema validation before write;
- idempotency keys for side-effectful execution;
- immutable audit trail for approvals and memory supersession;
- explicit status transitions;
- tenant-scoped artifact paths;
- safe error representation;
- no raw provider envelopes in UI read models unless normalized.

---

## 15. Operational Constraints

### 15.1 Infrastructure Assumptions

Aries assumes:

- Next.js application runtime;
- Postgres as canonical database;
- configured runtime data root for generated files;
- Hermes endpoint and API key for default long-running execution;
- internal callback secret for provider-to-Aries callbacks;
- optional Honcho configuration for memory;
- platform OAuth credentials for publishing integrations;
- production deployment with externalized secrets.

### 15.2 Deployment Assumptions

Production deployment should:

- build application code into the container image;
- use `/data` or equivalent for runtime artifacts;
- configure Postgres host, database, user, and password;
- configure Hermes URL and outbound server key;
- configure internal callback secret;
- avoid repo bind mounts in production;
- validate DB health after deployment;
- keep legacy execution disabled unless deliberately selected.

### 15.3 Human Review Requirements

Operators must review:

- first onboarding results if profile confidence is uncertain;
- generated strategy before asset production where relevant;
- generated content before publishing;
- media render requests requiring approval;
- publish payloads before dispatch;
- memory candidates outside narrow first-party auto-approval policy;
- integration changes with account-level impact.

### 15.4 Operational Safeguards

Safeguards:

- feature gates for unfinished research/memory workflows;
- environment validation;
- route contract tests;
- provider abstraction tests;
- tenant isolation tests;
- publish approval tests;
- memory reject-list tests;
- callback authentication tests;
- idempotency tests;
- destructive operation approval gates.

### 15.5 Current Validation Debt

Known validation work that should remain visible until resolved:

- full auth and integration test suites need stable configuration;
- social content dashboard hydration and runtime projection tests should remain active;
- public surface contract tests should be aligned with current user-facing routes;
- environment-coupled tests should be isolated or clearly marked;
- Honcho memory integration requires production-hardening verification before live use — **still open** as of 2026-05-13; see §16.1;
- Hermes `aries-research` profile coordination remains a separate execution-provider task — **still open** as of 2026-05-13; see §16.2;
- stage-cache tenant prefix isolation gap (lobster stage caches lacked tenant path segment) — **addressed in PR #302** (`fix/stage-cache-tenant-prefix`); regression test still recommended (see `docs/audits/2026-05-12-prd-audit-critical-verification.md` Finding 1).

### 15.6 Protected Operational Areas

Certain systems are protected external or operational systems and should not be modified casually:

- production deployments;
- database schema changes;
- authentication and tenant membership logic;
- OAuth credentials and token storage;
- Hermes provider configuration;
- Honcho auth and network isolation;
- external platform publishing credentials;
- paid campaign activation.

High-risk changes should require explicit human approval and validation.

---

## 16. Open Questions and Risks

### 16.1 Honcho Production Hardening

Open questions:

- Which exact workspace-scoped JWT minting mechanism will Aries use in production?
- How will Aries rotate tenant memory credentials?
- What is the verified delete/archive behavior for Honcho workspaces?
- Which operational role can inspect or redact tenant memory?

Risk: without server-enforced Honcho auth or network isolation, tenant memory isolation depends too heavily on Aries wrapper conventions.

### 16.2 Hermes `aries-research` Profile

**Status (2026-05-25, Aries-side):** The marketing pipeline now targets three named Hermes profiles — `aries-research`, `aries-strategist`, and `aries-content-generator` — via the stage→profile map in `backend/marketing/ports/hermes.ts`. Each profile binds to its own gateway URL and API key (`HERMES_RESEARCH_GATEWAY_URL` / `HERMES_RESEARCH_API_SERVER_KEY`, etc.), so credentials and rate limits are partitioned per profile.

The remaining open questions are **Hermes-side** (server registration, tool allowlists, output schema enforcement) and tracked as a Hermes dependency, not an Aries gap. The §20 invariants the Aries side guards (no callback-supplied tenant id, callback authn/idempotency, capability ports) hold regardless of which profile Hermes routes to.

Open questions (Hermes-side, tracked as upstream dependencies):

- Is the tool allowlist for `aries-research` enforced server-side by Hermes?
- Is the output schema enforced provider-side, Aries-side, or both?
- Has the profile been audited for any path to Aries tenant memory?

Risk: an overly broad Hermes profile could access tools or memory surfaces not intended for research jobs. Mitigation lives at the Aries→Hermes boundary: per-profile credentials, callback-token verification, and the `inv-14-callbacks-authn-schema-tenant-idemp` invariant test.

### 16.3 Route and Documentation Drift

Open question:

- Which route manifests are fully current for social-content versus legacy marketing routes?

Risk: older route contracts and marketing pipeline documents may preserve historical terminology. Active PRD and implementation should prefer current README/runtime/tests over deprecated compatibility docs.

**Known active gap (2026-05-13):** The codebase contains 150+ files using `campaign` in route paths (e.g., `/campaigns/`, `/dashboard/campaigns/`), API endpoints, database identifiers, and hook names. This PRD uses "posts," "social content," and "jobs" as the canonical product terms. The `campaign` terminology is a known cleanup backlog item (Audit Batch 1 — L effort, separate initiative). Contributors should treat `campaign`-labeled identifiers as legacy naming for the same concepts this PRD calls "social content jobs" or "posts" — they are not contradictory design intent. The rename has not been executed; do not infer from the route names that "campaign" is the product concept.

### 16.4 Legacy Execution Leakage

**Status (2026-05-25):** Codified by the §20 invariant suite (`tests/prd-invariants/inv-06-openclaw-lobster-compat-only.test.ts`). OpenClaw is fully dead at runtime — the suite asserts no `process.env.OPENCLAW_*` reads in `backend/` or `lib/`. Lobster is scoped to a small filesystem-naming allowlist:

- `backend/marketing/artifact-store.ts`, `artifact-collector.ts`, `publish-review.ts`, `jobs-status.ts` — `lobster-stageN-cache` directory names for pre-rename on-disk artifacts
- `backend/marketing/approval-store.ts` — defensive reads of legacy `lobster_resume_token*` fields from pre-rename approval JSON
- `backend/marketing/asset-ingest.ts` — `/host-lobster-output` host mount path

Adding `lobster` or `OPENCLAW_` anywhere outside this allowlist is now a test failure. The risk below has therefore moved from open-ended to bounded.

Risk (bounded): the filesystem-cache allowlist is naming, not behavior — runtime code paths flow through the Hermes execution port regardless of cache directory names. The compat names will age out as pre-rename artifacts roll off disk; until then, the invariant test fails loud if new leakage appears.

### 16.5 Publishing Activation Boundary

**Status (2026-05-26):** Scheduled publishing is live for Meta (Facebook + Instagram). The `scheduled_posts` table (schema in `scripts/init-db.js:455`) tracks `dispatch_status` (pending/in_flight/dispatched/failed) with per-platform child rows in `scheduled_post_dispatches`. The worker (`scripts/automations/scheduled-posts-worker.mjs`) drains due rows every 60 seconds and fires `publishToMetaGraph`. The tenant scheduling surface is `app/api/social-content/jobs/[jobId]/posts/[postId]/schedule/route.ts`; the internal dispatch surface is `app/api/internal/publishing/scheduled-dispatch/route.ts`.

Boundaries of what has shipped:
- **Meta (Facebook/Instagram):** scheduled and dispatched via `publishToMetaGraph`. Both draft (scheduled_for > NOW) and immediate (scheduled_for = NOW) states work.
- **LinkedIn and others:** not wired through scheduled-dispatch; platform-specific dispatch not yet built.
- **Retry (`app/api/publish/retry`):** requires session auth but does not require a separate re-approval gate. The approval-model-for-retry question below is unresolved.
- **Paid campaign activation:** no evidence of any paid campaign activation path in the codebase; this sub-question has not been scoped.

Open questions (still unresolved):

- What approval model is required for retry after partial provider failure?
- Can paid campaign activation ever be tenant-policy automated after prior approval?

Risk: platform-specific behavior may accidentally create externally visible content before user review.

### 16.6 Memory UI and Redaction

**Status (2026-05-26, redaction only):** The `ARIES_MEMORY_LABEL_REDACTION_V2` flag is live. `scrubPreferenceLabelForHoncho` in `backend/memory/write-events.ts:871` implements two modes — v1 (broad `[A-Z][a-z]+\s+[A-Z][a-z]+` regex, default) and v2 (narrow first-name denylist, preserves creative descriptors like "Bold Minimalist"). The flag is documented in CLAUDE.md and is off by default pending rollout evaluation.

`app/creative-memory/page.tsx` exists but is an internal developer tool for prompt-recipe inspection — it is not linked from the operator dashboard and is not a tenant-facing memory inspection surface.

Open questions (all sub-questions below remain unresolved; deferred to §17 "Memory inspection UI"):

- Should tenant admins have self-serve memory inspection?
- How are incorrect memories corrected by users?
- What retention policy applies to rejected candidates?
- How should memory redaction interact with audit requirements?

Risk: without inspection UI, memory quality and user trust depend on operational tooling.

### 16.7 Provider Cost and Quotas

**Deferred — reason:** No per-tenant quota tracking tables, cost-confirmation UI, or Aries-side quota modeling has been implemented. Rate-limit resilience is handled operationally by the CLAUDE.md resumability guardrail (preserve partial artifacts on non-fatal Hermes failure; do not discard work on rate-limit) rather than by Aries quota code. Provider quota failures propagate as Hermes stage errors and surface to the operator dashboard as stage failures. The design for per-tenant limits and cost-confirmation flows has not been scoped.

Open questions (still unresolved):

- What are per-tenant generation limits?
- Which media generation actions require cost confirmation?
- How are provider quota failures surfaced to tenants in a structured way?

Risk: media generation may incur unexpected costs or fail unpredictably if quotas are not modeled.

### 16.8 Content Policy and Platform Compliance

**Deferred — reason:** No Aries-side pre-publish policy enforcement has been implemented. The `pre_publish_review` and `pre_publish_ad` UI states in `backend/marketing/dashboard-content.ts` are human approval gates, not automated policy checks — an operator must click to approve before publish fires. Platform-side rejection (Meta Graph API errors on publish) is the only enforcement currently in place. Region-specific disclosure logic has not been designed. The split between provider-side and Aries-side policy checks has not been scoped.

Open questions (still unresolved):

- Which platform policies are enforced in Aries before publish?
- Which policy checks are provider-side only?
- How are region-specific disclosures handled?

Risk: generated content may be rejected by platforms or violate tenant compliance requirements if checks are incomplete.

---

## 17. Future Expansion Areas

Future expansion should preserve deterministic orchestration, approval gates, and tenant isolation.

Potential areas:

1. **Workflow registry:** admin-defined workflow catalog with explicit stage schemas and provider capabilities.
2. **Content calendar:** scheduling and calendar view for generated and approved content.
3. **Multi-platform publishing:** deeper support for Instagram, Facebook, LinkedIn, X, YouTube, TikTok, Reddit, and future channels.
4. **Performance feedback loop:** platform analytics ingestion, content performance summaries, and optimization recommendations.
5. **A/B testing:** controlled generation and approval of content variants.
6. **Policy packs:** tenant-configurable compliance, brand, and industry-specific review policies.
7. **Memory inspection UI:** tenant admin tools for memory review, supersession, redaction, and export.
8. **Research workflows:** bounded competitor, market, audience, and trend research using approved memory rules.
9. **Creative production workflows:** landing pages, ad images, scripts, and campaign kits as first-class product workflows.
10. **Provider marketplace:** replaceable model, media, publishing, and research providers behind stable capability ports.
11. **Team collaboration:** comments, reviewer assignment, approval routing, and audit-friendly handoffs.
12. **Open-source contributor framework:** workflow definitions, contracts, and extension points that contributors can understand and test.

---

## 18. Glossary

**AI Execution Provider** — A service that performs bounded AI tasks, such as Hermes.

**Approval** — A durable decision allowing a workflow, artifact, publish action, or memory promotion to proceed.

**Artifact** — A generated or uploaded output associated with a tenant and job.

**Callback** — An authenticated internal request from an execution provider back to Aries.

**Canonical State** — Aries-owned source-of-truth state, primarily in Postgres.

**Curation** — Validation and review process that decides whether candidate facts become durable memory.

**Derived Memory** — Approved context stored outside canonical state for retrieval and continuity.

**Execution** — Provider-level run or attempt associated with a job.

**Hermes** — The intended default AI execution layer for long-running Aries workflows.

**Honcho** — Memory store used for derived, tenant-scoped approved memory.

**Job** — A tenant-scoped instance of a workflow.

**Memory Candidate** — A potential memory item produced by onboarding, research, or user feedback before approval.

**Peer** — Honcho entity representing a memory subject, such as brand, policy, user, competitor, or audience segment.

**Provider Abstraction** — Architecture pattern where Aries requests capabilities instead of hard-coding specific vendors.

**Publish Dispatch** — External side-effect operation that sends approved content to a platform.

**Resume** — Continuing a workflow from a waiting, approval, callback, or retry state.

**Run** — Execution-provider instance. A job may have one or more runs.

**Stage** — Named workflow phase with inputs, outputs, and transitions.

**Tenant** — Primary isolation boundary for users, workflows, data, artifacts, memory, and integrations.

**Tenant Pseudonym** — HMAC-derived identifier used to avoid exposing real tenant IDs to execution or memory systems.

**Workflow** — Deterministic multi-stage product process with typed inputs, outputs, approvals, and transitions.

---

## 19. Deprecated and Historical Concepts

### 19.1 Legacy OpenClaw / Lobster Execution

OpenClaw/Lobster workflows are historical or compatibility execution paths. They may remain useful for older marketing pipeline references or explicit fallback behavior, but they are not the current default execution architecture for active social-content workflows.

Current rule: Hermes-native execution is the intended default. Legacy `.lobster` workflow file paths, OpenClaw gateway assumptions, and placeholder wrapper scripts must not be treated as canonical active product behavior unless a workflow explicitly opts into legacy compatibility.

### 19.2 Legacy Brand Campaign / Meta Ads Pipeline

The older marketing skills pipeline defined a useful conceptual sequence:

```text
Research → Strategy → Production → Publish & Optimize
```

It also established durable product ideas such as competitor research, brand analysis, campaign planning, creative review, and paused publish review. These concepts remain relevant as product patterns, but the old command/skill structure should not be treated as the current application architecture.

Current rule: convert useful historical behavior into deterministic Aries workflows with Hermes execution, typed APIs, tenant isolation, and approval gates.

### 19.3 Direct Model Vendor Coupling

Older documents may refer directly to Gemini, Nano Banana Pro, or other concrete model providers for image generation or video analysis. These references are implementation examples, not canonical product architecture.

Current rule: Aries product workflows must use provider abstraction. Vendor-specific details belong inside provider adapters or Hermes profiles.

### 19.4 Synchronous Long-Running Polling

Older enrichment paths may use short synchronous polling. This is acceptable only for short, bounded operations or tests. Multi-minute workflows should be callback-based.

Current rule: long-running jobs use fire-and-forget submission with authenticated callbacks.

### 19.5 "Campaign" Terminology in Routes and Database Identifiers

The codebase retains `campaign` in route paths, database table names, API endpoints, React hooks, and component names throughout — a legacy of the older brand-campaign / Meta Ads pipeline described in §19.2. This PRD uses "social content," "posts," and "jobs" as the canonical terms for the same concepts. The discrepancy is a known cleanup backlog item (Audit Batch 1, estimated L effort), not an architectural contradiction. Contributors reading route names like `/campaigns/` or hook names like `use-runtime-campaigns` should map them mentally to "social content jobs" as described in §3, §5, and §9. The rename has not been executed as of 2026-05-13; a separate initiative is required. See §16.3 for the open-questions framing.

---

## 20. Canonical Behavioral Invariants

1. Aries owns tenant boundaries, canonical state, approvals, audit, and workflow policy.
2. Hermes executes bounded tasks and returns structured results; Hermes does not own Aries product state.
3. Honcho stores only approved durable memory; it does not replace Postgres.
4. Tenant IDs are derived server-side; clients and callbacks do not decide tenant access.
5. Active social-content workflows are Hermes-native by default.
6. Legacy OpenClaw/Lobster behavior is compatibility-only unless explicitly selected.
7. Publishing requires approval.
8. Video render requests require approval.
9. AI-generated content is draft content until approved.
10. Memory is curated, append-only, provenance-bearing, and supersedable.
11. Unapproved, speculative, malformed, secret-bearing, or cross-tenant data must never enter durable memory.
12. Provider credentials must never appear in browser payloads, memory, logs, or AI prompts.
13. Workflow transitions must be explicit, auditable, and resumable where designed.
14. Provider callbacks must be authenticated, schema-validated, tenant-mapped through Aries state, and idempotent.
15. Product behavior must depend on capability ports and contracts, not hard-coded AI vendor assumptions.

