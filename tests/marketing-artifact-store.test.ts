import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildMarketingAssetLibrary } from '../backend/marketing/asset-library';
import {
  hostOutputMount,
  artifactOutputRoots,
  resolveGeneratedAsset,
  stageCacheRoot,
} from '../backend/marketing/artifact-store';
import { createSocialContentJobRuntimeDocument } from '../backend/marketing/runtime-state';
import { resolvePublicMarketingArtifact } from '../backend/marketing/public-pages';

type EnvKey =
  | 'ARIES_HOST_ARTIFACT_OUTPUT_DIR'
  | 'ARIES_HOST_ARTIFACT_OUTPUT_MOUNT'
  | 'ARTIFACT_STAGE1_CACHE_DIR'
  | 'ARTIFACT_STAGE2_CACHE_DIR'
  | 'ARTIFACT_STAGE3_CACHE_DIR'
  | 'ARTIFACT_STAGE4_CACHE_DIR'
  | 'ARTIFACT_PIPELINE_LOCAL_CWD'
  | 'ARTIFACT_PIPELINE_CWD';

const ENV_KEYS: EnvKey[] = [
  'ARIES_HOST_ARTIFACT_OUTPUT_DIR',
  'ARIES_HOST_ARTIFACT_OUTPUT_MOUNT',
  'ARTIFACT_STAGE1_CACHE_DIR',
  'ARTIFACT_STAGE2_CACHE_DIR',
  'ARTIFACT_STAGE3_CACHE_DIR',
  'ARTIFACT_STAGE4_CACHE_DIR',
  'ARTIFACT_PIPELINE_LOCAL_CWD',
  'ARTIFACT_PIPELINE_CWD',
];

async function withEnv<T>(overrides: Partial<Record<EnvKey, string | undefined>>, run: () => Promise<T> | T): Promise<T> {
  const previous = new Map<EnvKey, string | undefined>();
  for (const key of ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides) as Array<[EnvKey, string | undefined]>) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await run();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('stageCacheRoot preserves Lobster stage cache env vars and tmp fallbacks', async () => {
  await withEnv(
    {
      ARTIFACT_STAGE1_CACHE_DIR: '/tmp/custom-stage-1',
      ARTIFACT_STAGE2_CACHE_DIR: '/tmp/custom-stage-2',
      ARTIFACT_STAGE3_CACHE_DIR: '/tmp/custom-stage-3',
      ARTIFACT_STAGE4_CACHE_DIR: '/tmp/custom-stage-4',
    },
    () => {
      assert.equal(stageCacheRoot(1), '/tmp/custom-stage-1');
      assert.equal(stageCacheRoot(2), '/tmp/custom-stage-2');
      assert.equal(stageCacheRoot(3), '/tmp/custom-stage-3');
      assert.equal(stageCacheRoot(4), '/tmp/custom-stage-4');
    },
  );

  await withEnv(
    {},
    () => {
      assert.equal(stageCacheRoot(1), path.join(tmpdir(), 'lobster-stage1-cache'));
      assert.equal(stageCacheRoot(2), path.join(tmpdir(), 'lobster-stage2-cache'));
      assert.equal(stageCacheRoot(3), path.join(tmpdir(), 'lobster-stage3-cache'));
      assert.equal(stageCacheRoot(4), path.join(tmpdir(), 'lobster-stage4-cache'));
    },
  );
});

test('hostOutputMount exposes the current container mount default', async () => {
  await withEnv({}, () => {
    assert.equal(hostOutputMount(), '/host-lobster-output');
  });

  await withEnv({ ARIES_HOST_ARTIFACT_OUTPUT_MOUNT: '/mnt/generated-output' }, () => {
    assert.equal(hostOutputMount(), '/mnt/generated-output');
  });
});

test('artifactOutputRoots includes legacy Lobster outputs and the host output mount', async () => {
  await withEnv(
    {
      ARTIFACT_PIPELINE_LOCAL_CWD: '/runtime/lobster',
      ARTIFACT_PIPELINE_CWD: '/gateway/lobster',
      ARIES_HOST_ARTIFACT_OUTPUT_MOUNT: '/host-lobster-output',
    },
    () => {
      assert.deepEqual(artifactOutputRoots(), [
        '/runtime/lobster/output',
        '/gateway/lobster/output',
        path.resolve('lobster', 'output'),
        '/host-lobster-output',
      ]);
    },
  );
});

test('resolveGeneratedAsset finds relative paths under stage cache roots', async () => {
  const stageRoot = await mkdtemp(path.join(tmpdir(), 'aries-stage-cache-'));
  const assetPath = path.join(stageRoot, 'run-123', 'creative.json');
  await mkdir(path.dirname(assetPath), { recursive: true });
  await writeFile(assetPath, '{"ok":true}');

  await withEnv(
    {
      ARTIFACT_STAGE3_CACHE_DIR: stageRoot,
    },
    () => {
      assert.equal(resolveGeneratedAsset(path.join('run-123', 'creative.json')), assetPath);
    },
  );
});

test('resolveGeneratedAsset remaps host lobster output paths to the container mount', async () => {
  const hostRoot = '/host/source/lobster/output';
  const mountRoot = await mkdtemp(path.join(tmpdir(), 'aries-host-output-'));
  const mountedAsset = path.join(mountRoot, 'images', 'ad.png');
  await mkdir(path.dirname(mountedAsset), { recursive: true });
  await writeFile(mountedAsset, 'png');

  await withEnv(
    {
      ARIES_HOST_ARTIFACT_OUTPUT_DIR: hostRoot,
      ARIES_HOST_ARTIFACT_OUTPUT_MOUNT: mountRoot,
    },
    () => {
      assert.equal(resolveGeneratedAsset('/host/source/lobster/output/images/ad.png'), mountedAsset);
    },
  );
});

test('resolveGeneratedAsset rejects paths outside configured artifact roots', async () => {
  await withEnv({}, () => {
    assert.equal(resolveGeneratedAsset('/etc/passwd'), null);
    assert.equal(resolveGeneratedAsset('../../../../etc/passwd'), null);
    assert.equal(resolveGeneratedAsset('run-123/../secret.json'), null);
  });
});

test('asset library does not read website analysis paths rejected by the artifact store', async () => {
  const stageRoot = await mkdtemp(path.join(tmpdir(), 'aries-safe-artifacts-'));
  const safeBrandBible = path.join(stageRoot, 'brand-bible.md');
  await writeFile(safeBrandBible, '# Safe brand bible');

  const unsafeRoot = await mkdtemp(path.join(tmpdir(), 'aries-unsafe-analysis-'));
  const unsafeAnalysis = path.join(unsafeRoot, 'analysis.json');
  await writeFile(
    unsafeAnalysis,
    JSON.stringify({
      brand_slug: 'unsafe-brand',
      artifacts: {
        brand_bible_markdown_path: safeBrandBible,
      },
    }),
  );

  const runtimeDoc = createSocialContentJobRuntimeDocument({
    jobId: 'job-unsafe-analysis',
    tenantId: 'tenant-unsafe-analysis',
    payload: { brandUrl: 'https://example.com' },
    brandKit: {
      source_url: 'https://example.com',
      canonical_url: 'https://example.com',
      brand_name: 'Example',
      logo_urls: [],
      colors: { primary: null, secondary: null, accent: null, palette: [] },
      font_families: [],
      external_links: [],
      extracted_at: new Date(0).toISOString(),
      brand_voice_summary: null,
      offer_summary: null,
      positioning: null,
      audience: null,
      tone_of_voice: null,
      style_vibe: null,
      path: path.join(stageRoot, 'brand-kit.json'),
    },
  });
  runtimeDoc.stages.strategy.outputs = {
    website_brand_analysis_path: unsafeAnalysis,
  };

  await withEnv(
    {
      ARTIFACT_STAGE1_CACHE_DIR: stageRoot,
    },
    async () => {
      const assets = await buildMarketingAssetLibrary(runtimeDoc.job_id, runtimeDoc);
      assert.equal(assets.some((asset) => asset.id === 'brand-bible-markdown'), false);
    },
  );
});

test('public marketing artifacts reject encoded-slash traversal outside output roots', async () => {
  const artifactRoot = await mkdtemp(path.join(tmpdir(), 'aries-public-lobster-'));
  const outputRoot = path.join(artifactRoot, 'output');
  await mkdir(path.join(outputRoot, 'public-brand'), { recursive: true });
  const escapedFile = path.join(artifactRoot, 'secret.txt');
  await writeFile(escapedFile, 'secret');

  await withEnv(
    {
      ARTIFACT_PIPELINE_LOCAL_CWD: artifactRoot,
    },
    () => {
      const artifact = resolvePublicMarketingArtifact('/public-brand%2f..%2f..%2fsecret.txt');
      assert.equal(artifact, null);
    },
  );
});
