# Bug severity rubric

Use the highest level that clearly fits the observed impact.

## Critical
Use when any of these are true:
- production outage or app unusable for most users
- auth, billing, security, or data-loss/corruption risk
- core flow broken with no workaround
- repeated hard crash or infinite loop on a primary route

## High
Use when any of these are true:
- major regression on an important workflow
- large group of users blocked or badly degraded
- clear customer-facing failure with only a poor workaround

## Medium
Use when any of these are true:
- partial degradation with a viable workaround
- secondary workflow broken
- issue is real but scope is limited or recoverable

## Low
Use when any of these are true:
- cosmetic issue
- copy/docs mismatch
- narrow edge case with low user impact
- minor annoyance that does not block completion

## Tie-breakers
- If data integrity or security is involved, round up.
- If the bug only affects a parity stub or unsupported route, do not overstate severity.
- If reproduction is weak or impact is uncertain, use the lower level and explain the uncertainty.
