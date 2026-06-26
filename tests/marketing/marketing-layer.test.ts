import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMarketingLayerEnabled } from '@/backend/marketing/marketing-layer/marketing-layer-env';
import {
  findContentPackageCopy,
  resolveReelMarketingInputs,
} from '@/backend/marketing/marketing-layer/resolve-inputs';

test('isMarketingLayerEnabled: default OFF, truthy values ON', () => {
  assert.equal(isMarketingLayerEnabled({}), false);
  assert.equal(isMarketingLayerEnabled({ ARIES_MARKETING_LAYER_ENABLED: '0' }), false);
  assert.equal(isMarketingLayerEnabled({ ARIES_MARKETING_LAYER_ENABLED: 'false' }), false);
  for (const v of ['1', 'true', 'yes', 'on', 'ON', ' True ']) {
    assert.equal(isMarketingLayerEnabled({ ARIES_MARKETING_LAYER_ENABLED: v }), true, v);
  }
});

test('findContentPackageCopy: matches by post_number, else falls back to [0]', () => {
  const primary = {
    content_package: [
      { post_number: 1, hook: 'h1', cta: 'c1' },
      { post_number: 2, hook: 'h2', cta: 'c2' },
    ],
  };
  assert.equal(findContentPackageCopy(primary, { post_number: 2 }).hook, 'h2');
  assert.equal(findContentPackageCopy(primary, { placement: 1 }).hook, 'h1');
  // unknown post_number -> first entry
  assert.equal(findContentPackageCopy(primary, { post_number: 9 }).hook, 'h1');
  // no content_package -> empty
  assert.deepEqual(findContentPackageCopy({}, { post_number: 1 }), {});
});

test('resolveReelMarketingInputs: per-tenant copy + colors, no cross-tenant leakage', () => {
  const out = resolveReelMarketingInputs({
    entry: { hook: 'Hook line', body: 'A short value sentence. Extra ignored.', cta: 'Click here' },
    brandKit: {
      colors: { primary: '#d8475f', accent: '#a855f7' },
      brand_name: 'Acme',
      brand_url: 'https://acme.example.com/',
      // logo_file_path intentionally absent -> logoPath null (no fallback brand)
    },
  });
  assert.equal(out.copy.hook, 'Hook line');
  assert.equal(out.copy.value, 'A short value sentence'); // first sentence, no trailing dot
  assert.equal(out.copy.cta, 'Click here');
  assert.equal(out.copy.brandName, 'Acme');
  assert.equal(out.copy.url, 'acme.example.com'); // scheme + trailing slash stripped
  assert.equal(out.colors.primaryHex, '#d8475f');
  assert.equal(out.colors.accentHex, '#a855f7');
  assert.equal(out.logoPath, null);
});

test('resolveReelMarketingInputs: long tagline brand_name collapses to empty (logo carries brand)', () => {
  const out = resolveReelMarketingInputs({
    entry: { hook: 'x', body: '', cta: '' },
    brandKit: { brand_name: 'Marketing without a system is expensive. Aries gives you the system.' },
  });
  // never paint a random tagline word as the wordmark — empty, end-card shows logo
  assert.equal(out.copy.brandName, '');
});

test('resolveReelMarketingInputs: missing brand kit -> safe empty defaults', () => {
  const out = resolveReelMarketingInputs({ entry: {}, brandKit: null });
  assert.equal(out.copy.hook, '');
  assert.equal(out.copy.brandName, '');
  assert.equal(out.colors.primaryHex, null);
  assert.equal(out.logoPath, null);
});
