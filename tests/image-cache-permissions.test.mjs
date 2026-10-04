import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Linux filesystem proof, without starting workers or connecting to production.
test('startup cache target is writable while .next remains read-only', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aries-cache-'));
  const next = path.join(root, '.next');
  const target = path.join(root, 'data', 'next-cache');
  try {
    mkdirSync(next);
    mkdirSync(path.dirname(target));
    symlinkSync(target, path.join(next, 'cache'));
    chmodSync(next, 0o555);
    const runtime = readFileSync(new URL('../scripts/start-runtime.mjs', import.meta.url), 'utf8');
    const code = runtime.slice(runtime.indexOf('const cacheDir ='), runtime.indexOf('/** @type'));
    assert.ok(code.includes('mkdirSync'), 'execute the shipped cache bootstrap');
    new Function('projectRoot', 'path', 'lstatSync', 'mkdirSync', 'readlinkSync', code)(root, path, lstatSync, mkdirSync, readlinkSync);
    const images = path.join(next, 'cache', 'images');
    mkdirSync(images);
    writeFileSync(path.join(images, 'optimized-image'), 'cache-test');
    assert.equal(readFileSync(path.join(target, 'images', 'optimized-image'), 'utf8'), 'cache-test');
    assert.equal(lstatSync(next).mode & 0o777, 0o555);
  } finally {
    chmodSync(next, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});
