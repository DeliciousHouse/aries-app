# Stage 1 implementation notes

## Intended execution model

Stage 1 research should use:
- **Web search enabled** for research tasks
- **`gemini/gemini-2.5-flash`** as the default research model
- Meta Ads extraction with runtime-provided Meta credentials
- Explicit strict-mode behavior so the canonical pipeline fails when live research inputs are unavailable

## Required runtime inputs

Workflow args:
- `competitor`
- `competitor_facebook_url`
- `research_model` (default: `gemini/gemini-2.5-flash`)

Runtime env vars for Meta access:
- `META_ACCESS_TOKEN`
- `META_PAGE_ID`
- `META_APP_ID`

Optional runtime env vars for richer live research:
- `GEMINI_API_KEY` (for `gemini/gemini-2.5-flash` summarization)
- `LOBSTER_WEB_SEARCH_CMD` (custom search command returning JSON results)

## Current user-provided values

For the current task instance:
- `competitor_facebook_url`: `https://www.facebook.com/profile.php?id=61584146363668`
- `META_PAGE_ID`: `1002997576221948`
- `META_APP_ID`: `61587200554034`

## Security note

Do **not** hardcode `META_ACCESS_TOKEN` into committed workflow files. Pass it via environment at runtime.

## Strict live research contract (implemented)

- `meta-ads-extractor`:
  - Live path: tries web search, Meta Graph object lookups, and Gemini summarization.
  - Strict path: fails explicitly if no live source succeeds.
- Downstream wrappers (`meta-ads-analyser`, `ad-creative-analysis`, `ads-analyst`) consume upstream outputs and preserve whether the upstream run was live.

## Agent/task mapping

If you want the workflow to document who should do what, use this rule of thumb:
- Meta ad extraction / web-grounded competitor research → Gemini 2.5 Flash
- Later coding/implementation tasks outside the workflow → fresh Codex agents
