# Ralph Agent Loop

Set up automated agent-driven development with Ralph. Run AI agents in a loop to implement features from user stories, verify acceptance criteria, and log progress for the next agent.

**Install via shadcn registry:**

```bash
bunx --bun shadcn@latest add https://fullstackrecipes.com/r/ralph.json
```

**Or copy the source code:**

`scripts/ralph/runner.ts`:

```typescript
#!/usr/bin/env bun

import { spawn } from "bun";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const promptPath = join(scriptDir, "prompt.md");

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    "max-iterations": { type: "string", default: "100" },
    prompt: { type: "string" },
  },
});

async function runRalph() {
  const baselinePrompt = await Bun.file(promptPath).text();

  const prompt = values.prompt
    ? `${values.prompt}\n\n---\n\n${baselinePrompt}`
    : baselinePrompt;

  const maxIterations = values["max-iterations"] || "100";

  // Escape the prompt for shell
  const escapedPrompt = prompt.replace(/'/g, "'\\''");

  // Use the official Ralph plugin via /ralph-loop command
  const ralphCommand = `/ralph-loop:ralph-loop '${escapedPrompt}' --completion-promise "FINISHED" --max-iterations ${maxIterations}`;

  console.log("[runner] Starting Ralph loop via Claude Code plugin...\n");
  console.log(`[runner] Max iterations: ${maxIterations}\n`);

  const proc = spawn({
    cmd: [
      "sh",
      "-c",
      `claude --permission-mode bypassPermissions --verbose '${ralphCommand.replace(/'/g, "'\\''")}'`,
    ],
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });

  await proc.exited;

  const exitCode = proc.exitCode ?? 0;
  if (exitCode === 0) {
    console.log("\n[runner] Ralph loop completed successfully!");
  } else {
    console.log(`\n[runner] Ralph loop exited with code ${exitCode}`);
  }

  process.exit(exitCode);
}

runRalph().catch((err) => {
  console.error("[runner] Error:", err);
  process.exit(1);
});
```

`scripts/ralph/prompt.md`:

```md
# Ralph Agent Task

Implement features from user stories until all are complete.

## Workflow Per Iteration

1. Read `scripts/ralph/log.md` to understand what previous iterations completed.

2. Search `docs/user-stories/` for features with `"passes": false`.

3. If no features remain with `"passes": false`:
   - Output: <promise>FINISHED</promise>

4. Pick ONE feature - the highest priority non-passing feature based on dependencies and logical order.

5. Implement the feature following TDD:
   - Write/update tests for the feature
   - Implement until all acceptance criteria pass
   - Generate and migrate DB schema if needed: `bun run db:generate && bun run db:migrate`
   - Format code: `bun run fmt`

6. Verify the feature:
   - Run typecheck: `bun run typecheck`
   - Run build: `bun run build`
   - Run tests: `bun run test`
   - Use Playwright MCP to interact with the app at `http://localhost:3000`

7. If verification fails, debug and fix. Repeat until passing.

8. Once verified:
   - Update the user story's `passes` property to `true`
   - Append to `scripts/ralph/log.md` (keep it short but helpful)
   - Commit with a descriptive message

9. The iteration ends here. The next iteration will pick up the next feature.

## Notes

- Dev server should be running on `http://localhost:3000`. Start with `bun run dev` if needed.
- Connected to test database - use migrate commands freely.
- Avoid interacting with database directly.

## Completion

When ALL user stories have `"passes": true`, output:

<promise>FINISHED</promise>
```

`scripts/ralph/log.md`:

```md
# Ralph Agent Log

This file tracks what each agent run has completed. Append your changes below.

---

## 2026-01-09 - Example Entry (Template)

**Task:** Brief description of the task or user story worked on

**Changes:**

- `src/components/example.tsx` - Added new component for X
- `src/lib/example/queries.ts` - Created query function for Y

**Status:** Completed | In Progress | Blocked

**Notes:** Any relevant context, blockers, or follow-up items

---
```

Ralph is a pattern for automated agent-driven development. It runs AI coding agents in a loop, where each agent picks up a user story, implements it, verifies it passes, and logs what it did for the next agent.

## Background & References

- [Ralph - Geoffrey Huntley](https://ghuntley.com/ralph/) - Original concept and implementation
- [Effective Harnesses for Long-Running Agents - Anthropic](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) - Engineering patterns for agent loops
- [Matt Pocock on Ralph](https://www.youtube.com/watch?v=_IK18goX4X8) - Video walkthrough

---

### Step 1: Add npm Script

Add a script to `package.json` to run Ralph:

```json
{
  "scripts": {
    "ralph": "bun run scripts/ralph/runner.ts"
  }
}
```

### Step 2: Install Claude Code CLI

Ralph uses the Claude Code CLI to spawn agent sessions. Install it globally:

```bash
npm install -g @anthropic-ai/claude-code
```

---

## Running Ralph

Start the dev server in one terminal, then run Ralph:

```bash
bun run dev
```

```bash
bun run ralph
```

Ralph will:

1. Read the prompt instructions
2. Check the log for previous work
3. Find a user story with `"passes": false`
4. Implement and verify the feature
5. Update the story to `"passes": true`
6. Log what it did
7. Repeat until all stories pass

To provide additional context or corrections:

```bash
bun run ralph --prompt "Focus on authentication features first"
```

---

## Story Categories

Add a `category` field to help Ralph prioritize work:

```json
{
  "category": "functional",
  "description": "User signs in with email and password",
  "steps": ["Navigate to /sign-in", "Enter credentials", "Verify redirect"],
  "passes": false
}
```

Categories:

- `functional` - Core feature behavior (highest priority)
- `edge-case` - Error handling and boundary conditions
- `integration` - Features that span multiple systems
- `ui` - Visual and interaction requirements