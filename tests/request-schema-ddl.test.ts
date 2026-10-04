import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

// Requests must work with DML grants alone, even when another role owns tables.
test('request modules never issue schema DDL', () => {
  function check(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) check(file);
      else if (/\.tsx?$/.test(file)) {
        assert.doesNotMatch(readFileSync(file, 'utf8'), /\b(?:ALTER\s+TABLE|CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX))\b/i, file);
      }
    }
  }
  for (const dir of ['app', 'backend', 'lib']) check(path.join(root, dir));
});

test('research schema is installed before requests in db:init', () => {
  const init = readFileSync(path.join(root, 'scripts/init-db.js'), 'utf8');
  for (const table of ['aries_research_jobs', 'aries_research_findings']) {
    assert.match(init, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
});

test('image cache uses writable data storage rather than baked-in ownership', () => {
  const dockerfile = readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /ln -s \/data\/next-cache \/app\/\.next\/cache/);
  const runtime = readFileSync(path.join(root, 'scripts/start-runtime.mjs'), 'utf8');
  assert.match(runtime, /mkdirSync\(path\.resolve\(path\.dirname\(cacheDir\), readlinkSync\(cacheDir\)\), \{ recursive: true \}\)/);
});
