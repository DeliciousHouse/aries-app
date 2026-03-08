# marketing-contract-freezer

## Scope
Freeze machine-checkable backend contract from existing implementation behavior for:
- `POST /api/marketing/jobs`
- `GET /api/marketing/jobs/:jobId`
- `POST /api/marketing/jobs/:jobId/approve`

## Evidence reviewed
- `./backend/marketing/jobs-start.ts`
- `./backend/marketing/jobs-status.ts`
- `./backend/marketing/jobs-approve.ts`

## Output produced
- `./specs/marketing_api_contract.v1.json`
- `./specs/marketing_response_shapes.v1.json`

## Key freeze decisions
1. **Start endpoint response** frozen to `status=accepted` with wiring enum:
   - `n8n_research_webhook`
   - `backend_fallback`
2. **Status endpoint not-found behavior** frozen as non-HTTP error body shape:
   - `state=not_found`
   - `status=error`
3. **Approve endpoint response status** frozen to:
   - `resumed`
   - `error`
4. **Stage vocabulary** frozen from local progression logic:
   - `research`, `strategy`, `production`, `publish`
5. **Error shape refs** added for hard-failure and unhandled runtime exceptions:
   - `HardFailureError` (`error` starts with `HARD_FAILURE:`)
   - `UnhandledError` (`error` string catch-all)

## Notes
- Runtime file-derived `state` and `status` values are pass-through from generated job JSON; contract keeps these as generic strings for machine-checkable compatibility with current behavior.
- No files outside allowed scope were modified.
