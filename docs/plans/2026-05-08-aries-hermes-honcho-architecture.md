# Aries × Hermes × Honcho architecture

## Context

You have three systems running on this host:

- Aries — multi-tenant Next.js app. Owns product workflow, tenant boundaries, Postgres canonical state, approvals, audit log, and tenant lifecycle.
- Hermes — agent execution layer. Runs bounded AI tasks. Already uses local Honcho as its own memory backend in workspace "hermes".
- Honcho — local memory store. v3 API at http://localhost:8000. Aries reaches it via http://host.docker.internal:8000. Honcho uses a workspace/peer/session/message model. Auth is currently disabled in local/dev, so every request is effectively admin.

## Goals

- Give Aries a tenant-scoped derived memory store on the same Honcho instance.
- Add a bounded Hermes profile/agent named aries-research for research tasks.
- Keep Aries as the source of truth for tenant state, approvals, lifecycle, and canonical records.
- Keep Hermes as a bounded execution layer only.
- Keep Hermes sessions as execution traces only, not Aries product state.
- Make tenant memory isolation as strong as the runtime allows, while being explicit about what is server-enforced versus convention-enforced.
- Prevent cross-tenant memory contamination.
- Keep unapproved, speculative, malformed, raw, or sensitive material out of Honcho.

This plan is architectural. It defines responsibilities, memory boundaries, naming, curation policy, workflow, and verification. It is not a codebase rewrite plan.

## Honest threat model

Tenant isolation depends on which controls are active.

### Control 1: Pseudonymized workspace IDs

What it does:
- Prevents real tenant identifiers from appearing in Honcho logs, Hermes payloads, research envelopes, and memory object IDs.
- Provides identifier hygiene.

What it does not do:
- It is not access control.
- It does not stop a misrouted request from reading another tenant's workspace.

Enforced by:
- Aries-side ID derivation.

### Control 2: Aries Honcho client wrapper

What it does:
- Accepts TenantContext, not arbitrary workspace IDs.
- Computes the Honcho workspace ID internally.
- Refuses to issue requests outside the aries-tenant-* namespace.
- Prevents accidental cross-tenant calls from normal Aries code paths.

What it does not do:
- It does not protect against a fully compromised Aries process.
- It does not protect against a separate process with Honcho admin credentials.

Enforced by:
- Aries application code.

### Control 3: Network isolation

What it does:
- Limits which processes can reach the Honcho API.
- Reduces exposure while auth is disabled.
- Should prevent arbitrary external services from reaching Honcho.

What it does not do:
- It does not enforce per-tenant workspace boundaries by itself.
- It does not protect against any process that can legitimately reach Honcho with broad credentials.

Enforced by:
- Host/container/network configuration.

### Control 4: Honcho workspace-scoped JWTs with AUTH_USE_AUTH=true

What it does:
- Honcho itself rejects requests whose JWT scope does not match the target workspace.
- Enforces workspace boundaries at the HTTP layer.
- Protects against misrouted calls, compromised Hermes credentials, non-Aries processes, and accidental cross-workspace access.

What it does not do:
- It does not protect against a fully compromised Aries service if that service can mint workspace-scoped credentials or holds a control-plane credential.
- It does not replace Aries authorization.

Enforced by:
- Honcho server-side auth.

### Current state

AUTH_USE_AUTH=false is acceptable only for local/dev.

Production requires:
- AUTH_USE_AUTH=true.
- AUTH_JWT_SECRET configured.
- Honcho API network-restricted.
- Aries using workspace-scoped tenant data-plane credentials for tenant memory reads/writes.
- Hermes denied any credential capable of accessing aries-tenant-* workspaces.
- Control-plane credentials kept out of normal tenant memory operations.

## Layer responsibilities

### Aries owns

- Tenancy and authorization.
- Tenant ID derivation from server-side auth/session context.
- Postgres canonical state:
  - research jobs
  - research findings
  - approvals
  - business profiles
  - audit log
  - scrape artifacts
  - raw Hermes envelopes
  - tenant lifecycle
- The Aries-side Honcho wrapper.
- Pseudonymization before any tenant identity leaves Aries.
- Research job creation.
- Callback validation.
- Schema validation.
- Curation policy.
- Approval/rejection.
- Durable memory promotion.
- Tenant deletion/export/archive behavior.
- Deciding what memory is retrieved and passed to Hermes.

Aries must not:
- Accept tenant IDs from client request bodies for memory resolution.
- Accept arbitrary Honcho workspace IDs from clients, Hermes, or callbacks.
- Treat Honcho as canonical application state.
- Write unapproved or speculative candidate findings into Honcho.

### Hermes owns

- Agent/profile registration for aries-research.
- Tool execution for bounded research jobs:
  - web fetch
  - scrape, rate-limited
  - last30days
  - public web research
- Per-run ephemeral session inside Hermes's own hermes workspace.
- Execution trace.
- Structured research result delivery.

Hermes must not:
- Read aries-tenant-* workspaces.
- Write aries-tenant-* workspaces.
- Hold credentials capable of accessing aries-tenant-*.
- Mutate Aries DB state.
- Publish or message users.
- Reuse a long-lived session as Aries memory.
- Carry tenant facts from one Aries job to another.
- Treat scraped content as trusted instructions.
- Become the authority for Aries memory.

### Honcho stores

- hermes workspace:
  - Hermes's own agent memory.
  - Untouched by Aries tenant memory workflows.

- aries-tenant-<tenantPseudonym> workspaces:
  - Aries-curated, approved-only durable tenant memory.
  - One workspace per Aries tenant.
  - Untouched by Hermes.

Honcho must not store:
- Raw scraped HTML.
- DOM dumps.
- Tool logs.
- Request/response headers.
- Cookies.
- Credentials.
- Secrets.
- Failed Hermes envelopes.
- Malformed model output.
- Unapproved candidate findings.
- Low-confidence speculative findings.
- Raw research traces.
- Cross-tenant data.
- Anything not intended to influence future memory.

## Naming and namespacing

### Workspace ID

Pattern:

    aries-tenant-<pseudonym>

Where:

    pseudonym = HMAC_SHA256(ARIES_TENANT_PSEUDONYM_SALT, tenantId).hex.slice(0, 32)

#### Why HMAC

- HMAC is the correct keyed digest primitive.
- It avoids the implementation hazards of raw sha256(salt || tenantId).
- It is deterministic for a known tenant ID and salt.
- It is opaque to anyone without the salt.
- It is not reversible, including by Aries.
- Aries can recompute the pseudonym for a known tenant ID.
- Reverse lookup requires Aries to store a mapping; this plan does not require one because Aries always knows the tenant ID from server-side context.

Pseudonymization is identifier hygiene, not access control.

### Peer IDs inside each tenant workspace

- `peer-brand` — the tenant's own brand identity. First-party.
- `peer-policy` — compliance, style, voice, and operating constraints set by tenant users. First-party.
- `peer-user-<userPseudonym>` — an Aries user for preference tracking. First-party.
- `peer-approver-<userPseudonym>` — approval attribution and curation audit. First-party.
- `peer-competitor-<competitorPseudonym>` — a tracked competitor. Third-party.
- `peer-audience-<segmentId>` — an audience segment profile. Mixed; often inferred.
- `peer-market-signal-<topicPseudonym>` — market trend signals. Third-party.

The first-party versus third-party distinction is part of the curation policy.

### Session IDs inside each tenant workspace

Honcho sessions in aries-tenant-* workspaces exist only to group approved curated memory.

Patterns:

- `session-curated-<jobId>` — approved facts from one research job's curation cycle. Created after curation, not before.
- `session-onboarding-<runId>` — approved facts from one onboarding run.
- `session-strategy-<jobId>` — approved facts from one strategy run.

There is no Honcho tenant-memory session that mirrors an in-flight Hermes research job.

The Hermes-side execution trace lives in Hermes's own hermes workspace as:

    aries-research-<jobId>

That Hermes session is for execution trace only and is not reused.

### Approved message body schema

Every durable Honcho message written by Aries should be a structured approved memory entry:

```json
{
  "kind": "fact | preference | constraint | rejected_angle | research_conclusion",
  "claim": "...",
  "sources": [
    {
      "url": "...",
      "fetched_at": "iso8601",
      "trust": "first_party | third_party"
    }
  ],
  "confidence": 0.0,
  "approved_by": "userPseudonym | system",
  "approved_at": "iso8601",
  "supersedes": "previous_message_id | null",
  "research_job_id": "..."
}
```

Rules:

- Append-only.
- Updates create new messages.
- Updates reference prior messages through `supersedes`.
- Superseded messages remain auditable.
- Superseded messages are not injected into future research context.
- Retrieval for active research context uses only current, approved, non-superseded memory.

Important caveat:

`supersedes` is Aries application metadata. Honcho's derived representations may have been influenced by older messages unless this behavior is tested. Therefore Aries must not blindly use Honcho synthesized chat/context as the authoritative current memory projection.

## Credential model

Production credentials must be split.

### Control-plane credential

Name: `HONCHO_CONTROL_PLANE_JWT`

Purpose:
- Workspace creation.
- Workspace deletion/archive.
- Tenant-scoped credential minting.
- Tenant lifecycle operations only.

Rules:
- Never used for routine tenant memory reads/writes.
- Not exposed to Hermes.
- Not exposed to client-side code.
- Not used inside normal research job execution.
- Stored only in server-side secret storage.
- All use must be logged and auditable.

### Data-plane tenant credential

Purpose:
- Routine memory reads/writes for one aries-tenant-* workspace.

Rules:
- Workspace-scoped.
- Short-lived or cached with strict tenant binding.
- Derived from server-side TenantContext.
- Cannot access any other workspace.
- Used for normal tenant memory operations.
- Never accepted from clients.
- Never supplied by Hermes.
- Never used for another tenant.

### Hermes credential

Rules:
- Hermes may use its own Honcho credential only for the hermes workspace.
- Hermes must not receive any credential capable of accessing aries-tenant-*.
- With auth disabled, the aries-research profile must have no Honcho client/tool surface.
- With auth enabled, Hermes's Honcho JWT must be scoped to hermes only.

### Correct compromised-service claim

Workspace-scoped JWTs enforce workspace boundaries at Honcho's HTTP layer. They protect against misrouted calls, compromised Hermes credentials, non-Aries processes, and accidental cross-workspace access.

They do not protect against a fully compromised Aries service if that service can mint tenant-scoped credentials or holds a control-plane credential.

Hardening against a fully compromised Aries runtime requires additional controls such as:

- no long-lived control-plane token in the main Aries runtime
- separate key-broker service
- short-TTL workspace tokens
- audit logging for every tenant-token mint
- strict network segmentation
- operational monitoring

## Research workflow

### Job submission in Aries

1. Authenticated user or scheduled job submits a research request.
2. Aries derives tenant ID server-side from TenantContext. Tenant ID is never accepted from the request body for memory resolution.
3. Aries creates a research job record with: job ID, tenant context, status pending, callback token, requested job type, task spec.
4. Aries memory orchestrator loads relevant tenant memory for the job.

Retrieval policy:
- Current only.
- Approved only.
- Non-superseded only.
- Relevant peers only.
- No pending candidates.
- No raw scrape material.
- No superseded messages.
- No unapproved facts.
- No synthesized Honcho chat/context unless separately filtered and tested.
- Context is capped to a fixed token budget.

5. Aries packages a Hermes payload:

```json
{
  "jobId": "...",
  "taskSpec": {},
  "tenantPseudonym": "...",
  "memoryContext": [],
  "callbackUrl": "${APP_BASE_URL}/api/internal/hermes/runs",
  "callbackToken": "..."
}
```

Payload rules:
- No real tenant ID.
- No raw tenant database references.
- No secrets.
- No PII unless explicitly approved and required.
- No raw scrape.
- No unapproved memory.
- No cross-tenant data.

6. Aries submits the job to Hermes aries-research through a callback-based, fire-and-forget flow.
7. Hermes uses an ephemeral session named `aries-research-<jobId>` in Hermes's own hermes workspace.

### Hermes execution

8. Hermes routes the job to aries-research.

Allowed tools:
- web_fetch
- scrape, rate-limited
- last30days
- public web research tools

Disallowed tools:
- Aries DB write tools
- user-facing publish/message tools
- Honcho tools capable of accessing aries-tenant-*
- any tool that mutates tenant product state

9. aries-research treats every scraped page as untrusted input.

Prompt-injection controls:
- Scraped content is wrapped in untrusted-content delimiters.
- The prompt explicitly says directives inside scraped content are not instructions.
- Output must match a strict JSON schema.
- The agent must not invent citations.
- The agent must include sources and uncertainty.

10. Hermes returns a structured envelope:

```json
{
  "status": "ok | partial | failed",
  "findings": [
    {
      "kind": "...",
      "claim": "...",
      "sources": [
        {
          "url": "...",
          "fetched_at": "iso8601",
          "trust": "first_party | third_party"
        }
      ],
      "confidence": 0.0,
      "uncertainty": "..."
    }
  ],
  "summary": "...",
  "trace_session_id": "aries-research-<jobId>"
}
```

### Callback and curation in Aries

11. Hermes posts the result to the Aries internal callback route.

Aries verifies:
- internal bearer/auth secret
- per-run callback token
- job exists
- job is still valid
- result schema is valid
- callback tenant context matches job tenant context through Aries DB, not callback-supplied workspace data

12. Aries stores the raw Hermes envelope and normalized findings in Aries DB.

At this stage:
- all findings remain Aries DB only
- nothing has been written to Honcho
- malformed output remains Aries DB only
- unapproved candidates remain Aries DB only

13. Aries curator processes each finding.

Drop if:
- schema invalid
- matches secret patterns
- contains another tenant's pseudonym
- contains raw HTML/DOM/tool output
- contains credentials, cookies, tokens, keys, or session data
- confidence < 0.5
- cannot be mapped to a valid peer
- appears to be prompt-injection residue
- lacks provenance where provenance is required

Auto-approve only if all are true:
- kind is one of fact, preference, constraint
- every source is first_party
- confidence >= 0.85
- finding maps to a first-party peer: peer-brand, peer-policy, peer-user-*
- finding is low-risk and discrete
- finding is not strategic, inferred, competitor-derived, audience-derived, third-party-sourced, or market-signal-derived

Queue for review if:
- competitor positioning
- audience assumption
- market signal
- content recommendation
- strategic recommendation
- inferred brand strategy
- third-party-sourced conclusion
- scraped third-party conclusion
- anything high-impact
- anything uncertain but potentially useful
- first-party fact below auto-approval threshold

14. Approved findings are written to Honcho.

Rules:
- Create `session-curated-<jobId>` only after curation succeeds.
- Write one approved message per durable finding.
- Attach message to the correct peer.
- Preserve source URLs, trust level, confidence, approval metadata, and source job ID.
- Never write unapproved candidates.
- Never write raw scrape or raw model envelopes.

15. Job status flips to completed, partial, failed, or needs_review.

## Onboarding memory seed

During onboarding, Aries may use Gemini vision/web analysis or brand-kit enrichment to discover first-party brand facts and public social media links.

These outputs do not automatically enter Honcho.

Flow:

1. Aries stores raw Gemini/brand-kit enrichment output in Aries DB.
2. Aries extracts discrete candidate facts: official website URL, public social profile URLs, brand name, logo/visual identity observations, first-party contact/about/profile facts, public first-party profile claims.
3. Candidate facts pass the same reject-list and curation policy as research findings.
4. First-party, high-confidence, low-risk facts may auto-approve only if they satisfy the normal auto-approval gate.
5. Approved onboarding facts are written to:
   - workspace: `aries-tenant-<pseudonym>`
   - peer: `peer-brand` or `peer-policy`, depending on the fact
   - session: `session-onboarding-<runId>`
6. Inferred brand strategy, inferred tone, inferred positioning, competitor claims, visual interpretation, and unapproved facts stay in Aries DB until reviewed.
7. Gemini-scraped social links are candidate facts, not durable memory by default.

## Memory retrieval policy

Aries assembles memoryContext explicitly.

Allowed retrieval:
- current approved messages
- non-superseded messages
- relevant peers only
- bounded token budget
- explicit source metadata

Avoid:
- asking Honcho chat/context "what do we know?" and trusting the synthesized answer
- using derived Honcho profile/chat as the authoritative current tenant memory source
- injecting superseded facts
- injecting unapproved candidates
- injecting raw scrape summaries
- injecting old context without checking supersedes

If Honcho chat/context is exposed at all, it is audit-only.

The Aries wrapper should not expose normal chat for research context. Acceptable options:

- no chat method in v1
- `chatForAuditOnly`, restricted to ops/debug paths
- never used by aries-research payload assembly unless separately filtered and tested

## What never enters Honcho

Hard reject list:

- raw scraped HTML
- DOM dumps
- page text excerpts
- tool logs
- request bodies
- response bodies
- headers
- cookies
- credentials
- secrets
- bearer tokens
- AWS keys
- base64 PEMs
- session cookies
- Anthropic/OpenAI/Gemini key prefixes
- JWT-shaped strings
- Hermes envelope failures
- malformed model output
- schema-violating responses
- unapproved candidate findings
- low-confidence claims below threshold
- cross-tenant references
- findings referencing another tenant's pseudonym
- speculative claims
- narrative summaries without discrete provenance
- prompt-injection residue
- raw internal Aries IDs unless intentionally approved
- anything not intended to influence future memory

Reason:

Honcho may derive summaries, vectors, peer representations, and future context from written messages. Anything written to Honcho can become future recall. Therefore only curated durable memory belongs there.

## Why workspace-per-tenant

Use one Honcho workspace per Aries tenant.

Do not use one shared aries workspace with peer-per-tenant isolation.

Reasons:
- Workspace is the correct top-level isolation boundary.
- Search/chat/session surfaces inside one workspace can potentially cross peers.
- Workspace-scoped JWTs map cleanly to tenant-scoped access only if workspace equals tenant.
- Tenant deletion/archive is a workspace-level lifecycle operation.
- Workspace-per-tenant reduces the chance that one client bug leaks another tenant's memory.
- Operational model is simpler and matches Aries tenancy.

## Hermes-side coordination

Hermes profile: `aries-research`

Role:
- public web research
- website analysis
- competitor analysis
- brand/content strategy research
- recent-market research
- last30days research when useful

Tool allowlist:
- web_fetch
- scrape, rate-limited
- last30days

Tool denylist:
- Aries DB write tools
- user-channel publishing tools
- messaging tools
- Honcho tools capable of accessing aries-tenant-*
- mutation tools
- customer-facing queue tools

Session strategy:
- ephemeral Hermes session per job
- session name `aries-research-<jobId>`
- session lives only in Hermes's hermes workspace
- no reuse across jobs

Output:
- strict JSON envelope
- source URLs
- confidence
- uncertainty
- trace_session_id
- no invented citations

Hermes must not:
- write durable memory
- approve memory
- decide tenant isolation
- retrieve tenant memory directly from Honcho
- persist tenant facts across Aries jobs

## Network and environment wiring

Local/dev:
- Aries reaches Honcho at http://host.docker.internal:8000.
- Honcho auth may be disabled only in local/dev.
- Hermes aries-research profile must have no Honcho client/tool surface capable of touching aries-tenant-*.

Production:
- Honcho API binds to restricted network surface.
- AUTH_USE_AUTH=true.
- AUTH_JWT_SECRET configured.
- Aries uses control-plane credential only for lifecycle/key operations.
- Aries uses workspace-scoped tenant data-plane credentials for routine memory reads/writes.
- Hermes credential is scoped to hermes only.
- Hermes has no credential capable of accessing aries-tenant-*.

Environment variables:

- `HONCHO_BASE_URL`
- `HONCHO_CONTROL_PLANE_JWT`
- `ARIES_TENANT_PSEUDONYM_SALT`
- `ARIES_RESEARCH_ENABLED`
- `HERMES_RESEARCH_AGENT_NAME=aries-research`
- `HERMES_RESEARCH_CALLBACK_SECRET` or existing internal callback auth secret
- `HERMES_RESEARCH_WEBHOOK_URL` or existing Hermes run endpoint

Do not use `HONCHO_ADMIN_JWT` for routine tenant memory operations.

If a static admin/control-plane JWT exists, it must be:
- server-side only
- not available to Hermes
- not available to client code
- not used for normal reads/writes
- logged when used

## Aries-side surface

The plan implies the following Aries capabilities, regardless of exact file names:

- tenant pseudonymization utility
- tenant-locked Honcho wrapper
- tenant memory orchestrator
- research job lifecycle store
- Hermes aries-research dispatch path
- callback validation path
- curator
- approval integration
- tenant deletion/archive hook
- onboarding memory seed hook
- audit/logging around memory writes and credential use

The key rule:

No public method should accept an arbitrary Honcho workspace ID. All tenant memory operations must derive workspace from server-side TenantContext.

## Deletion/archive policy

Tenant deletion/archive must be verified, not assumed.

If Honcho supports workspace deletion:
- use workspace-level deletion/archive
- then verify raw and derived state is gone or inaccessible

If Honcho does not fully purge derived state:
- add explicit purge/archive steps
- block production use until verified

Deletion verification must account for Honcho derived memory surfaces.

After workspace deletion/archive, poll until all relevant surfaces return 404 or empty:

- workspace lookup
- peer enumeration
- session enumeration
- message enumeration
- search results
- peer chat/context/profile surfaces
- session summaries
- derived representations
- indexed content
- deriver-generated artifacts

## Verification

Each item below must pass before the design is considered live.

1. **Pseudonym determinism**
   - `pseudonymForTenant('t1')` returns the same string repeatedly.
   - `pseudonymForTenant('t1')` differs from `pseudonymForTenant('t2')`.
   - Changing `ARIES_TENANT_PSEUDONYM_SALT` changes the pseudonym.
   - Implementation uses HMAC-SHA256, not `sha256(salt || id)`.

2. **Workspace lock-in**
   - The Aries Honcho wrapper refuses to issue requests outside `aries-tenant-*`.
   - No call site accepts arbitrary workspace IDs.
   - Passing a raw workspace string instead of TenantContext is structurally impossible or rejected.

3. **Cross-tenant isolation with auth disabled**
   - Create tenant A and tenant B. Write memory for tenant A. Load research context for tenant B. Assert tenant A memory does not appear.
   - This proves Aries-side routing works in local/dev. It does not prove server-enforced isolation.

4. **Cross-tenant isolation with auth enabled**
   - Run the same test with `AUTH_USE_AUTH=true` and workspace-scoped tenant credentials. Honcho itself must reject cross-workspace access at the HTTP layer.

5. **Credential split**
   - Verify control-plane credential is not used for normal reads/writes.
   - Tenant data-plane credential is workspace-scoped.
   - Hermes cannot access aries-tenant-* with its credential.
   - Credential minting is logged.
   - No control-plane credential is available to Hermes or client-side code.

6. **Hermes payload sanitization**
   - Submit a job for a real tenant ID. Capture outbound Hermes payload. Assert it contains tenantPseudonym, not the real tenant ID. Assert memoryContext does not contain raw tenant identifiers or unapproved facts.

7. **Curator reject-list**
   - Use a malicious corpus containing raw HTML, secrets, cross-tenant pseudonyms, PII, prompt injection, third-party-source-only facts, low-confidence claims, malformed findings. All rejected findings must stay out of Honcho.

8. **Auto-approval gate**
   - Third-party competitor-positioning at confidence 0.95 → review.
   - First-party brand fact at 0.86 → auto-approve.
   - First-party brand fact at 0.84 → review.
   - Inferred audience finding at any confidence → review.
   - Strategic recommendation at any confidence → review.

9. **Memory retrieval**
   - Write a fact. Write a superseding update. Run research memory retrieval. Only the new fact appears. Run audit retrieval. Both facts appear.

10. **Honcho synthesized context is not authoritative**
    - Verify research memoryContext does not come from unfiltered Honcho chat/context.
    - Only current + approved + non-superseded records are injected.
    - Superseded facts do not reappear in aries-research payloads.

11. **Tenant deletion/archive**
    - Create a workspace with peers, sessions, messages, derived conclusions, search vectors or indexed content. Delete/archive the workspace. Poll raw and derived surfaces until each returns 404 or empty. If any derived surface survives, add a purge step and block production.

12. **Approval round-trip**
    - Sandbox research job with mocked Hermes callback containing first-party high-confidence fact, third-party high-confidence competitor claim, low-confidence claim, malformed finding. Verify only first-party approved fact reaches Honcho; third-party queues for review; low-confidence drops or queues; malformed stored only as raw failure/debug; only approved memory appears in future memoryContext.

13. **Onboarding seed**
    - Run onboarding enrichment with Gemini/brand-kit social link extraction. Raw output lands in Aries DB. Candidate links are curated. Approved first-party social links write to peer-brand under session-onboarding-<runId>. Inferred brand strategy stays out of Honcho unless reviewed. Unapproved social/profile claims do not enter memoryContext.

14. **Prompt-injection live test**
    - Point aries-research at a sandbox URL containing malicious instructions. Agent returns schema-valid output or fails safely. Curator drops injected/secrets-like content. No dirty finding reaches Honcho. Hermes trace remains only in hermes workspace.

15. **Hermes credential scope**
    - With auth disabled: aries-research has no Honcho tool/client surface.
    - With auth enabled: Hermes credential is scoped to hermes workspace only. Hermes cannot read or write aries-tenant-*.

## What this plan deliberately does not do

- Does not migrate existing Aries memory.
- Does not change Hermes global session strategy.
- Does not make Hermes the memory authority.
- Does not introduce a new approval system if existing approval infrastructure can be reused.
- Does not use Honcho as canonical Aries state.
- Does not ship production tenant memory with `AUTH_USE_AUTH=false`.
- Does not allow unapproved research findings into Honcho.
- Does not expose tenant-memory chat/context as normal research context.
- Does not require a tenant memory UI in v1, though ops inspection/redaction is a useful follow-up.

## Final invariant

Aries decides tenant.
Aries derives workspace.
Aries retrieves approved memory.
Aries sends bounded context to Hermes.
Hermes runs research.
Hermes returns candidates.
Aries validates.
Aries curates.
Aries approves or rejects.
Only approved durable memory enters Honcho.

Hermes never writes Aries tenant memory.
Honcho never replaces Aries canonical state.
Unapproved candidates never become memory.
