---
name: n8n-local-runtime
description: Generate, validate, publish, and repair n8n workflows for a local macOS n8n test instance at http://localhost:5678 using only approved node types (webhook, set, if, executeCommand, httpRequest, respondToWebhook). Use when creating or updating workflow JSON, importing/publishing via API, reading n8n import/activation errors, and applying bounded section-only retries without redesigning validated generator/validator artifacts.
---

# n8n Local Runtime (macOS local test instance)

Use this skill to produce and publish n8n workflows that are compatible with the local npm-installed n8n instance.

## Fixed Runtime Contract

- Base URL: `http://localhost:5678`
- Environment: local macOS test instance
- Project root: `PROJECT_ROOT=$HOME/.openclaw/workspace/aries-platform-bootstrap`
- Allowed node types only:
  - `n8n-nodes-base.webhook`
  - `n8n-nodes-base.set`
  - `n8n-nodes-base.if`
  - `n8n-nodes-base.executeCommand`
  - `n8n-nodes-base.httpRequest`
  - `n8n-nodes-base.respondToWebhook`
- Never redesign validated generator/validator artifacts. Patch only failing sections.
- Maximum repair attempts after first failure: **3**.

## Required Workflow Shape

Always model generated JSON on real exports from this instance before first publish in a task:

1. Export or fetch one known-good workflow from local n8n.
2. Reuse the same top-level shape and key conventions for generated workflows.
3. Keep compatibility fields that the instance includes (for example ids/version/active/settings/staticData/meta/tags when present).
4. Only modify needed sections for the requested behavior.

If uncertain about a field, prefer copying the instance’s observed structure over inventing schema.

## Generate Compatible Workflow JSON

1. Build a workflow object with:
   - `name`
   - `nodes` (allowed node types only)
   - `connections`
   - other compatibility fields seen in local exports
2. Validate every node type against the allowlist.
3. Validate references in `connections` map to existing node names.
4. Keep command execution paths anchored to `$PROJECT_ROOT` when using `executeCommand`.

## Publish / Import via n8n API

Use the n8n REST API at `http://localhost:5678/rest`.

Common sequence:

1. Create/import workflow (POST `/workflows` or local equivalent endpoint in your installed version).
2. Capture HTTP status + response body.
3. If create succeeds, activate (PATCH/POST workflow active flag, depending on version).
4. Capture activation HTTP status + response body.

Treat import/create and activation as separate checkpoints. Persist both error payloads if either fails.

## Error Handling and Bounded Repair

When import or activation fails:

1. Parse error payload and identify failing section (for example a node parameter, connection edge, activation flag, credentials ref, expression).
2. Patch only the failing section.
3. Retry publish/activation.
4. Stop after 3 repair attempts.

Do not perform broad rewrites. Do not replace validated generator/validator artifacts.

### Section-Only Patch Policy

Allowed patch scopes:
- Single node payload (`nodes[i].parameters`, `nodes[i].typeVersion`, etc.)
- Single connection branch in `connections`
- Single workflow flag required for activation/import compatibility

Disallowed patch scopes:
- Full workflow redesign
- Node-type substitution outside allowlist
- Regenerating unrelated validated sections

## Minimal Operational Checklist

Before publish:
- Node types are allowlisted.
- JSON shape mirrors local export conventions.
- `executeCommand` usage stays under `$PROJECT_ROOT`.

After publish attempt:
- Record import/create result (status + body).
- Record activation result (status + body).

On failure:
- Apply targeted patch.
- Retry with incremented repair counter.
- Abort after attempt 3 with a concise failure summary including last error payload.
