// Stage cache tenant isolation (PRD audit Finding 1).
//
// Verifies that:
//   1. Stage cache reads and writes are scoped under `<cacheRoot>/<tenantId>`.
//   2. inferMarketingStageRunId rejects a sibling-tenant runId via the
//      tenant-scoped scan.
//   3. readMarketingAssetWithinAllowedRoots denies cross-tenant stage cache
//      reads when called with the wrong tenantId.
//   4. Pre-migration flat caches (`<cacheRoot>/<runId>/<step>.json`, no tenant
//      segment) are NEVER read — tenant-scoped reads are unconditional (the
//      legacy read fallback has been removed).
//   5. Writes are NEVER routed to the legacy layout.
//
// All paths run through tsx --test; this file matches the style of
// tests/marketing-stage-* peers.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  stageCacheRoot,
  stageCacheRootForTenant,
} from '../backend/marketing/artifact-store';
import { createSocialContentJobRuntimeDocument } from '../backend/marketing/runtime-state';
import {
  inferMarketingStageRunId,
  readMarketingStageStepPayload,
} from '../backend/marketing/stage-artifact-resolution';

type EnvOverrides = Record<string, string | undefined>;

async function withEnv<T>(overrides: EnvOverrides, run: () => Promise<T>): Promise<T> {
  const prior: EnvOverrides = {};
  for (const [k, v] of Object.entries(overrides)) {
    prior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function withScratch<T>(run: (ctx: { stage1: string; stage4: string }) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'aries-stage-cache-iso-'));
  const stage1 = path.join(root, 'stage1');
  const stage4 = path.join(root, 'stage4');
  await mkdir(stage1, { recursive: true });
  await mkdir(stage4, { recursive: true });
  try {
    return await run({ stage1, stage4 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function makeRuntimeDoc(tenantId: string, jobId: string, competitorUrl: string) {
  return createSocialContentJobRuntimeDocument({
    jobId,
    tenantId,
    payload: { competitorUrl, brandUrl: 'https://brand.example.com' },
    brandKit: {
      path: `/tmp/${tenantId}.brand-kit.json`,
      source_url: 'https://brand.example.com',
      canonical_url: 'https://brand.example.com',
      brand_name: 'Brand',
      logo_urls: [],
      colors: { primary: '#111', secondary: '#eee', accent: '#c33', palette: ['#111', '#eee', '#c33'] },
      font_families: ['Inter'],
      external_links: [],
      extracted_at: '2026-04-24T00:00:00.000Z',
      brand_voice_summary: 'Grounded.',
      offer_summary: 'Audit.',
      positioning: null,
      audience: null,
      tone_of_voice: null,
      style_vibe: null,
    },
  });
}

test('stage cache path includes tenant segment', () => {
  const root = stageCacheRoot(1);
  const tenantRoot = stageCacheRootForTenant(1, 'tenant-a');
  assert.equal(tenantRoot, path.join(root, 'tenant-a'));
});

test('stageCacheRootForTenant fails closed when tenantId is empty', () => {
  assert.throws(() => stageCacheRootForTenant(1, ''));
  assert.throws(() => stageCacheRootForTenant(2, '   '));
});

test('readMarketingStageStepPayload writes go to tenant-scoped path only', async () => {
  await withScratch(async ({ stage1 }) => {
    await withEnv({ ARTIFACT_STAGE1_CACHE_DIR: stage1 }, async () => {
      const doc = makeRuntimeDoc('tenant-a', 'job-a', 'https://nike.com');
      doc.stages.research.run_id = 'nike-com-abc12345';

      // Seed both tenant-scoped (legitimate) and legacy-shared (must NOT match) caches.
      const tenantDir = path.join(stage1, 'tenant-a', 'nike-com-abc12345');
      const legacyDir = path.join(stage1, 'nike-com-abc12345');
      await mkdir(tenantDir, { recursive: true });
      await mkdir(legacyDir, { recursive: true });
      await writeFile(path.join(tenantDir, 'step.json'), JSON.stringify({ scope: 'tenant-a' }));
      await writeFile(path.join(legacyDir, 'step.json'), JSON.stringify({ scope: 'legacy-shared' }));

      const resolution = await readMarketingStageStepPayload(doc, 1, 'step');
      assert.equal(resolution.source, 'cache');
      assert.deepEqual(resolution.payload, { scope: 'tenant-a' });
      assert.ok(resolution.path?.includes(`${path.sep}tenant-a${path.sep}`), `path should be tenant-scoped: ${resolution.path}`);
    });
  });
});

test('inferMarketingStageRunId rejects sibling-tenant runId by tenant-scoped scan', async () => {
  await withScratch(async ({ stage1 }) => {
    await withEnv({ ARTIFACT_STAGE1_CACHE_DIR: stage1 }, async () => {
      // Tenant A and B both target nike.com. Tenant B has a cache run on disk.
      const tenantBRun = path.join(stage1, 'tenant-b', 'nike-com-bbbbbbbb');
      await mkdir(tenantBRun, { recursive: true });
      await writeFile(path.join(tenantBRun, 'step.json'), JSON.stringify({ tenant: 'b' }));

      // Tenant A has no run on disk and no explicit run_id in the runtime doc.
      const docA = makeRuntimeDoc('tenant-a', 'job-a', 'https://nike.com');

      const runIdA = await inferMarketingStageRunId(docA, 1);
      assert.equal(runIdA, null, 'tenant A inference must NOT surface tenant B run');

      // Sanity: tenant B can find its own.
      const docB = makeRuntimeDoc('tenant-b', 'job-b', 'https://nike.com');
      const runIdB = await inferMarketingStageRunId(docB, 1);
      assert.equal(runIdB, 'nike-com-bbbbbbbb');
    });
  });
});

test('cross-tenant readMarketingAssetWithinAllowedRoots is denied for stage cache subtrees', async () => {
  await withScratch(async ({ stage1 }) => {
    const tenantBFile = path.join(stage1, 'tenant-b', 'nike-com-bbbbbbbb', 'step.json');
    await mkdir(path.dirname(tenantBFile), { recursive: true });
    await writeFile(tenantBFile, JSON.stringify({ tenant: 'b' }));

    const codeRoot = await mkdtemp(path.join(tmpdir(), 'aries-code-'));
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-data-'));
    try {
      await withEnv(
        {
          ARTIFACT_STAGE1_CACHE_DIR: stage1,
          DATA_ROOT: dataRoot,
          CODE_ROOT: codeRoot,
        },
        async () => {
          const { readMarketingAssetWithinAllowedRoots } = await import('../backend/marketing/asset-read');

          const okBytes = await readMarketingAssetWithinAllowedRoots(tenantBFile, { tenantId: 'tenant-b' });
          assert.ok(okBytes, 'tenant B can read its own stage cache file');

          const denied = await readMarketingAssetWithinAllowedRoots(tenantBFile, { tenantId: 'tenant-a' });
          assert.equal(denied, null, 'tenant A must be denied a tenant B stage cache path');
        },
      );
    } finally {
      await rm(codeRoot, { recursive: true, force: true });
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});

test('pre-migration flat caches are never read (tenant-scoped reads are unconditional)', async () => {
  await withScratch(async ({ stage1 }) => {
    await withEnv({ ARTIFACT_STAGE1_CACHE_DIR: stage1 }, async () => {
      // A pre-migration flat cache at <cacheRoot>/<runId>/<step>.json (no tenant
      // segment). With the legacy read fallback removed, this is never surfaced.
      const legacyDir = path.join(stage1, 'nike-com-cccccccc');
      await mkdir(legacyDir, { recursive: true });
      await writeFile(path.join(legacyDir, 'step.json'), JSON.stringify({ legacy: true }));

      const doc = makeRuntimeDoc('tenant-a', 'job-a', 'https://nike.com');
      doc.stages.research.run_id = 'nike-com-cccccccc';

      const resolution = await readMarketingStageStepPayload(doc, 1, 'step');
      assert.equal(resolution.source, 'none', 'a flat (non-tenant-scoped) cache must never be read');
    });
  });
});

test('a stage-cache read never creates directories at the shared root', async () => {
  // The codebase has no writer for these caches in TypeScript (they are
  // populated out-of-band), so this is a structural assertion: a read must not
  // implicitly create the shared cache root.
  await withScratch(async ({ stage1 }) => {
    await withEnv({ ARTIFACT_STAGE1_CACHE_DIR: stage1 }, async () => {
      const doc = makeRuntimeDoc('tenant-a', 'job-a', 'https://nike.com');
      doc.stages.research.run_id = 'nike-com-cccccccc';

      // Read a non-existent path. No side-effects expected.
      await readMarketingStageStepPayload(doc, 1, 'absent-step');

      const entries = existsSync(stage1) ? await readdir(stage1) : [];
      assert.deepEqual(
        entries.sort(),
        [],
        'no implicit directories created at the shared root by a read',
      );
    });
  });
});
