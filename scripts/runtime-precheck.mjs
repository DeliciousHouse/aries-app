import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function resolveGitRoot() {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim();
  } catch {
    return process.cwd();
  }
}

function looksLikeRepoRoot(candidate) {
  if (!candidate) {
    return false;
  }

  const resolved = path.resolve(candidate);
  return fs.existsSync(path.join(resolved, 'package.json')) && fs.existsSync(path.join(resolved, 'app'));
}

const explicitCodeRoot = process.env.CODE_ROOT?.trim();
const root = looksLikeRepoRoot(explicitCodeRoot)
  ? path.resolve(explicitCodeRoot)
  : looksLikeRepoRoot(process.cwd())
    ? process.cwd()
    : resolveGitRoot();

const required = [
  'package.json',
  'tsconfig.json',
  '.env.example',
  'VERSION',
  'auth.ts',
  'app/layout.tsx',
  'app/page.tsx',
  'app/onboarding/start/page.tsx',
  'app/onboarding/status/page.tsx',
  'app/marketing/new-job/page.tsx',
  'app/marketing/job-status/page.tsx',
  'app/marketing/job-approve/page.tsx',
  'app/api/onboarding/start/route.ts',
  'app/api/onboarding/status/[tenantId]/route.ts',
  'app/api/marketing/jobs/route.ts',
  'app/api/marketing/jobs/[jobId]/route.ts',
  'app/api/marketing/jobs/[jobId]/approve/route.ts',
  'components',
  'hooks',
  'styles',
  'types',
  'next.config.mjs',
  'postcss.config.mjs',
  'tailwind.config.ts',
];

const missing = required.filter((p) => !fs.existsSync(path.join(root, p)));

if (missing.length > 0) {
  console.error(JSON.stringify({ ok: false, missing }, null, 2));
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const scripts = pkg.scripts || {};
const requiredScripts = ['dev', 'build', 'start'];
const missingScripts = requiredScripts.filter((s) => !scripts[s]);

if (missingScripts.length > 0) {
  console.error(JSON.stringify({ ok: false, missingScripts }, null, 2));
  process.exit(1);
}

const providerEnv = {
  facebook: ['META_PAGE_ID', 'META_ACCESS_TOKEN'],
  instagram: ['META_PAGE_ID', 'META_ACCESS_TOKEN'],
  linkedin: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
  reddit: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'],
  tiktok: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'],
  x: ['X_CLIENT_ID', 'X_CLIENT_SECRET'],
  youtube: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
};

function envSet(name) {
  return typeof process.env[name] === 'string' && process.env[name].trim().length > 0;
}

const providerMisconfigurations = Object.entries(providerEnv).flatMap(([provider, names]) => {
  const missingProviderEnv = names.filter((name) => !envSet(name));
  const presentProviderEnvCount = names.length - missingProviderEnv.length;
  if (presentProviderEnvCount === 0) {
    return [];
  }

  const needsTokenEncryption = provider !== 'instagram' && provider !== 'facebook';
  const missingEnv =
    missingProviderEnv.length > 0
      ? missingProviderEnv
      : !needsTokenEncryption || envSet('OAUTH_TOKEN_ENCRYPTION_KEY')
        ? []
        : ['OAUTH_TOKEN_ENCRYPTION_KEY'];

  if (missingEnv.length === 0) {
    return [];
  }

  return [{ provider, missingEnv }];
});

if (providerMisconfigurations.length > 0) {
  console.error(JSON.stringify({ ok: false, providerMisconfigurations }, null, 2));
  process.exit(1);
}

const configuredProviders = Object.entries(providerEnv)
  .filter(([provider, names]) =>
    names.every((name) => envSet(name)) &&
    (provider === 'instagram' || provider === 'facebook' || envSet('OAUTH_TOKEN_ENCRYPTION_KEY'))
  )
  .map(([provider]) => provider);

console.log(
  JSON.stringify(
    { ok: true, scripts: requiredScripts, endpoints: 5, screens: 5, configuredProviders },
    null,
    2,
  ),
);
