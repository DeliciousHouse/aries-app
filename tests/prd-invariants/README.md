# PRD §20 Invariant Tests

These tests codify the canonical behavioral invariants from
`docs/product/aries-ai-prd.md` §20 as runtime/static assertions so future PRs
get a green/red CI signal on PRD conformance.

One file per invariant. File naming: `inv-NN-<slug>.test.ts`, where `NN` is the
invariant number from §20 (01–15).

These run under the Node built-in test runner via `tsx --test`, matching the
rest of the suite. The verify script (`scripts/verify-regression-suite.mjs`)
includes this directory as a step.

## When you change one of these

If you genuinely need to relax an invariant, the PRD changes first. Open a PR
that edits §20, then update the corresponding test. A test edit without a
PRD edit is the wrong shape — the PRD is the contract; the test is the
enforcer.

## Style

- Each test file opens with a comment block quoting the invariant verbatim.
- Static-analysis tests should fail loud with the offending file:line so the
  failure points at the violation, not the invariant.
- Unit-level tests should target a single public function and assert one
  property at a time. Don't mix the invariant check with general feature
  coverage — that's what the rest of `tests/` is for.
