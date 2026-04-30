#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function gitMaybe(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

function log(message) {
  console.log(`[agent-guardrails] ${message}`);
}

function warn(message) {
  console.warn(`[agent-guardrails] WARNING: ${message}`);
}

function detectBaseBranch() {
  const prBase = spawnSync('gh', ['pr', 'view', '--json', 'baseRefName', '--jq', '.baseRefName'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (prBase.status === 0 && prBase.stdout.trim()) {
    return prBase.stdout.trim();
  }

  const originHead = gitMaybe(['symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (originHead?.startsWith('refs/remotes/origin/')) {
    return originHead.replace('refs/remotes/origin/', '');
  }

  if (gitMaybe(['rev-parse', '--verify', 'origin/master'])) {
    return 'master';
  }
  if (gitMaybe(['rev-parse', '--verify', 'origin/main'])) {
    return 'main';
  }
  return 'master';
}

function runGit(args) {
  const result = spawnSync('git', args, { stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(`git ${args.join(' ')} failed with exit code ${result.status ?? 1}`);
  }
}

function main() {
  const insideRepo = gitMaybe(['rev-parse', '--is-inside-work-tree']);
  if (insideRepo !== 'true') {
    throw new Error('pre-ship agent guardrails must run inside a git repository');
  }

  const currentBranch = git(['branch', '--show-current']) || '(detached)';
  const baseBranch = detectBaseBranch();

  log(`current branch: ${currentBranch}`);
  log(`base branch: ${baseBranch}`);

  // Keep this literal command visible for tests and future agents: git fetch origin ${baseBranch}
  runGit(['fetch', 'origin', baseBranch]);

  if (currentBranch === baseBranch) {
    throw new Error(`refusing to ship directly from base branch ${baseBranch}`);
  }

  const remoteBase = `origin/${baseBranch}`;
  const mergeBase = gitMaybe(['merge-base', 'HEAD', remoteBase]);
  if (!mergeBase) {
    warn(`no common ancestor found between HEAD and ${remoteBase}; branch may be on an orphaned history or already squash-merged`);
  }
  const ahead = gitMaybe(['rev-list', '--count', `${remoteBase}..HEAD`]) ?? '0';
  const behind = gitMaybe(['rev-list', '--count', `HEAD..${remoteBase}`]) ?? '0';
  const diffStat = gitMaybe(['diff', '--stat', `${remoteBase}...HEAD`]) ?? '';
  const uniqueCommits = gitMaybe(['log', '--oneline', '--cherry-pick', '--right-only', `${remoteBase}...HEAD`]) ?? '';
  const possibleDuplicateCommits = gitMaybe(['log', '--oneline', '--cherry-pick', '--left-only', `${remoteBase}...HEAD`]) ?? '';

  log(`merge-base: ${mergeBase ?? '(none)'}`);
  log(`ahead of ${remoteBase}: ${ahead}`);
  log(`behind ${remoteBase}: ${behind}`);

  if (Number(behind) > 0) {
    warn(`branch is ${behind} commit(s) behind ${remoteBase}; rebase or merge the latest base before final review when practical`);
  }

  if (!diffStat.trim() && Number(ahead) > 0) {
    warn('branch has commits but no effective diff against base; possible duplicate or already-landed work');
  }

  if (!uniqueCommits.trim() && Number(ahead) > 0) {
    warn('all branch commits appear patch-equivalent to base; duplicate work may already have landed');
  }

  if (possibleDuplicateCommits.trim()) {
    log('base-only cherry-pick comparison found commits on base not in branch:');
    console.log(possibleDuplicateCommits);
  }

  log('diff stat against latest remote base:');
  console.log(diffStat.trim() || '(no diff)');
  log('passed');
}

try {
  main();
} catch (error) {
  console.error(`[agent-guardrails] ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
