# Honcho writes — prod-secret TODO (operator-only) + V0–V14 harness map

**Status:** Open — blocks the Honcho continuous-profile-writes prod rollout.
**Companion plan:** `docs/plans/2026-05-30-honcho-writes-rollout.md`
**Source spec:** `docs/plans/2026-05-11-aries-honcho-continuous-profile-writes.md` (V0–V14).

This note records (a) the exact prod `.env` changes Brendan must make by hand —
**no secret values appear here and none must ever be committed** — and (b) the
V0–V14 fixture verification harness that is already in the test suite.

---

## 1. Prod `.env` changes the operator must make (human-only)

All three are operator-only because they are production secrets / live-tenant
config. They CANNOT be set by an agent: do not invent JWTs, do not write the
prod `.env`, do not flip prod env. This is a checklist for Brendan.

| Var | Current prod value | Required action |
|---|---|---|
| `HONCHO_DATA_PLANE_JWT` | **ABSENT** | Set to the Honcho **data-plane** JWT from the prod Honcho tenant. Used for all append/read (workspace messages). |
| `HONCHO_CONTROL_PLANE_JWT` | **ABSENT** | Set to the Honcho **control-plane** JWT. Used only for workspace create/delete; data-plane is the fallback per `backend/memory/honcho-http-transport.ts:35-40`. |
| `HONCHO_BASE_URL` | `http://host.docker.internal:8000` (dev loopback) | Replace with the **prod Honcho data-plane base URL** (e.g. `https://<prod-honcho-host>` — real host TBD from the Honcho prod tenant). |

Placeholder form to paste into prod `.env` (fill the right-hand side on the host,
never in git):

```dotenv
# --- Honcho prod data plane (operator fills these on the prod host only) ---
HONCHO_BASE_URL=https://REPLACE_WITH_PROD_HONCHO_DATA_PLANE_HOST
HONCHO_DATA_PLANE_JWT=REPLACE_WITH_DATA_PLANE_JWT
HONCHO_CONTROL_PLANE_JWT=REPLACE_WITH_CONTROL_PLANE_JWT
```

Already present in prod `.env` (do not change): `HONCHO_ENABLED=true`,
`HONCHO_WRITE_APPROVALS_ENABLED`, `HONCHO_WRITE_PUBLISH_ENABLED`,
`ARIES_TENANT_PSEUDONYM_SALT`.

### Why a missing JWT does NOT fail startup (and what catches it)

`validateHonchoConfig` (`backend/memory/honcho-env.ts:40`) only asserts
`HONCHO_BASE_URL` present + salt ≥16 chars when `HONCHO_ENABLED=true`. It does
**not** assert the JWTs — silent degradation is by design (plan D2). So a missing
JWT will not throw at boot; instead, against a JWT-gated Honcho, the write gets a
401/403 (`honcho_unauthorized`) inside the `setImmediate` callback, is caught +
logged, and the write silently no-ops. The proof the JWT + URL are correct is a
post-flip **prod read-back** (the `--prod` mode described below), not startup.

### After editing `.env`

Restart the `aries-app` container so the new env is read. Then run the prod
read-back smoke (V1) once to confirm a message actually lands in the prod Honcho
workspace.

---

## 2. V0–V14 verification harness (fixture-primary; in the test suite)

File: `tests/verify-honcho-writes.test.ts`

Run:

```bash
APP_BASE_URL=https://aries.example.com \
  ./node_modules/.bin/tsx --test tests/verify-honcho-writes.test.ts
```

It is **fixture-primary**: `pool.query` is mocked (in-process idempotency-key Set
+ captured `aries_research_findings` inserts) and the Honcho transport is an
in-process capture/throw/delay stub. No live network, no Postgres. All 15 map
1:1 to a `test('V<n> …')`:

| V | Surface | What the fixture check asserts |
|---|---|---|
| V0 | approvals | Double-approve same job/stage → exactly one idempotency win; 2nd append suppressed. |
| V1 | approvals | Strategy approve → `peer-brand` + `session-strategy-<job>`, one `kind=fact`, `approved_by=<userPseudonym>`; raw `u1`/`tid` absent from wire body. |
| V2 | approvals | Deny `production` + `wrong-colors` → `peer-policy` `rejected_angle` (claim keys exactly `denial_reason_code`/`research_job_id`/`stage`) + `peer-approver-*` `fact`; nothing queued. |
| V3 | approvals | Deny w/o code → content `rejected_angle` queued (`aries_research_findings`, `queue_for_review`); audit `fact` still appended. |
| V4 | approvals | Gate off → approve+deny produce zero appends AND zero idempotency-key queries. |
| V5 | approvals | Throwing transport (503) → `recordApprovalEvent` resolves, no throw escapes. |
| V6 | approvals | `scheduleMarketingApprovalHonchoWrites` returns `void` synchronously (<50ms); a 120ms delayed append does not block the caller synchronously. |
| V7 | publish | Publish-verify (third-party) → `peer-policy` `constraint` queued, NOT appended. |
| V8 | publish | Schedule post (first-party) → `peer-policy` `constraint` auto-approved, `approved_by=system`. |
| V9 | publish | Perf callback w/ https `source_url` → `research_conclusion` queued; `platform_post_id` stripped, 15-digit numeric → `[redacted_numeric_id]`, real metric preserved. |
| V10 | publish | Duplicate job+platform+date → one idempotency win, one queued finding. |
| V11 | publish | 50 jobs × 5 platforms × 3 retry callbacks → retries collapse to 250 distinct writes, `< 1500`/tenant/month bound holds. |
| V12 | preferences | Explicit toggle → `peer-user-*` `preference` auto-approved, `explicit_user_intent=true`, single-word label survives. |
| V13 | preferences | `explicitUserIntent=false` → zero appends, no key claimed (short-circuit before DB). |
| V14 | preferences | `ARIES_MEMORY_LABEL_REDACTION_V2=1`: "Bold Minimalist" survives, "John Smith" → `[redacted_name]`, email → `[redacted_email]`; redacted form is what reaches the wire claim. |

### Prod read-back (`--prod`) — deliberately NOT built here

The plan's `--prod` read-back mode is a manual operator step that needs the two
prod JWTs + real `HONCHO_BASE_URL` above, so it is intentionally out of this
agent's buildable scope. Once §1 lands, the operator re-runs the V1/V2/V7/V8/V12
read-back assertions against the live workspace (GET session/peer messages) to
confirm writes truly land. Until then, the fixture harness is the CI gate and the
rollout is NOT done.

---

## 3. Stale branch `feat/honcho-approval-writes-phase1` — confirmed contained

`git` containment check (read-only) vs `origin/master`:

- The branch's 3 commits (`c4da722`, `4ab6b11`, `4a432a5`) touch 17 files; all
  non-blank added lines for the write-path files
  (`write-events.ts`, `curator.ts`, `research-jobs.ts`, `honcho-env.ts`,
  `pseudonym.ts`, `approval-denial-reason-codes.ts`, `init-db.js`) are present in
  `master` **except 10 lines in `write-events.ts`**, and those 10 are pure
  signature evolution that master strictly supersedes:
  - master threads a testability `client` param
    (`ensureMarketingMemoryQueueJob(…, client)`, `persistQueuedFinding(…, client)`),
  - master widens `peerRefForAutoApprove(outcome, ctx)` for Phase 3,
  - master expands the `honcho-env` import to the Phase 2/3 gates.
- No unique write-path behavior remains on the branch. Content landed via the
  squashed PRs #441/#443.

**Recommendation:** confirm-then-close. Brendan / the orchestrator should delete
the remote branch (`git push origin --delete feat/honcho-approval-writes-phase1`).
Do not open a PR. (An agent must not delete remote branches — recorded here for
the human to action.)
