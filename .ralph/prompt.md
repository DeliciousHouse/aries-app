# Ralph loop driver — live QA 2026-04-27

Live site: https://aries.sugarandleather.com
Baseline deployed SHA: 880e4dccaac4aa89c21c4cd68bb2027e9999d62d
Branch: qa/live-20260427-ralph-loop

## Rules

- Fix the issues documented under `.ralph/user-stories/`.
- Use targeted regression tests for each fix where practical.
- Stage only files owned by your assigned story. Never use `git add -A`, `git add .`, or `git commit -a`.
- If the working tree contains sibling-agent edits, leave them alone.
- Do not push during development.
- Keep commits atomic by story.
- Prefer real Aries/Sugar & Leather context over synthetic QA examples. Do not hardcode fake business/person/media examples.
- For any fix with a primary path and fallback/error path, explicitly verify the fallback behavior.
- After each story, run the narrowest targeted test, then report files changed and commit SHA.

## Mandatory reviewer prompts

Quality reviewers must answer:

1. What does the fallback path return when the primary path is empty or failed?
2. Can lower-quality/error-state candidates crowd out higher-quality/valid candidates?
3. Is source-priority/auth-ordering applied before lookup/score-based behavior?
4. If the same fix pattern appears in two sibling functions, do they stay in sync?
5. Does the fix add accessible names/status text that match visible labels?
