import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const dockerfilePath = path.join(process.cwd(), 'Dockerfile');
const dockerfileSource = fs.readFileSync(dockerfilePath, 'utf8');

const requiredCopies = [
  '/app/auth.ts ./auth.ts',
  '/app/components ./components',
  '/app/hooks ./hooks',
  '/app/styles ./styles',
  '/app/types ./types',
  '/app/next.config.mjs ./next.config.mjs',
  '/app/postcss.config.mjs ./postcss.config.mjs',
  '/app/tailwind.config.ts ./tailwind.config.ts',
];

test('runtime image copies the repo-root sources required by the deployed Aries surfaces', () => {
  for (const expectedCopy of requiredCopies) {
    assert.match(
      dockerfileSource,
      new RegExp(`COPY --from=builder --chown=node:node ${expectedCopy.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}`),
      `Expected Dockerfile runner stage to copy ${expectedCopy}`,
    );
  }
});
