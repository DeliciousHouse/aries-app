import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GET, HEAD } from '../app/[...publicPath]/route';

async function withPublicArtifactRoot<T>(run: (artifactRoot: string) => Promise<T>): Promise<T> {
  const previousPipelineLocalCwd = process.env.ARTIFACT_PIPELINE_LOCAL_CWD;
  const previousPipelineCwd = process.env.ARTIFACT_PIPELINE_CWD;
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'aries-public-generated-'));
  const artifactRoot = path.join(tempRoot, 'lobster');
  await mkdir(path.join(artifactRoot, 'output'), { recursive: true });

  process.env.ARTIFACT_PIPELINE_LOCAL_CWD = artifactRoot;
  process.env.ARTIFACT_PIPELINE_CWD = artifactRoot;

  try {
    return await run(artifactRoot);
  } finally {
    if (previousPipelineLocalCwd === undefined) delete process.env.ARTIFACT_PIPELINE_LOCAL_CWD;
    else process.env.ARTIFACT_PIPELINE_LOCAL_CWD = previousPipelineLocalCwd;
    if (previousPipelineCwd === undefined) delete process.env.ARTIFACT_PIPELINE_CWD;
    else process.env.ARTIFACT_PIPELINE_CWD = previousPipelineCwd;
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function seedPublicCampaign(artifactRoot: string) {
  const outputRoot = path.join(artifactRoot, 'output');
  const contractRoot = path.join(outputRoot, 'static-contracts', 'public-sugarandleather-com-stage2-plan');
  const campaignRoot = path.join(outputRoot, 'public-sugarandleather-com-campaign');

  await mkdir(path.join(contractRoot), { recursive: true });
  await mkdir(path.join(campaignRoot, 'landing-pages'), { recursive: true });
  await mkdir(path.join(campaignRoot, 'ad-images'), { recursive: true });

  await writeFile(
    path.join(contractRoot, 'landing-page.json'),
    JSON.stringify(
      {
        campaign_id: 'public-sugarandleather-com-stage2-plan',
        creative: {
          headline: 'Sugar & Leather campaign',
          primary_cta: 'Book Demo',
          proof_points: ['Handmade products', 'Thoughtful gifting'],
        },
        landing_page: {
          hero_headline: 'Sugar & Leather campaign',
          hero_subheadline: 'A real generated slug-backed landing page.',
          primary_cta: 'Book Demo',
          sections: ['Hero', 'Proof', 'CTA'],
          slug: '/public-sugarandleather-com/campaign',
        },
      },
      null,
      2
    )
  );

  await writeFile(
    path.join(campaignRoot, 'landing-pages', 'index.html'),
    [
      '<!doctype html><html><head><meta charset="utf-8" />',
      "<title>Sugar & Leather</title>",
      "<link rel='stylesheet' href='../../public-sugarandleather-com-design-system.css' />",
      '</head><body><main><h1>Sugar &amp; Leather</h1><img src="ad-images/meta-feed.png" alt="Meta ad" /></main></body></html>',
    ].join('')
  );

  await writeFile(
    path.join(outputRoot, 'public-sugarandleather-com-design-system.css'),
    'body{background:#1c1410;color:#fdf7ee;}'
  );

  await writeFile(
    path.join(campaignRoot, 'ad-images', 'meta-feed.png'),
    Buffer.from([0xff, 0xd8, 0xff, 0xe0])
  );
}

test('public generated campaign route serves compiled landing html for a matching slug', async () => {
  await withPublicArtifactRoot(async (artifactRoot) => {
    await seedPublicCampaign(artifactRoot);

    const response = await GET(new Request('http://localhost/public-sugarandleather-com/campaign'));
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(body, /Sugar &amp; Leather/);
    assert.match(body, /data-aries-design-system/);
    assert.match(body, /background:#1c1410/);
    assert.match(body, /<base href="\/public-sugarandleather-com\/campaign\/" \/>/);
  });
});

test('public generated campaign route serves relative campaign assets', async () => {
  await withPublicArtifactRoot(async (artifactRoot) => {
    await seedPublicCampaign(artifactRoot);

    const response = await GET(new Request('http://localhost/public-sugarandleather-com/campaign/ad-images/meta-feed.png'));
    const body = Buffer.from(await response.arrayBuffer());

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual([...body], [0xff, 0xd8, 0xff, 0xe0]);
  });
});

test('public generated campaign route serves direct design-system css artifacts', async () => {
  await withPublicArtifactRoot(async (artifactRoot) => {
    await seedPublicCampaign(artifactRoot);

    const response = await GET(new Request('http://localhost/public-sugarandleather-com-design-system.css'));
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/css; charset=utf-8');
    assert.match(body, /background:#1c1410/);
  });
});

test('public generated campaign route returns 404 when no artifact exists', async () => {
  await withPublicArtifactRoot(async () => {
    const response = await GET(new Request('http://localhost/public-missing-brand/campaign'));
    const body = await response.text();

    assert.equal(response.status, 404);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(body, /Page not found/);
  });
});

test('public generated campaign route supports HEAD for existing artifacts', async () => {
  await withPublicArtifactRoot(async (artifactRoot) => {
    await seedPublicCampaign(artifactRoot);

    const response = await HEAD(new Request('http://localhost/public-sugarandleather-com/campaign'));
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(body, '');
  });
});
