# Aries dev team (`.claude/agents/`)

A focused subagent roster whose single job is to drive Aries to a **working production 5-gate
golden journey**: Composio connect (FB+IG) → publish → analytics → comments → native reply.

These agents are the **fix engine** of a two-session loop:

- **`/aries-qa-loop`** drives *live production* as a first-time user, finds what's broken on the
  golden journey, and files each defect as a GitHub issue labeled **`qa-defect`**.
- **`/aries-goal`** is the **orchestrator**: it pulls the `qa-defect` queue, routes each issue
  through this team, and opens a draft PR for the sanctioned reviewer lane. The assigned reviewer
  deliberately merges only after CI and acceptance criteria are green.

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
| `aries-reviewer` | Review diff for correctness + security (`/code-review`); then ship a draft PR (`Closes #n`) for the sanctioned reviewer lane | read + bash + Skill | opus |

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
        → reviewer (correctness+security review → guardrails:agent → draft PR Closes #n)
          → assigned reviewer lane → CI full-suite green → deliberate merge → Deploy → QA loop re-verifies in prod
```

## Conventions every agent honors (from `CLAUDE.md`)

- **Turbopack required** — `npm run dev` passes `--turbopack`; the `build` script does not, so pass it explicitly when building manually (Tailwind v4 breaks under webpack otherwise).
- **`npm run verify` green before any push** — the canonical fast regression suite (runs
  `guardrails:agent` first).
- **`npm run guardrails:agent` before opening a PR** — warns on no-unique-diff / duplicate work.
- **Branch off `master`, never commit on `master`** — one issue → one `fix/<n>-<slug>` (or `feat/`) branch.
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
- The retired `agent:fix` and `agent:auto-merge` labels have no workflow consumer and must not be
  used as routing or merge gates. Hermes Kanban is the canonical dev-team queue.
- Every implementation PR opens as a **draft**. The sanctioned intake assigns one reviewer lane;
  only that lane marks the PR ready and merges deliberately after required CI and acceptance
  criteria are satisfied. This local team never enables auto-merge or merges its own PR.
- Fixes auto-close their issue via `Closes #<n>`; **no agent closes a `qa-defect` issue by hand** —
  the QA session verifies in prod.

These files are committed (`.gitignore` un-ignores `.claude/agents/**`), so any fresh checkout has
the team. Edit a role by editing its `*.md`; the orchestrator can override a per-call `model`.
