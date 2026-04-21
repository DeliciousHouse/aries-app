# Ralph Loop — Aries QA Follow-up

Agent-driven completion of 8 deferred QA issues from
`.gstack/qa-reports/qa-report-aries-sugarandleather-com-2026-04-20.md`.

Each issue is a user story with `passes: false` in `user-stories/`. The loop
picks one, fixes it, commits, sets `passes: true`.

## Constraints (HARD RULES)

1. **No push to origin.** All work stays on local master. Brendan is the final
   decision-maker per aries-app/AGENTS.md.
2. **One atomic commit per fix.** Test + fix in separate commits.
3. **Write a regression test for every functional/content fix.**
4. **Verify with the live site** at https://aries.sugarandleather.com using browser
   tools (authenticated as hermes-dev@agentmail.to, password HermesQA-Aries-2026!).
5. **STOP on ambiguity.** If the fix requires a design decision (user-facing
   copy, UX tradeoff, data-model change), write a blocker note to `log.md`
   and skip to the next story instead of guessing.
6. **Stay inside aries-app.** No sibling-repo changes.
7. **Tests must pass** — run `npx tsx --test tests/<affected>.test.ts` after every fix.

## Escalation to codex

When stuck (3 failed attempts on the same sub-step, or TS compiler confusion,
or regex puzzles), classify difficulty and delegate:
- **Easy** (mechanical find-and-replace, adding props, copy fixes) → `codex exec --model gpt-5.3-codex-spark "..."`
- **Hard** (root-cause debugging, cross-module refactors, view routing logic) → `codex exec --model gpt-5.4 "..."`

Codex must run inside `/home/node/aries-app` (already a git repo). Use
`pty=true` in terminal calls. Codex work gets reviewed by the driving agent
before commit — do not blindly accept its changes.

## Workflow Per Iteration

1. Read `log.md` to see what prior iterations did.
2. Read all `user-stories/*.json`. Pick first one with `passes: false`.
3. Reproduce the bug on the live site (browser tools). Capture a before screenshot.
4. Locate the source (Read / Grep / Glob).
5. Write a failing regression test that captures the bug.
6. Fix the smallest thing that makes the test pass.
7. Run the affected test file AND `npx tsc --noEmit` on changed files.
8. Commit fix (one atomic commit). Commit regression test (second commit).
9. Set `passes: true` in the story JSON, commit that too.
10. Append to `log.md` with: story ID, files touched, commit SHAs, verification notes.
11. If stuck: write `blocked: true` and `blocker_reason` to the JSON, append to log, skip.

## Completion

When every story has `passes: true` OR `blocked: true`, output:

<promise>FINISHED</promise>
