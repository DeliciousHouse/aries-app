# CI / CodeQL stabilization

**Status:** Open — P3 hygiene. Proportionate cleanup, not a rewrite.
**Author:** Staff eng plan, 2026-05-30.
**Related:**
- ci-watcher issues: #279, #280, #330, #336, #421
- `TODOS.md:180-195` ("CI infra — Autofix workflow HTTP 401 + checkout 'terminal prompts disabled' flake")
- `.github/workflows/pr-agent-autofix-automerge.yml`
- `.github/workflows/tests.yml`
- `.github/workflows/issue-agent-fix.yml`

---

## Context

Over the last three weeks the ci-watcher bot filed five issues against the CI surface. They cluster into two families:

1. **CodeQL infra flakes** (#279, #280, #330, #336, #421) — the GitHub *default-setup* CodeQL check intermittently aborts in 0-6s (`Prepare` hard-fail), stalls in `queued` for 4h+ post-merge, or the top-level `CodeQL` rollup reports `failure` in ~2s while every sub-job is green. One (#421) is a 42s `Analyze (python)` failure that may be a real finding or a Python-runner regression.
2. **Autofix/automerge auth flakes** (#280 and `TODOS.md:180`) — `pr-agent-autofix-automerge.yml` once failed with `HTTP 401: Bad credentials` on the labels API, and CodeQL's checkout once failed with `fatal: could not read Username for github.com: terminal prompts disabled`. Both self-resolved on re-trigger.

The single most important fact, **verified this session**, reframes the whole epic: branch protection on `master` requires only the `full-suite` check, **not** the `CodeQL` rollup.

```
$ gh api repos/:owner/:repo/branches/master/protection \
    --jq '.required_status_checks.contexts'
["full-suite"]
```

So the CodeQL rollup races (#330, #336) and the `Prepare` aborts (#279) **do not block merges today** — they are noise on the PR checks tab, not a gate. That bounds the work: this is hygiene to stop ci-watcher churn and keep the autofix/automerge robot from tripping, not an emergency to unblock shipping.

## Who cares

- **Brendan** — sees red CodeQL X's on every PR and gets ci-watcher issues filed; wants the noise gone without weakening real security scanning.
- **The autonomous PR-maintenance robot** (`pr-agent-autofix-automerge.yml`) — a transient 401 on label creation aborts the entire maintenance run and can leave a PR un-merged with no `agent:needs-attention` signal.
- **Future agents** triaging CI — every recurring flake costs minutes of "is this real or infra" triage during ship cascades.

## Decisions (locked, do not re-litigate)

1. **CodeQL stays GitHub default setup.** There is no `.github/workflows/codeql.yml` (verified — `.github/workflows/` holds only `deploy.yml`, `issue-agent-fix.yml`, `pr-agent-autofix-automerge.yml`, `tests.yml`). We do NOT convert to advanced/committed-workflow CodeQL just to gain `continue-on-error` knobs. Default setup is configured in repo Security settings, which is out of band from this repo's YAML.
2. **`full-suite` remains the sole hard merge gate.** We do not add `CodeQL` as a required check. The whole point of #505/#507 was to make the real test suite the gate; CodeQL is advisory.
3. **Do not disable CodeQL.** It is cheap and occasionally useful. We harden around its flakiness, we do not remove security scanning.
4. **Label creation is best-effort.** Labels are created with `--force` (idempotent) and exist already in the repo. A failure to (re)create them must never abort the maintenance run.
5. **Scope is the four in-repo workflow files + ci-watcher issue triage.** GitHub-side settings changes (Security tab toggles, runner pool) are *recommendations* in this plan, executed by Brendan, not code we can land.

## Current State (VERIFIED — file:line)

**Branch protection** — `full-suite` only (see Context query above). CodeQL is not a required context.

**Autofix/automerge label creation is unguarded** — `.github/workflows/pr-agent-autofix-automerge.yml:57-61`:
```bash
run: |
  set -euo pipefail
  gh label create agent:auto-merge --color 0E8A16 --description "..." --force
  gh label create agent:needs-attention --color D93F0B --description "..." --force
```
This step runs under `set -euo pipefail` (line 58). A transient `HTTP 401` from the labels API (the exact failure in `TODOS.md:183`) makes `gh label create` exit non-zero, which aborts the entire `Resolve PR and guardrails` step and the whole job — before any PR resolution happens. The same unguarded pattern is duplicated in `issue-agent-fix.yml:67-72` and `issue-agent-fix.yml:127-128`.

**Checkout uses default credential persistence** — `pr-agent-autofix-automerge.yml:46-49`:
```yaml
- name: Checkout repository
  uses: actions/checkout@v6.0.2
  with:
    fetch-depth: 0
```
No explicit `persist-credentials`. The `terminal prompts disabled` flake (`TODOS.md:184`) hit CodeQL's *own* checkout (default setup, not this file), so there is nothing in-repo to fix there — it is documented as a re-trigger, not a code change.

**The autofix job has no `gh` retry/backoff anywhere** — every `gh` call (lines 60-61, 77, 124-127, 236, 251-262, 269) is a bare invocation. A single transient 5xx/401 on any of them aborts under `pipefail`.

**`tests.yml` (the real gate) is healthy** — `tests.yml:32-63`: checkout v6.0.2, Node 24 with npm cache, `npm ci`, `npm run lint`, full suite at `--test-concurrency=1` with a per-run `DATA_ROOT="${RUNNER_TEMP}/aries-data"`. No flakes reported against it. We leave it alone.

**ci-watcher issues are stale** — #279, #280 reference PR #278 (merged 2026-05-07); #330 PR #326; #336 PR #332 (all merged). #421's PR #404 is merged to master. None point at an open blocking PR. They are post-merge retrospective noise.

**#421 specifics** — the report itself flags two candidates (real Python finding vs. Python-runner env regression) and explicitly says log inspection is required. PRs after #404 (#417/#418/#420) had no `Analyze (python)` job at all, meaning CodeQL only language-detects Python when Python files in #404's tree change. This is a *log-read + classify* task, not a code-change task until we know which it is.

## Architecture (data flow)

```
                         PR opened / synchronize / labeled
                                      |
        +-----------------------------+------------------------------+
        |                             |                              |
        v                             v                              v
  tests.yml                  CodeQL (default setup,         pr-agent-autofix-
  (full-suite)               GitHub-managed, NOT in repo)   automerge.yml
        |                             |                              |
   REQUIRED gate              Prepare -> Analyze(js/py/actions)  Resolve PR + guardrails
   (branch protection)         -> Upload -> rollup "CodeQL"        |  (gh label create  <-- 401 abort point)
        |                             |                            checkout (persist-credentials default)
        v                       ADVISORY only                       |  Claude autofix -> validate -> settle
   blocks merge                (NOT a required check)               |  gh pr merge --squash --auto
                                      |                              v
                              ci-watcher files issue            Deploy dispatch
                              on red rollup / stuck queue
                                      |
                              #279 #280 #330 #336 #421  <-- noise we want to quiet
```

The fix surface is the right column (autofix robot hardening) plus an issue-triage sweep. The CodeQL column is GitHub-managed; we can only recommend Security-tab changes.

## Child issues / phases

| # | Phase | Priority | Effort (human / CC) | Dependencies |
|---|-------|----------|---------------------|--------------|
| 1 | Guard label-creation + add `gh` retry helper in autofix/issue workflows | P2 | 30m / 10m | none |
| 2 | Triage + close stale ci-watcher CodeQL issues (#279, #280, #330, #336) | P3 | 20m / 5m | none |
| 3 | Resolve #421 (read the Python job log, classify finding vs. infra) | P3 | 30m / 15m | log access |
| 4 | Document CodeQL-flake re-trigger runbook + recommend Security-tab settings | P3 | 20m / 10m | none |

Phases are independent and can land in any order. Phase 1 is the only code change with regression value; ship it first.

---

### Phase 1 — Harden the autofix/automerge robot against transient `gh` auth flakes

**Implementation**

In `pr-agent-autofix-automerge.yml`, make label creation best-effort and isolate it from the guardrail logic. Replace lines 60-61:
```bash
gh label create agent:auto-merge ... --force
gh label create agent:needs-attention ... --force
```
with a non-fatal, retried form (decision #4 — labels are idempotent and already exist):
```bash
ensure_label() {  # best-effort; never abort the run on a transient labels-API flake
  local name="$1" color="$2" desc="$3" attempt
  for attempt in 1 2 3; do
    if gh label create "$name" --color "$color" --description "$desc" --force; then return 0; fi
    echo "::warning::gh label create $name failed (attempt $attempt/3); retrying"
    sleep $((attempt * 3))
  done
  echo "::warning::gh label create $name failed after 3 attempts; continuing (labels are idempotent)"
  return 0
}
ensure_label agent:auto-merge 0E8A16 "Agent-created PR is eligible for autonomous fixes and merge"
ensure_label agent:needs-attention D93F0B "Agent automation needs human attention before merge"
```
The `return 0` keeps `set -euo pipefail` (line 58) from killing the step. Apply the identical helper to the two `gh label create` sites in `issue-agent-fix.yml:69-71` and `:128`.

Keep the *merge-decision* `gh` calls (lines 236, 251-262) strict — a 401 there should still fail loud and tag `agent:needs-attention`, which is already the behavior. Only the non-load-bearing label/setup calls become best-effort.

**Acceptance**
- A simulated `gh label create` non-zero exit (e.g. temporarily point it at a bogus label color in a scratch branch run) no longer aborts the job; the step logs a `::warning::` and continues to "Resolve PR".
- `actionlint .github/workflows/pr-agent-autofix-automerge.yml .github/workflows/issue-agent-fix.yml` is clean.
- The happy path is unchanged: on a normal run all labels still get created and the PR still merges.

---

### Phase 2 — Close the stale CodeQL ci-watcher issues

**Implementation**

#279, #280, #330, #336 all reference PRs that are long merged, and all describe the CodeQL rollup / `Prepare` / autofix race. Given decision #2 (CodeQL is not a required check), none of these ever blocked a merge. Close each with a comment that:
- States branch protection requires only `full-suite` (cite the API output), so a red `CodeQL` rollup is advisory and does not block.
- Links Phase 1 for the autofix-side 401 in #280.
- Links the Phase 4 runbook for the re-trigger procedure.

```bash
for n in 279 280 330 336; do
  gh issue close "$n" --comment "Closing as stale CI infra noise. Verified $(date +%Y-%m-%d): branch protection requires only the \`full-suite\` check, not the \`CodeQL\` rollup, so these CodeQL default-setup races/aborts are advisory and never blocked a merge. The autofix-side 401 (#280) is hardened in <PR link from Phase 1>. Re-trigger runbook: docs/plans/2026-05-30-ci-codeql-stabilization.md (Phase 4)."
done
```

**Acceptance**
- #279, #280, #330, #336 are closed with the explanatory comment.
- No new ci-watcher issue is filed for the same rollup race within one week (observational).

---

### Phase 3 — Resolve #421 (Python analyze failure: finding vs. infra)

**Implementation**

This is a *classify-first* task; the issue body says log access is required. Do NOT guess.
1. Read the failing job log:
   ```bash
   gh run view 26241194782 --log-failed | sed -n '1,200p'
   # or: gh api repos/:owner/:repo/actions/jobs/77227690777/logs
   ```
2. Branch on the tail:
   - **SARIF / `N alerts found` / CWE reference** -> real Python finding. Locate the flagged file (likely a `scripts/*.py` or a doc-embedded snippet introduced by PR #404's OpenClaw removal), and either fix it or, if a confirmed false positive, dismiss the alert in the Security tab with justification. Open a one-line PR if code changes.
   - **pip / environment / signal abort** -> infra. Confirm whether #404 changed anything Python-runner-relevant (it was a Lobster/OpenClaw removal — likely deleted the only `.py` files, leaving CodeQL with a phantom Python target). If no first-party Python remains, the right fix is GitHub-side: drop Python from CodeQL default-setup languages (Security tab) so the phantom `Analyze (python)` job stops being scheduled.
3. Comment the classification on #421 and close.

**Acceptance**
- #421 has a comment stating finding-vs-infra with the log line that decided it.
- If a finding: alert is fixed or dismissed-with-justification. If infra/phantom: Python either re-confirmed as a real target or recommended for removal from default-setup languages.
- #421 closed.

---

### Phase 4 — Re-trigger runbook + Security-tab recommendations

**Implementation**

Add a short "CodeQL flake runbook" subsection to `TODOS.md` (replacing the open item at `TODOS.md:180-195` with a resolved pointer) capturing:
- **Rollup says `failure` in <5s but all sub-jobs green** (#330 pattern): re-run failed checks from the Actions UI, or push an empty commit. It is a GitHub status-aggregation race; nothing to fix in-repo. Not a merge blocker (only `full-suite` gates).
- **`Prepare` stuck `queued` post-merge** (#336): orphaned check run; ignore (PR already merged) or cancel the run for tidiness.
- **`terminal prompts disabled` on CodeQL checkout** (`TODOS.md:184`): `actions/checkout` lost its token context; re-trigger with a push. In-repo `pr-agent`/`issue-agent` checkouts are unaffected (they pass `GH_TOKEN` explicitly).

Recommendations for Brendan to action in **repo Settings -> Code security** (out of band, not code):
- If #421 resolves to a phantom Python target, remove Python from default-setup languages.
- Confirm Copilot Autofix for CodeQL is intentionally on/off; the `Prepare`/`Agent` jobs only appear when it is enabled (root cause hypothesis in #279).

**Acceptance**
- `TODOS.md:180-195` item is replaced by a resolved entry linking this plan.
- Runbook subsection exists and covers the three flake signatures.

---

## Testing Plan

Fixture-primary: this epic touches workflow YAML and issue triage, so "tests" are lint + simulated-failure runs, not the TS suite.

| What | How | Type |
|------|-----|------|
| Workflow YAML validity | `actionlint .github/workflows/*.yml` | fixture (static) |
| Label-flake non-fatal | Scratch branch: force `gh label create` to exit non-zero; assert step continues to "Resolve PR" and logs `::warning::` | fixture (simulated) |
| Happy-path unchanged | `workflow_dispatch` on a throwaway PR with `skip_wait=true`; assert labels created + merge path reached | integration (manual dispatch) |
| Merge-decision still strict | Confirm a forced 401 on `gh pr merge` (line 251) still tags `agent:needs-attention` and exits 1 | inspection |
| No TS-suite regression | `npm run verify` (no app code changed; smoke only) | regression |
| ci-watcher silence | Observe no new dup CodeQL issue for 1 week | observational |

No new TS test files; no DB/Hermes/tenant surface is touched, so guardrail #1 (DB fan-out) and resumability do not apply. Turbopack is irrelevant (no app build change).

## Rollback

All changes are confined to workflow YAML and issue state.
- **Phase 1:** `git revert` the workflow commit. The `ensure_label` helper is additive; reverting restores the prior unguarded `gh label create` lines. Zero data/runtime impact — these workflows do not touch prod containers, the DB, or Hermes.
- **Phase 2:** reopen issues with `gh issue reopen <n>` if a close was premature.
- **Phase 3:** if a "fix" for #421 regresses, `git revert` the one-line PR; a dismissed-alert can be un-dismissed in the Security tab.
- **Phase 4:** doc-only; revert the `TODOS.md` edit.
No deploy, no migration, no env-var change.

## Out of Scope

- Converting CodeQL from default setup to a committed `codeql.yml` advanced workflow.
- Adding `CodeQL` as a required status check (explicitly rejected — decision #2).
- Disabling or removing CodeQL scanning (decision #3).
- Self-hosted vs. GitHub-hosted runner migration for CodeQL (#336's long-term suggestion) — that is a runner-infra decision, not P3 hygiene.
- Any change to `tests.yml` / the `full-suite` gate (healthy, leave alone).
- Any change to `deploy.yml`.
- GitHub Security-tab toggles themselves — recommended in Phase 4 but executed by Brendan, not landable code.

## Files Reference

| Path | Role | Touched by |
|------|------|-----------|
| `.github/workflows/pr-agent-autofix-automerge.yml` | Autonomous PR maintenance + automerge; unguarded `gh label create` at :60-61 (401 abort) | Phase 1 |
| `.github/workflows/issue-agent-fix.yml` | Issue->PR agent; same unguarded label pattern at :69-71, :128 | Phase 1 |
| `.github/workflows/tests.yml` | The real `full-suite` required gate; healthy | none (reference) |
| `.github/workflows/deploy.yml` | Deploy; unrelated | none (reference) |
| `TODOS.md:180-195` | Logged 401 + terminal-prompts flake (P3 defer) | Phase 4 |
| ci-watcher issues #279/#280/#330/#336 | Stale CodeQL infra noise | Phase 2 |
| ci-watcher issue #421 | Python analyze failure, unclassified | Phase 3 |
| (no `.github/workflows/codeql.yml`) | CodeQL is GitHub default setup, managed in Security tab | out of repo |
