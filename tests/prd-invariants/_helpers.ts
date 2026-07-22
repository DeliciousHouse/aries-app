// PRD §20 invariant test helpers.
//
// These tests are intentionally read-mostly: they assert structural properties
// of the codebase against the PRD's canonical behavioral invariants
// (docs/product/aries-ai-prd.md §20).  Most invariants are best expressed as
// either (a) a forbidden-import / forbidden-call check against source files,
// or (b) a focused unit assertion against a single public function.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

/**
 * Walk a directory tree (synchronously) collecting every file path that ends
 * in one of the requested extensions.  Skips node_modules, .next, .git,
 * .worktrees, and any directory starting with a dot.
 */
export function walk(
  dir: string,
  extensions: readonly string[] = ['.ts', '.tsx'],
): string[] {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      if (entry === 'node_modules') continue;
      const full = join(current, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
      } else if (extensions.some((ext) => full.endsWith(ext))) {
        out.push(full);
      }
    }
  }
  return out;
}

export function repoRoot(): string {
  return REPO_ROOT;
}

export function repoPath(...segments: string[]): string {
  return join(REPO_ROOT, ...segments);
}

export function readRepoFile(...segments: string[]): string {
  return readFileSync(join(REPO_ROOT, ...segments), 'utf8');
}

export function rel(absolute: string): string {
  return relative(REPO_ROOT, absolute).split(sep).join('/');
}

/**
 * Search source files under `dir` for any line matching `pattern`.
 * Returns the list of "<relpath>:<line>: <text>" hits.  Ignores comments
 * (lines whose first non-whitespace characters are `//` or `*`).
 */
export function scanForPattern(
  dir: string,
  pattern: RegExp,
  options: { includeComments?: boolean } = {},
): string[] {
  const includeComments = options.includeComments === true;
  const files = walk(dir);
  const hits: string[] = [];
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!includeComments) {
        const trimmed = line.trimStart();
        if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      }
      if (pattern.test(line)) {
        hits.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  return hits;
}
