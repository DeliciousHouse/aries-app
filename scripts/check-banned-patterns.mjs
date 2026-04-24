import fs from 'node:fs';
import path from 'node:path';

const explicitCodeRoot = process.env.CODE_ROOT?.trim();
const candidateRoot = explicitCodeRoot ? path.resolve(explicitCodeRoot) : null;
const root =
  candidateRoot && fs.existsSync(path.join(candidateRoot, 'package.json'))
    ? candidateRoot
    : process.cwd();
const files = [
  'SETUP.md',
  'ROUTE_MANIFEST.md',
  'WEBHOOK_MANIFEST.md',
  'app/documentation/page.tsx',
  'app/api-docs/page.tsx',
  'app/features/page.tsx',
  'frontend/donor/marketing/chrome.tsx',
  'frontend/donor/marketing/home-page.tsx',
];

const banned = [
  new RegExp('\\bn8n\\b', 'i'),
  /parity-stub/i,
  /placeholder response/i,
  /placeholder error/i,
  /not yet wired/i,
  /missing workflow wiring/i,
  /no contact workflow/i,
  /no waitlist workflow/i,
  /no event workflow/i,
  /intentionally disabled until/i,
];

const violations = [];
for (const rel of files) {
  const abs = path.join(root, rel);
  const text = fs.readFileSync(abs, 'utf8');
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const pattern of banned) {
      if (pattern.test(line)) {
        violations.push({ file: rel, line: index + 1, pattern: String(pattern), text: line.trim() });
      }
    }
  });
}

if (violations.length > 0) {
  console.error(JSON.stringify({ ok: false, violations }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, files_checked: files.length, banned_patterns: banned.length }, null, 2));
