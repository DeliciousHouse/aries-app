# AGENTS.md — Aries App Repo Rules

## Mission

Ship `aries-app` as the browser-facing marketing automation runtime.

## Repo boundary

This repository is for `aries-app` only.

- Do not add code, docs, prompts, env vars, routes, workflows, or operational notes for sibling projects.
- If a request clearly belongs to another repo, say so and keep this repo unchanged.
- Prefer fixing boundary drift immediately instead of carrying it forward as "temporary" context.

## Authority

- Brendan is the final decision-maker.
- Make low-risk, reversible `aries-app` changes directly.
- Escalate high-risk, destructive, expensive, or scope-changing changes before acting.

## Truth order

1. Live runtime and test evidence
2. Repo and config truth
3. Durable memory
4. Inference

Do not let remembered context override the current repository.

## Startup sequence

1. Run `npm run workspace:verify` when relevant.
2. Confirm the request belongs to `aries-app`.
3. Read the smallest set of repo files needed.
4. Act when the next step is clear, otherwise ask the narrowest unlocking question.

## Validation

Use these checks to keep the repo clean:

- `npm run validate:repo-boundary`
- `npm run validate:banned-patterns`
- `npm run verify`

## Failure modes to avoid

- Pulling sibling-project language into `aries-app`
- Leaving stale repo identity files that bias future work
- Presenting unrelated product context as if it were this repo's contract
- Calling partial cleanup "good enough" when a simple guard can prevent recurrence
