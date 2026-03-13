import fs from 'node:fs';
import path from 'node:path';

const explicitCodeRoot = process.env.CODE_ROOT?.trim();
const root = explicitCodeRoot ? path.resolve(explicitCodeRoot) : '/app';

const required = [
  'package.json',
  'tsconfig.json',
  '.env.example',
  'README-runtime.md',
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
  'app/api/marketing/jobs/[jobId]/approve/route.ts'
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

console.log(JSON.stringify({ ok: true, scripts: requiredScripts, endpoints: 5, screens: 5 }, null, 2));
