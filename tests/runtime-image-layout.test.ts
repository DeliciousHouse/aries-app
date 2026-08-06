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

test('runtime image bundles a commit-pinned Hermes CLI and proves it is invocable during build', () => {
  assert.match(
    dockerfileSource,
    /ARG HERMES_AGENT_REF=[0-9a-f]{40}/,
    'Hermes must be pinned to an immutable upstream commit',
  );
  assert.match(
    dockerfileSource,
    /python3 -m venv \/opt\/hermes/,
    'Hermes should live in an isolated image venv',
  );
  assert.match(
    dockerfileSource,
    /hermes-agent\/archive\/\$\{HERMES_AGENT_REF\}\.tar\.gz/,
    'the image must install the pinned Hermes source, not an unversioned latest release',
  );
  assert.match(dockerfileSource, /ENV PATH="\/opt\/hermes\/bin:\$\{PATH\}"/);
  assert.match(
    dockerfileSource,
    /RUN hermes --version/,
    'a missing or broken Hermes executable must fail the image build',
  );
});
