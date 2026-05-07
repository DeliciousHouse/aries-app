# F2 full-test blocker — 2026-05-06

## Verdict

`npm run test` is still blocked by the existing full-suite baseline, not by the weekly social-content final-wave changes in this PR.

## Latest run

Command:

```bash
npm run test
```

Result:

```text
tests 1160
suites 12
pass 1108
fail 50
skipped 2
duration_ms 65034.407714
```

The run includes the PR-comment follow-up tests as passing:

- `tests/smoke-weekly-pipeline.test.ts`: subtests 969-986 passed.
- `tests/social-content-approve-route.test.ts`: subtests 987-992 passed.

## Failure buckets observed

Representative failing areas remain outside the weekly social-content final-wave changes:

- Auth tenant membership / integration tenant-context tests still fail on organization slug generation and tenant-context expectations.
- OAuth connect/callback tests still fail on status expectations and missing Postgres password configuration (`SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string`).
- Legacy marketing/frontend API tests still fail on older brand-kit/runtime expectations and required `payload.businessType` fields.
- Environment/live-adapter tests still fail on missing Hermes/OpenClaw configuration or live gateway availability.
- Existing public route/review surface/runtime truth tests still fail on unrelated copy/status expectations.

## Notable newly observed single failure

The latest run reports `tests/tenant/business-profile.test.ts` expecting `Sophisticated and Authoritative.` while the current implementation returns `Sophisticated, Provocative, and Authoritative.`. This is also outside the weekly social-content smoke/approval review-comment changes.

## Conclusion

F2 cannot honestly be marked green until the repository-wide legacy suite is fixed or the acceptance criterion is narrowed to targeted weekly social-content verification. Current PR-scoped verification remains green, but the full test command remains blocked by unrelated baseline failures.
