# Aries dev team (`.claude/agents/`)

A focused subagent roster whose single job is to drive Aries to a **working production 5-gate
golden journey**: Composio connect (FB+IG) → publish → analytics → comments → native reply.

These agents are the **fix engine** of a two-session loop:

- **`/aries-qa-loop`** drives *live production* as a first-time user, finds what's broken on the
  golden journey, and files each defect as a GitHub issue labeled **`qa-defect`**.
- **`/aries-goal`** is the **orchestrator**: it pulls the `qa-defect` queue, routes each issue
  through this team, and sends every fix through a draft PR and the assigned reviewer lane. It runs
  until the QA session writes `.qa-loop/VERIFIED.md` (all five gates green in prod) and the
  `qa-defect` queue is empty.

The orchestrator does the routing; these agents do the work. GitHub issues + PRs are the durable
shared state, so the loop resumes cleanly after any interruption.

## Roster

| Agent | Role | Tools | Model |
|---|---|---|---|
| `aries-issue-groomer` | Dedupe the `qa-defect` queue, set severity, order it (severity-first; gate breaks ties: connect→publish→analytics→comments→reply); file audit-derived gaps as issues | read + `gh` (Bash) | sonnet |
| `aries-planner` | One issue → scoped plan (root cause, files, test strategy, routing, risk); gate-audit mode returns gaps. No refactors. | read-only | opus |
| `aries-backend` | Implement `backend/` · `lib/` · `app/api/` fixes | edit + bash | sonnet |
| `aries-frontend` | Implement `frontend/` · `components/` (rendered dashboard) fixes | edit + bash | sonnet |
| `aries-integrations` | Meta Graph · Composio · Hermes port/reconciler · OAuth/token-crypto | edit + bash | sonnet¹ |
| `aries-test-author` | Add/update `tsx --test` coverage; run `npm run verify` + the focused gate | edit + bash | sonnet |
| `aries-reviewer` | Pre-PR correctness + security review (`/review`); then rebase, run guardrails, and open a draft PR (`Closes #n`) for the assigned merge-gate lane | read + bash + Skill | opus |

¹ `aries-integrations` defaults to sonnet; the orchestrator should run it on **opus** for subtle
token-race / Graph-API-contract / Hermes-polling bugs.

**Why this split:** planner and reviewer are the judgment/critique roles → **opus** (matches the
repo's "planning & review agents on Opus, implementers on Sonnet" convention). Implementers and the
test-author are execution roles → **sonnet**. Each tool list is least-privilege: the planner can't
edit, the groomer/reviewer can't write product code, only implementers + test-author can edit.

## The pipeline (one issue)

```
groomer (queue → ordered)
  → planner (issue → scoped plan + routing)
    → backend | frontend | integrations (implement on fix/<n>-<slug>)
      → test-author (regression test + npm run verify + focused gate)
        → reviewer (correctness+security review → rebase → guardrails:agent → draft PR Closes #n)
          → CI full-suite green → assigned reviewer deliberately squash-merges → Deploy → QA loop re-verifies in prod
```

## Conventions every agent honors (from `CLAUDE.md`)

- **Turbopack required** — `npm run dev` passes `--turbopack`; the `build` script does not, so pass it explicitly when building manually (Tailwind v4 breaks under webpack otherwise).
- **`npm run verify` green before any push** — the canonical fast regression suite (runs
  `guardrails:agent` first).
- **`npm run guardrails:agent` before opening a PR** — warns on no-unique-diff / duplicate work.
- **Start with `git fetch origin --prune` and branch only from `origin/master`** — verify base distance before editing; one issue → one `fix/<n>-<slug>` (or `feat/`) branch, never local `master`.
- **Conventional Commits with a scope** — e.g. `fix(integrations): …`.
- **Resumability rule** — never discard partial artifacts on a transient/rate-limit failure; persist,
  surface, let the orchestrator retry.
- **DB-pool fan-out rule** — no new `Promise.all` around Postgres/gateway chains without checking
  `DB_POOL_MAX` and benchmarking the full endpoint.
- **Banned patterns** — `npm run validate:banned-patterns` stays green.
- **Hermes is a polled API and must never be exposed to the browser** — UI → route handlers only;
  delivery is the standing reconciler, never a per-request promise.

## Labels & merge mechanics

- Work queue: **`qa-defect`** (issues filed by the QA loop; the groomer also adds `gate:*` / `sev:*`).
- The team does **not** add `agent:fix` (that triggers the separate *cloud* issue-agent workflow and
  would race this local team).
- Every implementation PR opens as a **draft**. Never enable auto-merge and never add
  `agent:auto-merge`; the legacy workflow can otherwise race the deliberate review gate.
- The sanctioned review intake assigns exactly one merge authority: even PR numbers go to
  `dev-reviewer`, odd PR numbers to `dev-reviewer-2`. That reviewer waits for the required
  `full-suite` check, judges the acceptance criteria, marks the PR ready, and deliberately
  squash-merges. The other lane does not touch the PR.
- Fixes auto-close their issue via `Closes #<n>`; **no agent closes a `qa-defect` issue by hand** —
  the QA session verifies in prod.

These files are committed (`.gitignore` un-ignores `.claude/agents/**`), so any fresh checkout has
the team. Edit a role by editing its `*.md`; the orchestrator can override a per-call `model`.
