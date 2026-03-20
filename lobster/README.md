# OpenClaw Marketing Pipeline — YAML `.lobster` Workflows

This package rebuilds the marketing pipeline as actual YAML-based `.lobster` workflow files.

## Key corrections
- Uses `.lobster` workflow files, not `.json` wrappers.
- Uses documented YAML fields only: `name`, `args`, `steps`, `command`, `stdin`, `approval`, and `condition`.
- Does **not** rely on an undocumented nested `lobster:` field.
- Uses `lobster run <workflow>.lobster --args-json ...` as the composition mechanism between workflows.

## How to use this package
1. Put this folder under your repo, for example:
   `openclaw/marketing-team/lobster/`
2. Keep your OpenClaw `SKILL.md` files separate from these Lobster workflows.
3. Run the stage-specific workflows through Aries or directly via Lobster when debugging one checkpoint at a time.
4. Run from the `lobster/` directory so relative `./bin/...` and `./stage-*/...` paths resolve as written.

## Recommended wrapper pattern
Each leaf skill step should call a small local command that:
- reads JSON from stdin when needed
- runs the actual OpenClaw skill/tool flow
- prints JSON to stdout

Examples:
- `./bin/meta-ads-extractor --json`
- `./bin/website-brand-analysis --json`
- `./bin/meta-ads-publisher --json`

## Stage-1 research contract
The stage-1 workflow is intended to be explicit about research behavior:
- competitor research should be allowed to use **web search**
- the default research model should be **`gemini/gemini-2.5-flash`**
- the workflow should accept `competitor` and `competitor_facebook_url`
- stage-1 should remain competitor/campaign-only; website analysis belongs to stage-2
- Meta credentials should be supplied at runtime, not hardcoded into committed workflow files

Recommended runtime env vars:
- `META_ACCESS_TOKEN`
- `META_PAGE_ID`
- `META_APP_ID`

## Important note
These files are now in the correct Lobster format. Aries orchestrates them stage-by-stage and owns the approval checkpoints. Stage-4 publishers always generate real review packages and publish-ready artifacts for the selected platforms. Live draft publishing and video render execution only run when explicitly requested and when the corresponding runtime command is configured; otherwise the stage fails explicitly.
