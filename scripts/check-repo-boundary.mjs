import fs from 'node:fs';
import path from 'node:path';

const explicitCodeRoot = process.env.CODE_ROOT?.trim();
const candidateRoot = explicitCodeRoot ? path.resolve(explicitCodeRoot) : null;
const root =
  candidateRoot && fs.existsSync(path.join(candidateRoot, 'package.json'))
    ? candidateRoot
    : process.cwd();

const protectedEntries = [
  'AGENTS.md',
  'SOUL.md',
  'IDENTITY.md',
  'MEMORY.md',
  'TOOLS.md',
  'README.md',
  'SETUP.md',
  'ROUTE_MANIFEST.md',
  '.env.example',
  'package.json',
  'docker-compose.yml',
  'docker-compose.local.yml',
  'app',
  'backend',
  'components',
  'frontend',
  'lib',
  'scripts/check-banned-patterns.mjs',
  'scripts/init-db.js',
  'scripts/inventory-paperclip-workspaces.mjs',
  'scripts/runtime-precheck.mjs',
  'scripts/start-runtime.mjs',
  'scripts/verify-canonical-workspace.mjs',
  'scripts/verify-regression-suite.mjs',
  'tests',
];

const excludedFiles = new Set([
  'scripts/check-repo-boundary.mjs',
  'tests/repo-boundary-guard.test.ts',
]);

const ariesOsToken = ['aries', 'os'].join('-');
const missionControlHyphenToken = ['mission', 'control'].join('-');
const missionControlSpaceToken = ['mission', 'control'].join(' ');

const forbiddenPathSegment = new RegExp(`(^|[\\\\/])(${ariesOsToken}|${missionControlHyphenToken})(?=([\\\\/]|$))`, 'i');
const forbiddenContentPatterns = [
  { label: ariesOsToken, regex: new RegExp(`\\b${ariesOsToken}\\b`, 'i') },
  { label: missionControlHyphenToken, regex: new RegExp(`\\b${missionControlHyphenToken}\\b`, 'i') },
  { label: missionControlSpaceToken, regex: new RegExp(`\\b${missionControlSpaceToken}\\b`, 'i') },
];

function listFiles(relPath) {
  const absPath = path.join(root, relPath);
  if (!fs.existsSync(absPath)) {
    return [];
  }

  const stat = fs.statSync(absPath);
  if (stat.isFile()) {
    return [relPath];
  }

  return fs.readdirSync(absPath, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const childRelPath = path.join(relPath, entry.name);
      if (entry.isDirectory()) {
        return listFiles(childRelPath);
      }
      return [childRelPath];
    });
}

function readTextFile(relPath) {
  const text = fs.readFileSync(path.join(root, relPath), 'utf8');
  if (text.includes('\u0000')) {
    return null;
  }
  return text;
}

const files = protectedEntries
  .flatMap((entry) => listFiles(entry))
  .filter((relPath) => !excludedFiles.has(relPath.split(path.sep).join('/')));
const violations = [];

for (const relPath of files) {
  const normalizedPath = relPath.split(path.sep).join('/');

  if (forbiddenPathSegment.test(normalizedPath)) {
    violations.push({
      type: 'path',
      file: normalizedPath,
      pattern: 'forbidden project path segment',
    });
  }

  const text = readTextFile(relPath);
  if (text === null) {
    continue;
  }

  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const pattern of forbiddenContentPatterns) {
      if (pattern.regex.test(line)) {
        violations.push({
          type: 'content',
          file: normalizedPath,
          line: index + 1,
          pattern: pattern.label,
          text: line.trim(),
        });
      }
    }
  });
}

if (violations.length > 0) {
  console.error(JSON.stringify({ ok: false, violations }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, filesChecked: files.length }, null, 2));
