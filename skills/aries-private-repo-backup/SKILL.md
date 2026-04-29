---
name: aries-private-repo-backup
description: Stage current repo changes, commit to a backup branch, and create or update a backup PR on the private GitHub remote.
---

# Aries Private Repo Backup

Automated backup of the current workspace to a private GitHub repository via a backup branch and PR.

## Required procedure
1. Work in `/home/node/aries-app`.
2. Run:
   - `node scripts/automations/private-repo-backup.mjs`
3. Do not add extra narration around the result.
4. If the script succeeds, return only the concise summary emitted by the script.
5. If the script fails, return only the failure summary plus the next corrective action reported by the script.

## Steps

### Step 1: Verify environment
1. Confirm the backup remote exists and points to a GitHub URL.
2. Confirm the current branch can be resolved. If detached HEAD, check `ARIES_BACKUP_BASE_BRANCH`.
3. Run `gh auth setup-git` to ensure credential helper is wired.

### Step 2: Stage and detect changes
1. Run `git add -A` to stage everything.
2. Run `git diff --cached --name-status` to detect staged changes.
3. If no changes exist, report "nothing to back up" and exit cleanly.

### Step 3: Create backup commit on backup branch
1. Stash current work with a labeled stash (`aries-backup-<timestamp>`).
2. Switch to `backup/<base-branch>` (create if needed from base branch).
3. Apply the stash onto the backup branch.
4. Commit with message: `chore(backup): snapshot <timestamp> :: <count> file(s) :: <preview>`.

### Step 4: Push and manage PR
1. Push the backup branch with `--force-with-lease` (retry up to 3 attempts).
2. Check for an existing open PR from backup branch to base branch.
3. If PR exists: update title and body. If not: create a new PR.
4. Capture the PR URL.

### Step 5: Restore workspace
1. Switch back to the original base branch.
2. Pop the stash to restore the original working state.
3. If restore fails, report the restore warning alongside the backup result.

## Validate
- [ ] Backup branch was pushed to remote
- [ ] PR was created or updated with correct title and file list
- [ ] Original workspace was restored to pre-backup state
- [ ] Summary includes: remote, base branch, backup branch, commit message, PR URL, file count

## Error Handling
- If remote is not found: report and exit — do not attempt push
- If remote is not GitHub: report and exit — this automation targets GitHub only
- If detached HEAD and no `ARIES_BACKUP_BASE_BRANCH`: report and exit
- If git push fails after retries: report failure, note backup commit exists locally
- If workspace restore fails: report restore warning alongside any partial success
- All failures must restore the workspace before exiting

## Output Rule
Return only the script-produced operational summary. Do not wrap it in extra commentary.

## Script
```bash
node scripts/automations/private-repo-backup.mjs
```
