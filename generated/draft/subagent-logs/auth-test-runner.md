# auth-test-runner log

## Summary
Created and executed the V2-1 auth implementation validation harness using frozen Wave 1 contracts only.

## Files written
- `./tests/run-v2-auth-suite.ts`
- `./generated/draft/v2-auth-implementation-results.json`
- `./generated/draft/v2-auth-implementation-phase-log.md`
- `./generated/draft/subagent-results/auth-test-runner.json`
- `./generated/draft/subagent-logs/auth-test-runner.md`

## Harness behavior
- Loads all specified V2 auth contracts and merge-validation input.
- Evaluates five hard-fail gates (`V2-1-G01` … `V2-1-G05`) with machine-readable per-check evidence.
- Writes deterministic JSON results and markdown phase log to `generated/draft`.

## Execution
- Command: `npx -p tsx tsx tests/run-v2-auth-suite.ts`
- Exit code: `0`

## Result snapshot
- Overall status: `fail`
- Passed gates: `3/5` (`V2-1-G01`, `V2-1-G03`, `V2-1-G05`)
- Failed gates: `2/5` (`V2-1-G02`, `V2-1-G04`)
- Failure causes from contract evidence:
  - `V2-1-G02`: placeholder secret value detected in `./.env.example`
  - `V2-1-G04`: pattern-based auth error reasons make error domain non-finite
