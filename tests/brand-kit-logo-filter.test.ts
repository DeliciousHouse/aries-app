import assert from 'node:assert/strict';
import test from 'node:test';

const BRAND_URL = 'https://theframex.com';

test('isLikelyFirstPartyLogo: same-domain URL is first-party', async () => {
  const { isLikelyFirstPartyLogo } = await import('../backend/marketing/brand-kit');
  assert.equal(
    isLikelyFirstPartyLogo('https://theframex.com/images/logo.svg', BRAND_URL),
    true,
  );
});

test('isLikelyFirstPartyLogo: subdomain of brand is first-party', async () => {
  const { isLikelyFirstPartyLogo } = await import('../backend/marketing/brand-kit');
  assert.equal(
    isLikelyFirstPartyLogo('https://cdn.theframex.com/assets/logo.png', BRAND_URL),
    true,
  );
});

test('isLikelyFirstPartyLogo: relative URL is first-party', async () => {
  const { isLikelyFirstPartyLogo } = await import('../backend/marketing/brand-kit');
  assert.equal(
    isLikelyFirstPartyLogo('/images/logo.png', BRAND_URL),
    true,
  );
});

test('isLikelyFirstPartyLogo: Vercel logotype badge is rejected', async () => {
  const { isLikelyFirstPartyLogo } = await import('../backend/marketing/brand-kit');
  assert.equal(
    isLikelyFirstPartyLogo('https://vercel.com/vercel-logotype-dark.svg', BRAND_URL),
    false,
  );
});

test('isLikelyFirstPartyLogo: Vercel logotype path pattern is rejected even on a CDN subdomain', async () => {
  const { isLikelyFirstPartyLogo } = await import('../backend/marketing/brand-kit');
  assert.equal(
    isLikelyFirstPartyLogo('https://assets.vercel.com/image/upload/vercel-logotype-dark.svg', BRAND_URL),
    false,
  );
});

test('isLikelyFirstPartyLogo: Vercel insights tracking pixel is rejected', async () => {
  const { isLikelyFirstPartyLogo } = await import('../backend/marketing/brand-kit');
  assert.equal(
    isLikelyFirstPartyLogo('https://cdn.vercel-insights.com/pixel.png', BRAND_URL),
    false,
  );
});

test('isLikelyFirstPartyLogo: powered-by-vercel path is rejected regardless of host', async () => {
  const { isLikelyFirstPartyLogo } = await import('../backend/marketing/brand-kit');
  assert.equal(
    isLikelyFirstPartyLogo('https://somecdn.example.com/badges/powered-by-vercel.svg', BRAND_URL),
    false,
  );
});

test('isLikelyFirstPartyLogo: Netlify badge is rejected', async () => {
  const { isLikelyFirstPartyLogo } = await import('../backend/marketing/brand-kit');
  assert.equal(
    isLikelyFirstPartyLogo('https://netlify.com/img/netlify-full-badge.svg', BRAND_URL),
    false,
  );
});

test('isLikelyFirstPartyLogo: unknown CDN host passes through', async () => {
  const { isLikelyFirstPartyLogo } = await import('../backend/marketing/brand-kit');
  assert.equal(
    isLikelyFirstPartyLogo('https://images.framexcdn.com/logo.svg', BRAND_URL),
    true,
  );
});

test('isLikelyFirstPartyLogo: facebook CDN is rejected', async () => {
  const { isLikelyFirstPartyLogo } = await import('../backend/marketing/brand-kit');
  assert.equal(
    isLikelyFirstPartyLogo('https://static.fbcdn.net/rsrc.php/logo.png', BRAND_URL),
    false,
  );
});
