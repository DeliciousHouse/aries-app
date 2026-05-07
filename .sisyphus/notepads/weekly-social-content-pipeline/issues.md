# Issues — weekly-social-content-pipeline

## [2026-05-06] Known issues before work begins (Metis-identified)

### P0 Issues (blockers)
1. **Asset tenant leak via SHA dedup**: `backend/marketing/asset-ingest.ts` stores assets under `{sha}` without tenant prefix → two tenants uploading identical bytes share one file. Must fix in T1 BEFORE T8 ships logo URLs.
2. **next.config.mjs has no images.remotePatterns**: next/image silently fails for any external URL. This IS the "images not shown in frontend" bug. Fix in T6.
3. **media_urls not validated in publish dispatch**: `handlePublishDispatch` passes caller-supplied media_urls directly to Hermes with zero ownership check. Fix in T5.

### P1 Issues (security)
4. **OAuth refresh is a 48-line stub**: `backend/integrations/refresh.ts` bumps `token_expires_at` from caller input but does NOT call any provider endpoint. Every token expires silently. Fix in T2.
5. **Single bearer secret for ALL callbacks**: `INTERNAL_API_SECRET` covers all tenants + all workflows. Leaked = full forgery. Mitigate with per-run callback_token in T4.
6. **No per-run callback token**: Attacker with known `aries_run_id` can forge callbacks with new event_ids. T4 fixes.

### P2 Issues (functional gaps)
7. **Aspect ratio hardcoded 4:5**: `workflow-request.ts:123` — FB feed gets wrong dimensions. Fix in T9.
8. **Brand kit dropped in Hermes payload**: `buildSocialContentWeeklyRequest` only uses `brand_kit.brand_name` as fallback. Logo/colors/fonts/voice NOT injected. Fix in T8.
9. **No stale-run reaper**: Runs in submitted/running that never get a callback become permanent zombies. Fix in T25.
10. **Onboarding doesn't gate on platform connection**: `resolvePostLoginDestinationForUser` only checks `business_profiles.incomplete`. Fix in T16.
11. **Two 501 stubs at /api/tenant/approval-requests/[id]/approve + reject**: Dead code that confuses callers. Delete in T23.
12. **in-memory token-store.ts (Map in globalThis)**: Lost on restart. Canonical store is `oauth_tokens` DB table. T2 must write to DB only.

## Append new issues here as discovered during task execution
