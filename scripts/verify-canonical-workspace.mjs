import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const expectedRoot = process.env.ARIES_CANONICAL_REPO_ROOT || '/home/node/openclaw/aries-app';
const requiredMarkers = ['package.json', 'README-runtime.md', 'app', 'backend', 'tests'];

function fail(message) {
  console.error(`workspace verification failed: ${message}`);
  process.exit(1);
}

let gitRoot;
try {
  gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim();
} catch (error) {
  fail(`unable to resolve git root from ${process.cwd()}: ${error instanceof Error ? error.message : String(error)}`);
}

function hasRequiredMarkers(candidateRoot) {
  return requiredMarkers.every((marker) => existsSync(path.join(candidateRoot, marker)));
}

function resolveCanonicalRoot() {
  const explicitRoot = process.env.ARIES_CANONICAL_REPO_ROOT?.trim();
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }

  const defaultRoot = path.resolve(expectedRoot);
  if (hasRequiredMarkers(defaultRoot)) {
    return defaultRoot;
  }

  return path.resolve(gitRoot);
}

const normalizedExpected = resolveCanonicalRoot();
const normalizedGitRoot = path.resolve(gitRoot);
const normalizedCwd = path.resolve(process.cwd());

if (normalizedGitRoot !== normalizedExpected) {
  fail(`git root ${normalizedGitRoot} does not match canonical root ${normalizedExpected}`);
}

if (!(normalizedCwd === normalizedExpected || normalizedCwd.startsWith(`${normalizedExpected}${path.sep}`))) {
  fail(`cwd ${normalizedCwd} is outside canonical root ${normalizedExpected}`);
}

for (const marker of requiredMarkers) {
  if (!existsSync(path.join(normalizedExpected, marker))) {
    fail(`missing required marker ${marker} in ${normalizedExpected}`);
  }
}

console.log(JSON.stringify({
  ok: true,
  cwd: normalizedCwd,
  gitRoot: normalizedGitRoot,
  canonicalRoot: normalizedExpected,
  requiredMarkers,
}, null, 2));
