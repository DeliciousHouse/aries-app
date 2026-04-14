# TOOLS.md — Aries App Environment Notes

## Workspace

- Primary repo: `/home/node/openclaw/aries-app`
- Main docs: `README.md`, `README-runtime.md`, `SETUP.md`, `ROUTE_MANIFEST.md`

## Boundary reminder

Treat this checkout as `aries-app` only.

- Do not reuse sibling-project paths, prompts, or deployment notes here.
- If a task depends on another repo, call that out explicitly instead of folding it into `aries-app`.

## Runtime truth rules

When describing environment behavior, distinguish between:

- verified current state
- repo or config default
- remembered prior context
- inference

Do not upgrade remembered context into current repo truth without checking.

## Validation shortcuts

- `npm run validate:repo-boundary`
- `npm run validate:banned-patterns`
- `npm run verify`
