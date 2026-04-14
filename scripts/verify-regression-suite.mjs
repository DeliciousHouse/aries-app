import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const explicitCodeRoot = process.env.CODE_ROOT?.trim();
const candidateRoot = explicitCodeRoot ? path.resolve(explicitCodeRoot) : null;
const repoRoot =
  candidateRoot && fs.existsSync(path.join(candidateRoot, 'package.json'))
    ? candidateRoot
    : process.cwd();
const tsxBin = path.join(repoRoot, 'node_modules', '.bin', 'tsx');

const baseEnv = {
  ...process.env,
  NODE_ENV: 'development',
  CODE_ROOT: repoRoot,
  APP_BASE_URL: 'https://aries.example.com',
  NEXTAUTH_URL: 'https://aries.example.com',
  AUTH_URL: 'https://aries.example.com',
  AUTH_TRUST_HOST: 'true',
};

const steps = [
  {
    name: 'public-route smoke tests',
    args: ['--test', 'tests/runtime-pages.test.ts'],
  },
  {
    name: 'banned-pattern assertions',
    args: ['--test', 'tests/verify-banned-patterns.test.ts'],
  },
  {
    name: 'repo-boundary guard',
    args: ['--test', 'tests/repo-boundary-guard.test.ts'],
  },
  {
    name: 'targeted marketing-flow smoke tests',
    args: ['--test', 'tests/marketing-flow-smoke.test.ts'],
  },
];

for (const [index, step] of steps.entries()) {
  console.log(`\n[verify ${index + 1}/${steps.length}] ${step.name}`);
  const result = spawnSync(tsxBin, step.args, {
    cwd: repoRoot,
    env: baseEnv,
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log('\nVerification suite passed.');
