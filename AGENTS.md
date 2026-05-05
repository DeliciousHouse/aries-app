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
- Make low-risk, reversible `aries-app` changes without prior escalation, but still use the normal branch/PR process.
- Push local work when it is ready for review, but never push directly to `master`.
- Every pushed branch must have a corresponding pull request created before the task is considered complete.
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

## Learned User Preferences

- When asked to implement an attached plan with existing todos, do not recreate todos; mark each existing todo in progress before working it and keep going until all are completed or clearly blocked.
- Do not summarize subagent results that are already visible to the user unless asked or unless multiple results need synthesis.

## Learned Workspace Facts

- The current product direction is Hermes-native weekly social content: public UI should say posts, weekly posts, social content, or social media content, and avoid campaign except for Meta Ads API objects.
- Weekly social-content defaults are 7 days, 3 static posts, up to 2 image creatives, 1 video script, and 0 rendered videos until explicit approval.
- Social-content execution should submit Hermes runs asynchronously and rely on authenticated, idempotent callbacks at `/api/internal/hermes/runs`; it should not poll Hermes to terminal completion.
- Hermes social-content workflows should use `social_content_weekly` with version `2026-05-social-content-weekly-v1`; new social-content code should not depend on Lobster/OpenClaw.
- Aries should pass abstract media-generation requests and OAuth connection references to Hermes; Hermes owns provider execution and raw OpenAI/ChatGPT token usage.
- Global `context-mode` is installed under `/home/node/.hermes/node`; Cursor hooks, MCP, and statusline configs should use `/home/node/.hermes/node/bin/context-mode` unless that bin directory is on `PATH`.
- `context-mode` is not a local `aries-app` dependency by default, so project-relative `node_modules/context-mode/...` config paths only work after a local install; global config files live under `$(npm root -g)/context-mode/...`.
- Cursor-visible skill duplication was cleaned up to canonical roots around `/home/node/.claude/skills`, `/home/node/.cursor/plugins/cache`, and `/home/node/.cursor/skills-cursor`; stale high UI counts usually require restarting Cursor to re-index.
