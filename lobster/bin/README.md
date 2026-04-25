# Wrapper commands

These commands are referenced by the `.lobster` files and are expected to be small CLIs that print JSON to stdout.

Implemented locally for stage 1:
- `meta-ads-extractor`
- `meta-ads-analyser`
- `ad-creative-analysis`
- `ads-analyst`

Stage-1 behavior:
- The wrappers are runnable with a **live research** model for the canonical marketing pipeline:
  - Live paths attempt networked research (Meta Graph, web search, Gemini summarization).
  - When canonical stage execution requests strict mode and no live source is available, the step fails explicitly instead of returning fake evidence.
- `meta-ads-extractor` accepts `--json --competitor <name>` and may also receive `--competitor-facebook-url` and `--research-model`.
- `ads-analyst` accepts `--json --mode compile`.
- Intermediate stage-1 outputs are cached under `/tmp/lobster-stage1-cache/<run_id>/` so the final compile step can reconstruct competitor/campaign research artifacts.
- Run the workflows from the [`lobster/`](/home/bkam/.openclaw/workspace/lobster) directory so the relative `./bin/...` commands resolve correctly.
- Research wrappers explicitly default to `gemini/gemini-2.5-flash` and mark `web_search_required: true`.

Runtime env vars used by stage-1 wrappers:
- `META_ACCESS_TOKEN` (Meta Graph live extraction)
- `META_AD_ACCOUNT_ID` (available for downstream Meta publish flows and traceability)
- `META_PAGE_ID` (optional extra object lookup)
- `GEMINI_API_KEY` (optional live Gemini summarization)
- `LOBSTER_WEB_SEARCH_CMD` (optional custom live web-search command that returns JSON)

Implemented locally for stage 2:
- `website-brand-analysis`
- `brand-profile-db-contract`
- `campaign-planner`
- `head-of-marketing`
- `strategy-review-preview`

Implemented locally for stage 3:
- `creative-director`
- `page-designer`
- `scriptwriter`
- `ad-designer`
- `veo-video-generator`
- `production-review-preview`

Stage-3 behavior:
- Wrappers cache step JSON and text artifacts under `/tmp/lobster-stage3-cache/<run_id>/`.
- `creative-director --mode preflight` converts the Stage-2 `strategy_handoff` into a production brief.
- `creative-director --mode finalize` compiles a production handoff from cached stage-3 artifacts after review approval, including static contract handoffs for stage 4 rendering/publishing.
- `ad-designer` renders the platform × family static creative matrix concurrently. `LOBSTER_IMAGE_PARALLELISM` caps image render worker threads and defaults to `6`.
- `veo-video-generator` now defaults to contract-generation-only: it writes a master video contract, platform index, eight normalized platform contracts, and per-platform creative briefs under `output/video-contracts/<campaign_id>/`, but does not render media.
- When `LOBSTER_MEDIA_GATEWAY_ENABLED=1` and `OPENCLAW_GATEWAY_URL` / `OPENCLAW_GATEWAY_TOKEN` are set, `ad-designer` and `veo-video-generator` route Stage-3/4 media generation through the OpenClaw gateway tools instead of calling provider APIs directly:
  - images use OpenClaw `image_generate` and preserve the existing `image_path` / `nano_banana` artifact shape;
  - videos use OpenClaw `video_generate` and preserve the existing video output path shape;
  - OpenClaw owns provider selection and OAuth/subscription-backed auth such as OpenAI Codex image/video subscriptions and Gemini CLI OAuth.
- Gateway media mode is fail-closed by default. If the gateway is enabled but `image_generate` / `video_generate` fails, Lobster records/raises the gateway failure rather than silently falling back to direct Gemini/Veo. For local development only, set `LOBSTER_MEDIA_GATEWAY_ALLOW_DIRECT_FALLBACK=1` to allow direct legacy fallback when `GEMINI_API_KEY` is also present.
- Gateway media mode also routes non-SVG image text QA through OpenClaw's `image` vision tool when direct `GEMINI_API_KEY` is unavailable, so generated image safety checks can use the same gateway-owned OAuth/provider configuration.
- By default, Lobster lets the gateway choose its configured media model. To pin a gateway-specific model without affecting direct legacy Gemini/Veo fallback, set `LOBSTER_GATEWAY_IMAGE_MODEL` or `LOBSTER_GATEWAY_VIDEO_MODEL`; `OPENCLAW_IMAGE_GENERATION_MODEL` and `OPENCLAW_VIDEO_GENERATION_MODEL` are also honored as gateway model defaults. `LOBSTER_VIDEO_MODEL` remains the direct Veo fallback model and is not forwarded to the gateway unless one of the gateway-specific overrides is set.
- Run `OPENCLAW_GATEWAY_URL=http://127.0.0.1:3456 LOBSTER_SMOKE_IMAGE_PROMPT='<real prompt from campaign/personality evidence>' LOBSTER_SMOKE_SKIP_VIDEO=1 python scripts/smoke-openclaw-media-gateway.py` for a local gateway smoke test. Add `LOBSTER_SMOKE_VIDEO_PROMPT='<real video prompt from campaign/personality evidence>'` and remove `LOBSTER_SMOKE_SKIP_VIDEO=1` to exercise video. The smoke script intentionally has no synthetic test-data prompt fallback.
- Gateway-returned local media paths are copied only from allowlisted shared roots. Set `LOBSTER_MEDIA_GATEWAY_SHARED_ROOTS` to a colon-separated root list when Aries and OpenClaw share a filesystem; otherwise prefer gateway-returned HTTPS media URLs and optionally restrict them with `LOBSTER_MEDIA_GATEWAY_ALLOWED_HOSTS`.
- When `LOBSTER_VIDEO_RENDER_ENABLED=1` opens the video render gate, `veo-video-generator` dispatches render jobs concurrently by supported render aspect and family. `LOBSTER_VIDEO_PARALLELISM` caps render worker threads and defaults to `2`.

Implemented locally for stage 4:
- performance-marketer
- launch-review-preview
- meta-ads-publisher
- instagram-publisher
- x-publisher
- tiktok-publisher
- youtube-publisher
- linkedin-publisher
- reddit-publisher

Stage-4 behavior:
- Static publishers render deterministic final SVG creative files and copy payloads from stage-3 static contracts under `output/publish-ready/<campaign_id>/<platform>/`.
- Every publisher also writes a tenant-scoped Aries review package under `output/aries-review/<tenant_profile_id>/<campaign_id>/<platform>/review-package.json`.
- Video publishers can execute real render commands only when explicitly requested; otherwise they surface the stage-3 video contracts without starting a render.
- Optional live integrations can be attached with env vars:
  - `ARIES_REVIEW_POST_CMD` receives the review package JSON on stdin.
  - `LOBSTER_DRAFT_PUBLISH_CMD` receives a draft-publish payload on stdin for all platforms.
  - `LOBSTER_<PLATFORM>_DRAFT_PUBLISH_CMD` overrides the generic draft hook for one platform, for example `LOBSTER_META_ADS_DRAFT_PUBLISH_CMD`.
- `LOBSTER_VIDEO_RENDER_CMD` receives a render payload on stdin for video platforms.
- `LOBSTER_<PLATFORM>_RENDER_CMD` overrides the generic video render hook for a specific platform.
- Launch review remains a human approval step before the publisher wrappers execute.
