# marketing-intake-builder (rerun)

- Scope respected: only the five allowed files were updated.
- Canonical schema inputs used:
  - `./specs/tenant_runtime_state_schema.v1.json`
  - `./specs/job_runtime_state_schema.v1.json`
- `marketing_job_contract_spec.v1.json` now maps request/response fields to canonical runtime schema enums/patterns.
- `jobs-start.ts` and `jobs-status.ts` now fail hard if either canonical schema is missing **or** invalid JSON.
- Result status changed from `failed` to `completed` for this rerun.
