import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';

const canonicalRoot = path.resolve(process.env.ARIES_CANONICAL_REPO_ROOT || '/home/bkam/docker-stack/aries-app');
const paperclipRoot = path.resolve(
  process.env.ARIES_PAPERCLIP_WORKSPACES_ROOT || '/home/bkam/.paperclip/instances/default/workspaces'
);

function runGit(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function safeGit(cwd, args) {
  try {
    return runGit(cwd, args);
  } catch {
    return null;
  }
}

const canonicalHead = safeGit(canonicalRoot, ['rev-parse', 'HEAD']);
const canonicalBranch = safeGit(canonicalRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
const entries = [];

for (const workspaceId of readdirSync(paperclipRoot)) {
  const workspacePath = path.join(paperclipRoot, workspaceId);
  const repoPath = path.join(workspacePath, 'aries-app');

  if (path.resolve(workspacePath) === canonicalRoot || path.resolve(repoPath) === canonicalRoot) {
    continue;
  }

  if (existsSync(path.join(repoPath, '.git'))) {
    const head = safeGit(repoPath, ['rev-parse', 'HEAD']);
    const branch = safeGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const statusOutput = safeGit(repoPath, ['status', '--short']) || '';
    const dirtyFiles = statusOutput
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^[A-Z? ]+/, '').trim());

    let classification = 'canonical_match';
    if (head !== canonicalHead && dirtyFiles.length > 0) {
      classification = 'dirty_recovery_candidate';
    } else if (head !== canonicalHead) {
      classification = 'stale_clone';
    } else if (dirtyFiles.length > 0) {
      classification = 'dirty_recovery_candidate';
    }

    entries.push({
      workspaceId,
      path: repoPath,
      classification,
      branch,
      head,
      dirtyFiles,
    });
    continue;
  }

  if (existsSync(workspacePath)) {
    entries.push({
      workspaceId,
      path: workspacePath,
      classification: 'agent_home_only',
      branch: null,
      head: null,
      dirtyFiles: [],
    });
  }
}

console.log(JSON.stringify({
  canonical: {
    path: canonicalRoot,
    branch: canonicalBranch,
    head: canonicalHead,
  },
  workspaces: entries.sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)),
}, null, 2));
