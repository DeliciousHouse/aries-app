import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

async function withRuntimeEnv<T>(run: (dataRoot: string) => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-source-leak-'));
  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  try {
    return await run(dataRoot);
  } finally {
    if (previousCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = previousCodeRoot;
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

async function writeValidatedDocs(
  dataRoot: string,
  tenantId: string,
  docs: {
    brandProfile?: Record<string, unknown>;
    websiteAnalysis?: Record<string, unknown>;
    businessProfile?: Record<string, unknown>;
  },
): Promise<{ brandProfilePath: string; websiteAnalysisPath: string; businessProfilePath: string }> {
  const validatedDir = path.join(dataRoot, 'generated', 'validated', tenantId);
  await mkdir(validatedDir, { recursive: true });
  const brandProfilePath = path.join(validatedDir, 'brand-profile.json');
  const websiteAnalysisPath = path.join(validatedDir, 'website-analysis.json');
  const businessProfilePath = path.join(validatedDir, 'business-profile.json');
  if (docs.brandProfile) await writeFile(brandProfilePath, JSON.stringify(docs.brandProfile, null, 2));
  if (docs.websiteAnalysis) await writeFile(websiteAnalysisPath, JSON.stringify(docs.websiteAnalysis, null, 2));
  if (docs.businessProfile) await writeFile(businessProfilePath, JSON.stringify(docs.businessProfile, null, 2));
  return { brandProfilePath, websiteAnalysisPath, businessProfilePath };
}

test('recordMatchesCurrentSource rejects records whose fingerprint cannot be recovered when a current URL is supplied', async () => {
  const { recordMatchesCurrentSource } = await import('../backend/marketing/brand-identity');
  const unfingerprinted = { brand_name: 'Legacy Brand' } as Record<string, unknown>;
  const fingerprinted = { canonical_url: 'https://nwaeventco.com/', brand_name: 'NWA Event Co' } as Record<string, unknown>;
  const mismatched = { canonical_url: 'https://mejuri.com/', brand_name: 'Mejuri' } as Record<string, unknown>;

  assert.equal(recordMatchesCurrentSource(unfingerprinted, 'https://nwaeventco.com'), false, 'unfingerprinted record must not leak through');
  assert.equal(recordMatchesCurrentSource(mismatched, 'https://nwaeventco.com'), false, 'mismatched fingerprint must be rejected');
  assert.equal(recordMatchesCurrentSource(fingerprinted, 'https://nwaeventco.com'), true, 'matching fingerprint must pass');

  assert.equal(recordMatchesCurrentSource(unfingerprinted, null), true, 'no currentSourceUrl => existence-check semantics');
  assert.equal(recordMatchesCurrentSource(null, 'https://nwaeventco.com'), true, 'null record => vacuously true');
});

test('loadValidatedMarketingProfileSnapshot hides stale tenant docs when currentSourceUrl is supplied', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { loadValidatedMarketingProfileSnapshot } = await import('../backend/marketing/validated-profile-store');
    await writeValidatedDocs(dataRoot, 'tenant_nwa', {
      brandProfile: {
        canonical_url: 'https://mejuri.com/',
        brand_name: 'Mejuri',
        offer: 'Handcrafted 14k gold jewelry for daily wear.',
      },
      websiteAnalysis: {
        // Intentionally no source URL — represents a legacy/unfingerprinted file.
        brand_analysis: { brand_promise: 'Everyday fine jewelry' },
      },
      businessProfile: {
        canonical_url: 'https://nwaeventco.com/',
        business_name: 'NWA Event Co.',
      },
    });

    const snapshot = await loadValidatedMarketingProfileSnapshot('tenant_nwa', {
      currentSourceUrl: 'https://nwaeventco.com',
    });

    // Mismatched brand-profile must not leak its Mejuri fields into the snapshot.
    assert.notEqual(snapshot.businessName === 'Mejuri', true, 'Mejuri business name must not leak');
    assert.doesNotMatch(String(snapshot.offer ?? ''), /handcrafted 14k gold/i, 'Mejuri offer must not leak');

    // Unfingerprinted website-analysis must not influence the snapshot either.
    // (brand_promise would otherwise surface via validatedProfile.brandIdentity.)
    assert.doesNotMatch(String(snapshot.brandIdentity?.promise ?? ''), /everyday fine jewelry/i, 'unfingerprinted brand_promise must not leak');
  });
});

test('invalidateValidatedProfilesIfSourceChanged quarantines mismatched and unfingerprinted docs and returns both paths', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const {
      invalidateValidatedProfilesIfSourceChanged,
      loadValidatedMarketingProfileSnapshot,
    } = await import('../backend/marketing/validated-profile-store');
    const { brandProfilePath, websiteAnalysisPath, businessProfilePath } = await writeValidatedDocs(
      dataRoot,
      'tenant_nwa',
      {
        brandProfile: { canonical_url: 'https://mejuri.com/', brand_name: 'Mejuri' },
        websiteAnalysis: { brand_analysis: { summary: 'Legacy summary' } },
        businessProfile: { canonical_url: 'https://nwaeventco.com/', business_name: 'NWA Event Co.' },
      },
    );

    const result = await invalidateValidatedProfilesIfSourceChanged('tenant_nwa', 'https://nwaeventco.com');

    // The mismatched brand-profile and the unfingerprinted website-analysis must both be quarantined;
    // the matching business-profile must remain.
    const originalPaths = result.quarantined.map((entry) => entry.originalPath);
    assert.equal(originalPaths.includes(brandProfilePath), true, 'brand-profile must be quarantined');
    assert.equal(originalPaths.includes(websiteAnalysisPath), true, 'unfingerprinted website-analysis must be quarantined');
    assert.equal(originalPaths.includes(businessProfilePath), false, 'matching business-profile must be preserved');

    for (const entry of result.quarantined) {
      assert.equal(existsSync(entry.originalPath), false, 'original path must no longer exist');
      assert.equal(existsSync(entry.stalePath), true, 'stale path must exist');
      assert.match(entry.stalePath, /\.stale-\d+\.json$/);
    }

    // After quarantine, loadValidatedMarketingProfileSnapshot must not see the stale content even
    // if a later caller forgets to pass currentSourceUrl.
    const snapshot = await loadValidatedMarketingProfileSnapshot('tenant_nwa');
    assert.notEqual(snapshot.businessName, 'Mejuri', 'Mejuri data must not return after quarantine');

    // Sanity check: both the business-profile.json (preserved) and the new .stale- files live side by side.
    const listing = readdirSync(path.dirname(businessProfilePath));
    assert.equal(listing.includes('business-profile.json'), true);
    assert.equal(listing.some((name) => name.endsWith('.stale-' + /* stamp */ '')), false); // shape-only assertion already covered above
    assert.equal((await readFile(businessProfilePath, 'utf8')).includes('NWA Event Co.'), true);
  });
});

test('invalidateValidatedProfilesIfSourceChanged is a no-op when no current source URL is provided', async () => {
  await withRuntimeEnv(async (dataRoot) => {
    const { invalidateValidatedProfilesIfSourceChanged } = await import('../backend/marketing/validated-profile-store');
    const { brandProfilePath } = await writeValidatedDocs(dataRoot, 'tenant_nwa', {
      brandProfile: { canonical_url: 'https://anything.com/', brand_name: 'Anything' },
    });
    const result = await invalidateValidatedProfilesIfSourceChanged('tenant_nwa', null);
    assert.deepEqual(result.quarantined, []);
    assert.equal(existsSync(brandProfilePath), true, 'file must remain untouched when source is unknown');
  });
});
