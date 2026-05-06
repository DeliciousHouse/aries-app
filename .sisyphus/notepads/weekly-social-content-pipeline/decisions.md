# Decisions — weekly-social-content-pipeline

## [2026-05-06] Locked user decisions

1. **Platform scope v1**: Meta + Instagram ONLY (no LinkedIn/X/YouTube/TikTok/Reddit end-to-end publish)
2. **Anti-slop strategy**: Full stack — brand-grounding + vision-model post-gen QA + frame overlay + operator escape hatches (regenerate + upload-replace)
3. **Weekly trigger**: Manual only ("Generate this week" button). NO cron in v1.
4. **Onboarding gate**: HARD — `business_profiles.incomplete = false` AND `count(oauth_connections WHERE status='connected' AND provider IN ('facebook','instagram')) >= 1` required to reach /dashboard
5. **Review edits**: Inline copy edit (autosave, last-write-wins) + per-image regenerate/upload-replace + reschedule per post. NO bulk approve, NO drag-reorder, NO rich text, NO version history.
6. **Test strategy**: Tests-AFTER for most + agent QA per task. Tests-FIRST for 4 security boundary modules.

## [2026-05-06] Metis architectural decisions

- Regenerate = NEW aries_run (NOT back-step on existing run — callback handler rejects stage regression)
- Inline edit: single-writer last-write-wins (no OT/CRDT)
- Uploaded images: same vision QA gate as generated images (ToS override option on fail)
- Orphaned upload retention: 24h before GC
- Meta publish ownership: Hermes owns the actual Meta/IG Graph API call; Aries calls `runAriesWorkflow('publish_dispatch')` which delegates to Hermes
- Token canonical store: `oauth_tokens` DB table (NOT `token-store.ts` Map in globalThis — in-memory store is a known technical debt)
- Asset storage key: `{tenant_id}/{sha[0:2]}/{sha}.{ext}` (tenant prefix mandatory, P0)

## [2026-05-06] Meta/IG specific decisions

- Platform token: PERSIST Page Access Token NOT User Access Token
- Multi-page: redirect to /onboarding/connect/meta/select-page Page picker
- IG Business Account: discovered via GET /me/accounts then /{page_id}?fields=instagram_business_account
- Long-lived exchange: MUST happen immediately in callback handler (before storing any token)
- Aspect ratios: IG single 4:5 or 1:1 (default 4:5), IG carousel 1:1, FB single 1:1, FB link card 1.91:1
- Frame overlay: IG feed + FB feed static only (NOT link cards, NOT carousels internal slides)

## [2026-05-06] Vision QA thresholds (concrete)

- `brand_color_match >= 0.6` (Lab ΔE < 25 vs nearest palette)
- `text_legibility >= 0.8`
- `forbidden_pattern_hits == 0`
- `brand_violation < 0.3`
- Max 3 retries before forced operator decision (approve-anyway or upload-replace)
