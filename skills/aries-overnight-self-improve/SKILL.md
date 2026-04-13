---
name: aries-overnight-self-improve
description: Pick one small additive improvement each night, ship it safely, validate it, and log it to the nightly build log plus daily memory.
---

# Aries Overnight Self-Improve

Nightly self-improvement build for `aries-app`. This automation should ship one small, production-safe improvement per night without inventing scope, drifting the UI, or touching protected/high-risk surfaces.

## Prerequisites
- Live candidate surfaces are available:
  - Project board: `/home/node/.openclaw/projects/shared/team/execution-tasks.json`
  - Feedback log: `data/feedback-processing-log.json`
  - Nightly build log: `data/nightly-build-log.json`
- Design skill exists at `skills/superdesign/SKILL.md`
- Build command is `npm run build`
- Runtime verification can use the currently running local stack if present; do not invent a restart target
- `memory/<YYYY-MM-DD>.md` is available for nightly logging

## Steps

### Step 1: Pick exactly one build target
Use this priority order and stop at the first safe candidate:
1. Bug fixes flagged during the day from `data/feedback-processing-log.json`
2. Board items in `ready` state that are additive, bounded, and do not require a human decision
3. Small UX improvements you can verify directly from the current codebase
4. New ideas only if a real ideas surface exists and the first three buckets are empty

Rules:
- Ship exactly one improvement
- Scope it to fit in roughly 15 to 20 minutes of focused agent work
- Skip anything involving secrets, auth, external APIs without approval, major refactors, deployment config, CI/CD, or behavior-changing rewrites
- Read `data/nightly-build-log.json` first and avoid repeating the last 5 nightly builds
- If no safe candidate exists, do not force one, log the skip truthfully instead

Before implementation, run:
```bash
node scripts/automations/overnight-self-improve.mjs
```
Use its output as candidate context, not as the final answer.

### Step 2: Read the design skill before any UI work
If the chosen improvement touches UI, read and follow:
- `skills/superdesign/SKILL.md`

Follow the design skill exactly:
- use the project’s tokens and patterns
- do not freestyle the UI
- match surrounding file style before editing

### Step 3: Build the improvement
- Write clean production-grade code
- Keep the change additive and bounded
- If the improvement touches an API contract, update both frontend and backend together
- No placeholder data, no TODO comments, no lorem ipsum
- Prefer the smallest truthful fix that materially improves the product

### Step 4: Validate
1. Run `npm run build`
2. Fix any build/type errors introduced by the change before finishing
3. Verify the relevant route, page, endpoint, or artifact directly when possible
4. Do not invent a service restart command; if a safe runtime surface is not already available, report runtime verification as unavailable

### Step 5: Log the result
Update `data/nightly-build-log.json` with one new build entry containing:
- `title` — descriptive, not vague
- `description` — minimum 50 characters
- `status` — `deployed` or `skipped`
- `date` — today’s date in America/Los_Angeles
- `track` — `aries-app`
- `files` — changed files list
- `verification` — build/runtime verification notes
- `notes` — why this choice won tonight

Also append a concise block to `memory/<YYYY-MM-DD>.md` with:
- chosen improvement or skip reason
- files touched
- build result
- verification result

### Step 6: Notify only if it matters
If the build is noteworthy, return a concise summary that includes:
- what was built
- where to see it
- why it matters

If the run is a skip, say so directly and include the blocking reason.

## Validate
- [ ] Exactly one improvement was built, or a truthful skip was recorded
- [ ] The last 5 nightly builds were checked to avoid repeats
- [ ] UI work read `skills/superdesign/SKILL.md` before edits
- [ ] `npm run build` passed before completion
- [ ] `data/nightly-build-log.json` was updated
- [ ] `memory/<YYYY-MM-DD>.md` was updated
- [ ] No protected/high-risk surface was changed without approval

## Error Handling
- If the top candidate needs human product judgment: skip it and log the reason
- If the chosen change grows beyond the nightly budget: stop, revert or narrow scope, and log the skip
- If build fails and cannot be repaired quickly: revert the incomplete change and log the failure truthfully
- If runtime verification is unavailable: report that explicitly instead of guessing
- If all safe candidates repeat the last 5 builds: skip and log candidate exhaustion

## Output Rule
Return only a concise operational summary covering: chosen item, status, files changed, build result, verification result, build log path, and memory log path.
