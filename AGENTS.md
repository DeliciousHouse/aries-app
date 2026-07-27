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
- Every pushed branch must have a corresponding draft pull request before the task is considered complete.
- Escalate high-risk, destructive, expensive, or scope-changing changes before acting.

## Truth order

1. Live runtime and test evidence
2. Repo and config truth
3. Durable memory
4. Inference

Do not let remembered context override the current repository.

## Startup sequence

1. Run `git fetch origin --prune` before any other git operation.
2. Create the branch/worktree only from fresh `origin/master`; the creation command must contain the literal string `origin/`, never a local ref.
3. Run `git rev-list --count HEAD..origin/master` before editing. If the distance is greater than 5, stop and rebase or recreate the worktree.
4. Run `npm run workspace:verify` when relevant.
5. Confirm the request belongs to `aries-app`.
6. Read the smallest set of repo files needed.
7. Act when the next step is clear, otherwise ask the narrowest unlocking question.

## Git and worktrees

- Immediately before pushing, re-fetch and `git rebase origin/master`; never merge master into a feature branch. Confirm the base distance is 0, run the canonical `npm run verify` gate, and use `--force-with-lease` after a rebase, never bare `--force`.
- Commit at logical checkpoints and never end a session with a dirty worktree. Uncommitted work has no reflog and cannot be recovered.
- The reviewer who merges a PR removes its worktree and local branch, fetches with `--prune`, and runs `git worktree prune`.

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
- When asked to refresh `TODOS.md` from `docs/plans/2026-05-08-aries-hermes-honcho-architecture.md`, align backlog bullets with what the plan still requires versus what is already wired in the repo.

## Learned Workspace Facts

- The current product direction is Hermes-native weekly social content: public UI should say posts, weekly posts, social content, or social media content, and avoid campaign except for Meta Ads API objects.
- Weekly social-content defaults are 7 days, 7 static posts, 1 image story, 6 image creatives, 1 video script, and 0 rendered videos.
- Social-content execution submits Hermes runs asynchronously. The standing Aries reconciler polls them to terminal completion and passes results through the idempotent ingestion handler; `/api/internal/hermes/runs` remains the secret-authenticated ingestion seam, but Hermes does not invoke the submitted callback URL.
- Hermes social-content workflows should use `social_content_weekly` with version `2026-05-social-content-weekly-v2`; new social-content code should not depend on Lobster/OpenClaw.
- Aries should pass abstract media-generation requests to Hermes; Hermes owns provider execution and raw OpenAI/ChatGPT token usage for weekly social content.
- Marketing research memory: when `ARIES_RESEARCH_ENABLED` is truthy (`1`, `true`, `yes`, or `on`), `runResearchStage` can submit Hermes work through `submitMarketingResearchMemoryJob` with idempotent, secret-authenticated callbacks at `/api/internal/aries-research/callback` (not the generic Hermes marketing run callback).
- Honcho access uses split JWTs in `HonchoHttpTransport`: `HONCHO_CONTROL_PLANE_JWT` for workspace create/delete, and `HONCHO_DATA_PLANE_JWT` for routine Honcho API calls when set (otherwise the control-plane token is used for all calls in dev).
- Onboarding Honcho memory seeds at most once per organization after the dashboard gate when `HONCHO_ENABLED` is truthy, tracked by `organizations.onboarding_memory_seeded_at`. `ARIES_RESEARCH_ENABLED` is the sub-gate for Hermes research dispatch only.
- Tenant admins can list research findings awaiting review via `GET /api/tenant/research/review-queue` (queued `queue_for_review` rows).
- Global `context-mode` is installed under `/home/node/.hermes/node`; Cursor hooks, MCP, and statusline configs should use `/home/node/.hermes/node/bin/context-mode` unless that bin directory is on `PATH`.
- `context-mode` is not a local `aries-app` dependency by default, so project-relative `node_modules/context-mode/...` config paths only work after a local install; global config files live under `$(npm root -g)/context-mode/...`.
- Cursor-visible skill duplication was cleaned up to canonical roots around `/home/node/.claude/skills`, `/home/node/.cursor/plugins/cache`, and `/home/node/.cursor/skills-cursor`; stale high UI counts usually require restarting Cursor to re-index.
