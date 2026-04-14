# Runtime incident lifecycle

Statuses used by the runtime incident pipeline:

- `open`: newly detected and waiting for a repair plan
- `repair_planned`: repair plan recorded, safe to attempt
- `repairing`: actively being worked
- `retryable`: previous repair attempt failed but another bounded attempt is allowed
- `resolved`: latest scan no longer reproduces the incident, or a fix was validated
- `escalated`: automation stopped and handed the issue back to an operator

Primary fields in `data/runtime-error-incidents.json`:

- `incidentId`
- `fingerprint`
- `severity`
- `source`
- `errorMessage`
- `details`
- `validationCommand`
- `repairHints`
- `attemptCount`
- `detectionCount`
- `planSummary`
- `fixSummary`
- `validationSummary`
- `resolutionSummary`
