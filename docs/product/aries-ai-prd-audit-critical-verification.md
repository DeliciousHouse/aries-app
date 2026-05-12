# Critical Findings Verification — 2026-05-12

Read-only verification of three `(?)` critical findings against the actual
source at `/home/node/docker-stack/aries-app`. No files were modified.

Note: the referenced source doc `docs/product/aries-ai-prd-audit.md` does not
exist in this repo; verdicts below are based solely on the claims supplied in
the verification request and a direct read of the implementation.

## Finding 1: Tenant isolation in artifact storage

**Verdict:** PARTIALLY CONFIRMED

**Evidence:**

Lobster stage cache layout has no tenant segment.
`backend/marketing/artifact-store.ts:13-18` defines the cache roots as
`/tmp/lobster-stage{1..4}-cache` (or the matching env override). The runId
folder is the only segment under that root:

- `backend/marketing/stage-artifact-resolution.ts:199`
  `path.join(stageCacheRoot(stage), runId, '${stepName}.json')`
- `backend/marketing/publish-review.ts:129`
  `path.join(cacheRoot('LOBSTER_STAGE4_CACHE_DIR', 'lobster-stage4-cache'), runId, '${stepName}.json')`

`tenant_id` / `tenantSlug` appear nowhere in the path segments for stage
caches. The path is `<cacheRoot>/<runId>/<step>.json`.

The tenant boundary helper enforces tenant only inside one subtree —
`DATA_ROOT/ingested-assets/<tenantId>/...`:
`backend/marketing/asset-read.ts:13-30` (`tenantPrefixViolates`) checks the
first relative segment under `ingested-assets` and short-circuits to "no
violation" for anything outside that subtree, including the lobster stage
caches and DATA_ROOT/CODE_ROOT in general.

The runId inference fallback uses the competitor URL slug, not tenant:
`backend/marketing/stage-artifact-resolution.ts:71-92`
`competitorRunIdPrefixes` derives prefixes from `inputs.competitor_url`
only. If two tenants both run against `nike.com`, their cache run ids
share the prefix `nike-com-campaign-*`. When `runtimeDoc.stages[stage].run_id`
is empty the inference at lines 127-150 can match a sibling tenant's runId by
prefix + mtime closeness and return it.

The asset read entry point omits the tenant arg in the route handler:
`app/api/marketing/jobs/[jobId]/assets/[assetId]/handler.ts:258`
calls `readMarketingAssetWithinAllowedRoots(asset.filePath)` without
`{ tenantId }`, so `tenantPrefixViolates` is fully skipped (line 17 returns
`false` when `tenantId === undefined`). The handler does enforce tenant on
the runtimeDoc at line 242, so the asset path is server-derived from a
tenant-bound document — the in-band check still misses the post-resolution
boundary, which is the layered defense the PRD asks for.

**Impact:** A determined cross-tenant read is not trivially exploitable
because (a) the assetId path is resolved against `findMarketingAsset(jobId,
runtimeDoc, ...)` where `runtimeDoc` is tenant-checked, and (b) the
`assertRuntimeDocTenantMatches` guard fires in `asset-library.ts`. But the
defense-in-depth `tenantPrefixViolates` post-check is shaped to fire only
for `ingested-assets/<tenantId>/...` paths and silently no-ops for the
larger stage-cache surface. If two tenants drive the pipeline against the
same competitor URL, the runId inference fallback can collide and surface
another tenant's stage artifacts inside `findMarketingAsset` — there is no
final boundary check to catch it.

**Urgency:** Fix-this-sprint

**Recommended action:** Add a tenant segment under each stage cache root
(`<cacheRoot>/<tenantId>/<runId>/<step>.json`), reject any inferred runId
whose path is not under the calling tenant's segment, and pass `tenantId`
into every `readMarketingAssetWithinAllowedRoots` call so the boundary check
runs even for non-`ingested-assets` paths.

## Finding 2: Material-edit approval bypass

**Verdict:** DISMISSED

**Evidence:**

The approval-aware review state machine re-flips an approved item back to
`in_review` whenever its content hash changes:

- `backend/marketing/runtime-views.ts:1126`
  `const sourceHash = reviewItemSourceHash(item);`
- `backend/marketing/runtime-views.ts:1147-1153`
  ```
  } else if (existing.sourceHash !== sourceHash) {
    state.items[item.id] = {
      sourceHash,
      status: existing.status === 'approved' ? 'in_review' : existing.status,
      lastDecision: existing.lastDecision,
    };
  ```
- `backend/marketing/runtime-views.ts:472-485`
  `reviewItemSourceHash` hashes `title`, `summary`, `scheduledFor`,
  `sections`, `attachments`, `previewUrl`, `fullPreviewUrl`,
  `destinationUrl`, `currentVersion` — i.e. all material content fields.

The two mutation entry points both flow through this state machine:

- Regenerate creates a brand new run rather than mutating in place:
  `backend/marketing/regenerate-creative.ts:61-79` submits a new
  `RegenerateCreativeContext` run, which produces a new asset id and
  re-enters review through the standard pipeline.
- Upload-replace inserts a fresh `creative_assets` row and orphans the
  previous one rather than overwriting:
  `backend/marketing/upload-replace.ts:184-204, 465-475`. The replaced row
  carries a new id, the post's `attachments` list changes, the sourceHash
  recomputes, and the review item flips back to `in_review`.

`backend/marketing/upload-replace.ts:20` documents the contract: "The
override never auto-publishes — the post still has to be approved before it
ships."

**Impact:** Edits to creative content cannot ship without re-review. The
material-edit-bypass scenario described by the audit does not exist —
edits route through new rows or new runs, both of which mutate the content
hash and trip the `approved → in_review` flip at
`runtime-views.ts:1150`.

**Urgency:** Backlog

**Recommended action:** Add a regression test that uploads a replacement
creative on an already-`approved` post and asserts the review item flips
back to `in_review`, so a future refactor of `reviewItemSourceHash` cannot
silently break the re-review trigger.

## Finding 3: Hermes callback handler tenant derivation

**Verdict:** DISMISSED

**Evidence:**

The callback payload schema does not carry `tenant_id` at all.
`backend/execution/hermes-callbacks.ts:21-62` defines
`HermesRunCallbackPayload` with `event_id`, `aries_run_id`,
`hermes_run_id`, `status`, `stage`, `output`, `artifacts`, `approval`,
`error` — no tenant field. The parser at lines 192-218 only reads those
fields, so even a malicious payload claiming `tenant_id` would be ignored.

Tenant association is loaded from Aries' own DB via the `aries_run_id`:

- `backend/execution/hermes-callbacks.ts:278`
  `const run = loadExecutionRunRecord(payload.aries_run_id);`
- `backend/execution/run-store.ts:45` defines `tenant_id` on the stored run
  record; line 165 populates it at creation time only:
  `tenant_id: nonEmpty(input.tenantId)`.

The marketing branch reads tenant strictly from the stored runtime doc:

- `backend/marketing/hermes-callbacks.ts:219`
  `tenantId: doc.tenant_id` — where `doc` is the runtime document loaded
  by `loadMarketingJobRuntime` keyed off the run's job id, not the payload.

The route also enforces an HMAC callback token bound to `aries_run_id`
before any handler runs:
`app/api/internal/hermes/runs/route.ts:44-50` calls
`verifyCallbackToken(payload.aries_run_id, ...)`.

**Impact:** None observed. The handler cannot trust a payload tenant claim
because no such claim exists in the schema, and tenant comes exclusively
from the DB record keyed by `aries_run_id`, which is itself
HMAC-authenticated.

**Urgency:** Backlog

**Recommended action:** Leave a comment near
`hermes-callbacks.ts:278` noting that adding any tenant-bearing field to
the payload schema in the future would be a regression, so the next person
extending the schema doesn't quietly reintroduce the antipattern.

## Summary

- Confirmed: 0
- Dismissed: 2
- Partially confirmed: 1
- Net assessment: The only real exposure is Finding 1 — lobster stage
  caches have no tenant path segment and the `tenantPrefixViolates`
  defense-in-depth check only covers `DATA_ROOT/ingested-assets`. Combine
  that with a runId-inference fallback keyed off competitor URL slug, and
  two tenants targeting the same competitor could collide. Findings 2 and
  3 are clean by construction (content-hash re-review trigger and
  DB-derived tenant, respectively). Plan the stage-cache tenant-prefix
  refactor for this sprint and add a regression test for the
  `approved → in_review` flip while you're in there.
