# Subagent Log: onboarding-contract-freezer

## Scope
Freeze onboarding backend contract based on existing backend behavior for:
- `POST /api/onboarding/start`
- `GET /api/onboarding/status/:tenantId`

Only allowed files were created/updated.

## Sources inspected
- `./backend/onboarding/start.ts`
- `./backend/onboarding/status.ts`

## Output artifacts
- `./specs/onboarding_api_contract.v1.json`
- `./specs/onboarding_response_shapes.v1.json`
- `./generated/draft/subagent-results/onboarding-contract-freezer.json`
- `./generated/draft/subagent-logs/onboarding-contract-freezer.md`

## Contract freeze details
- Added explicit JSON Schema `$defs` for request/success/error shapes.
- Captured HTTP code behavior as implemented:
  - Start: `200` success, `400` missing required fields, `502` workflow failure/unreachable.
  - Status: `200` success, `400` missing tenant identifier.
- Captured enumerated onboarding states:
  - Start success state: `accepted | duplicate | validated | needs_repair`
  - Status success state: `validated | needs_repair | in_progress | duplicate | not_found`
- Added explicit error reason matching (`const` + `pattern`) for machine-checkable validation.

## Important mapping note
Current status handler reads `tenant_id` from query string, while requested external contract is `GET /api/onboarding/status/:tenantId`. The frozen contract includes a routing/mapping note that `:tenantId` must be mapped into `tenant_id` before invoking backend logic.
