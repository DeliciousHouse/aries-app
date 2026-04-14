---
name: aries-cron-builder
description: Create or update a cron-scheduled automation following the skill-first pattern. Use when adding a new cron job, converting an ad-hoc script to a scheduled job, or refactoring an existing cron.
---

# Aries Cron Builder

Use this skill whenever you need to create a new cron job or convert an existing script into a scheduled automation. It enforces the skill-first pattern so every cron job is clean, maintainable, and consistent.

## Before you start

Read these three reference files. They are the law:

1. **Rules:** `skills/_templates/cron-rules.md` — the 8 non-negotiable rules for cron/skill separation
2. **Cron prompt template:** `skills/_templates/cron-prompt.md.template` — how to write the cron's `--message`
3. **Skill template:** `skills/_templates/cron-skill.md.template` — how to structure the SKILL.md

Do not proceed until you have read all three.

## Steps

### Step 1: Define the workflow
1. Ask or determine: what does this automation do?
2. Identify the script it wraps (if any), or define the steps if no script exists yet.
3. Choose a skill name following the pattern: `aries-<descriptive-name>` for internal automations.

### Step 2: Create the SKILL.md
1. Create `skills/<skill-name>/SKILL.md` using `skills/_templates/cron-skill.md.template`.
2. Fill in every section: Prerequisites, Steps (numbered), Validate (checkboxes), Error Handling, Output Rule.
3. If the skill wraps a script, include a `## Script` section with the exact command.
4. The skill file owns ALL workflow logic. No logic goes in the cron prompt.

### Step 3: Add to the manifest
1. Open `scripts/automations/manifest.mjs`.
2. Add a new entry to the `automationJobs` array:
   ```js
   {
     id: '<skill-name>',
     name: '<Human-readable name>',
     cron: '<cron expression>',
     tz: 'America/Los_Angeles',
     skill: '<skill-name>',
     purpose: '<one-line purpose>',
   }
   ```
3. Every job MUST use the `skill` property. Never use `message` with inline logic.

### Step 4: Register in the skills index
1. Open `skills/index.json`.
2. Add the skill under category `automations`:
   ```json
   {
     "name": "<skill-name>",
     "category": "automations",
     "path": "skills/<skill-name>",
     "owner": "jarvis",
     "status": "active",
     "last_updated": "<YYYY-MM-DD>",
     "version": "1.0.0",
     "visibility": { "scope": "all", "agents": [] }
   }
   ```

### Step 5: Verify the cron prompt
1. Run `node scripts/automations/install-openclaw-crons.mjs` (without `--apply`) to preview the generated prompt.
2. Confirm the prompt follows the template:
   - First line: `Read and follow: <repo>/skills/<skill-name>/SKILL.md`
   - Context block with only relevant context lines
   - Total under 20 lines
3. Confirm no workflow logic leaked into the prompt.

### Step 6: Validate against the rules
Run through the 8 rules from `skills/_templates/cron-rules.md`:
- [ ] Cron prompt is under 20 lines
- [ ] First line is "Read and follow: [skill path]"
- [ ] Workflow logic lives in SKILL.md only
- [ ] No skill steps pasted into the cron
- [ ] One skill per workflow
- [ ] Cron has scheduling + context only, skill has workflow + logic only
- [ ] Job uses isolated session (`--session isolated`)
- [ ] Process changes go to the skill first

## Error Handling
- If a script doesn't exist yet: create the script first, then create the skill that wraps it
- If `skills/index.json` already has the skill: update the existing entry instead of duplicating
- If `manifest.mjs` already has the job ID: update the existing entry instead of duplicating
- If the generated cron prompt exceeds 20 lines: the skill is missing detail — move logic from cron to skill

## Output
When done, report:
- Skill file path
- Manifest entry (id, cron, tz)
- Skills index: confirmed registered
- Cron prompt preview: confirmed compliant
