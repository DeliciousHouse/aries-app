import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProjectRoot } from './helpers/project-root';

// ISSUE-W2-L3 regression guard: any absolute asset path referenced — either
// directly as a string literal or via a `lib/brand.ts` constant — from
// `lib/brand.ts` or `app/layout.tsx` must resolve to a real file under
// `public/`. If this fails, the dashboard (and any page that renders these
// assets) will emit console 404s on load.

const repoRoot = resolveProjectRoot(import.meta.url);
const publicDir = path.join(repoRoot, 'public');
const brandPath = path.join(repoRoot, 'lib/brand.ts');
const layoutPath = path.join(repoRoot, 'app/layout.tsx');

const ASSET_LITERAL = /['"`](\/[A-Za-z0-9_\-./]+\.(?:svg|png|webp|ico|jpg|jpeg|gif|json|txt|xml))['"`]/g;

function extractLiteralAssetPaths(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(ASSET_LITERAL)) out.add(m[1]);
  return [...out];
}

function buildBrandConstMap(source: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /export\s+const\s+([A-Z0-9_]+)\s*=\s*['"`](\/[^'"`]+)['"`]/g;
  for (const m of source.matchAll(re)) map.set(m[1], m[2]);
  return map;
}

function resolveLayoutAssetPaths(layoutSource: string, constMap: Map<string, string>): string[] {
  const out = new Set<string>(extractLiteralAssetPaths(layoutSource));
  for (const [name, value] of constMap) {
    const re = new RegExp(`\\b${name}\\b`);
    if (re.test(layoutSource)) out.add(value);
  }
  return [...out];
}

function assertAllExist(paths: string[], sourceLabel: string): void {
  assert.ok(paths.length > 0, `expected to find at least one asset reference in ${sourceLabel}`);
  for (const p of paths) {
    const disk = path.join(publicDir, p.replace(/^\//, ''));
    assert.ok(existsSync(disk), `missing public asset for ${p} referenced from ${sourceLabel} (expected at ${disk})`);
  }
}

test('every hard-coded asset path in lib/brand.ts exists in public/', () => {
  const source = readFileSync(brandPath, 'utf8');
  assertAllExist(extractLiteralAssetPaths(source), 'lib/brand.ts');
});

test('every asset path referenced from app/layout.tsx (via literal or lib/brand.ts constant) exists in public/', () => {
  const layoutSource = readFileSync(layoutPath, 'utf8');
  const brandSource = readFileSync(brandPath, 'utf8');
  const constMap = buildBrandConstMap(brandSource);
  assertAllExist(resolveLayoutAssetPaths(layoutSource, constMap), 'app/layout.tsx');
});
