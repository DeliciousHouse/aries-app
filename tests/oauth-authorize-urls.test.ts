import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProviderAuthorizationUrl } from '../backend/integrations/oauth-authorize-urls';
import type { ProviderKey } from '../backend/integrations/provider-registry';

const OAUTH_ENV_KEYS = [
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'LINKEDIN_CLIENT_ID',
  'LINKEDIN_CLIENT_SECRET',
  'META_APP_ID',
  'META_APP_SECRET',
  'META_AD_ACCOUNT_ID',
  'META_ACCESS_TOKEN',
  'META_PAGE_ID',
  'REDDIT_CLIENT_ID',
  'REDDIT_CLIENT_SECRET',
  'TIKTOK_CLIENT_KEY',
  'TIKTOK_CLIENT_SECRET',
  'X_CLIENT_ID',
  'X_CLIENT_SECRET',
  'YOUTUBE_CLIENT_ID',
] as const;

function withOauthEnv(
  values: Partial<Record<(typeof OAUTH_ENV_KEYS)[number], string>>,
  fn: () => void
): void {
  const previous = new Map<string, string | undefined>();
  for (const key of OAUTH_ENV_KEYS) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }

  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }

  try {
    fn();
  } finally {
    for (const key of OAUTH_ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

const providerCases: Array<{
  provider: ProviderKey;
  missingError: string;
  presentEnv: Partial<Record<(typeof OAUTH_ENV_KEYS)[number], string>>;
  expectedOrigin: string;
  expectedQueryKey: 'client_id' | 'client_key';
  expectedClientValue: string;
  scopes: string[];
  codeVerifier?: string;
}> = [
  {
    provider: 'facebook',
    missingError: 'meta_oauth_not_configured',
    presentEnv: { META_APP_ID: 'meta-app-id' },
    expectedOrigin: 'https://www.facebook.com',
    expectedQueryKey: 'client_id',
    expectedClientValue: 'meta-app-id',
    scopes: ['pages_manage_posts'],
  },
  {
    provider: 'linkedin',
    missingError: 'linkedin_oauth_not_configured',
    presentEnv: { LINKEDIN_CLIENT_ID: 'linkedin-client-id' },
    expectedOrigin: 'https://www.linkedin.com',
    expectedQueryKey: 'client_id',
    expectedClientValue: 'linkedin-client-id',
    scopes: ['w_member_social'],
  },
  {
    provider: 'x',
    missingError: 'x_oauth_not_configured',
    presentEnv: { X_CLIENT_ID: 'x-client-id' },
    expectedOrigin: 'https://twitter.com',
    expectedQueryKey: 'client_id',
    expectedClientValue: 'x-client-id',
    scopes: ['tweet.read'],
    codeVerifier: 'code_verifier_for_test',
  },
  {
    provider: 'youtube',
    missingError: 'google_oauth_not_configured',
    presentEnv: { GOOGLE_CLIENT_ID: 'google-client-id' },
    expectedOrigin: 'https://accounts.google.com',
    expectedQueryKey: 'client_id',
    expectedClientValue: 'google-client-id',
    scopes: ['https://www.googleapis.com/auth/youtube.upload'],
  },
  {
    provider: 'reddit',
    missingError: 'reddit_oauth_not_configured',
    presentEnv: { REDDIT_CLIENT_ID: 'reddit-client-id' },
    expectedOrigin: 'https://www.reddit.com',
    expectedQueryKey: 'client_id',
    expectedClientValue: 'reddit-client-id',
    scopes: ['submit'],
  },
  {
    provider: 'tiktok',
    missingError: 'tiktok_oauth_not_configured',
    presentEnv: { TIKTOK_CLIENT_KEY: 'tiktok-client-key' },
    expectedOrigin: 'https://www.tiktok.com',
    expectedQueryKey: 'client_key',
    expectedClientValue: 'tiktok-client-key',
    scopes: ['video.publish'],
  },
];

for (const providerCase of providerCases) {
  test(`${providerCase.provider} authorize URL rejects missing required env`, () => {
    withOauthEnv({}, () => {
      assert.throws(
        () =>
          buildProviderAuthorizationUrl({
            provider: providerCase.provider,
            redirectUri: `https://aries.example.com/api/auth/oauth/${providerCase.provider}/callback`,
            state: 'state_valid_123',
            scopes: providerCase.scopes,
            codeVerifier: providerCase.codeVerifier,
          }),
        new RegExp(providerCase.missingError),
      );
    });
  });

  test(`${providerCase.provider} authorize URL uses canonical env names`, () => {
    withOauthEnv(providerCase.presentEnv, () => {
      const url = buildProviderAuthorizationUrl({
        provider: providerCase.provider,
        redirectUri: `https://aries.example.com/api/auth/oauth/${providerCase.provider}/callback`,
        state: 'state_valid_123',
        scopes: providerCase.scopes,
        codeVerifier: providerCase.codeVerifier,
      });

      assert.equal(url.origin, providerCase.expectedOrigin);
      assert.equal(url.searchParams.get(providerCase.expectedQueryKey), providerCase.expectedClientValue);
      assert.equal(
        url.searchParams.get('redirect_uri'),
        `https://aries.example.com/api/auth/oauth/${providerCase.provider}/callback`,
      );
    });
  });
}

test('instagram authorize URL is not exposed through the generic OAuth broker', () => {
    withOauthEnv({ META_PAGE_ID: 'meta-page-id', META_ACCESS_TOKEN: 'meta-access-token' }, () => {
      assert.throws(
        () =>
          buildProviderAuthorizationUrl({
            provider: 'instagram',
            redirectUri: 'https://aries.example.com/api/auth/oauth/instagram/callback',
            state: 'state_valid_123',
            scopes: ['instagram_content_publish'],
          }),
        /meta_oauth_not_supported/,
      );
    });
  });

test('youtube authorize URL ignores legacy YOUTUBE_CLIENT_ID fallback', () => {
  withOauthEnv({ YOUTUBE_CLIENT_ID: 'legacy-youtube-client-id' }, () => {
    assert.throws(
      () =>
        buildProviderAuthorizationUrl({
          provider: 'youtube',
          redirectUri: 'https://aries.example.com/api/auth/oauth/youtube/callback',
          state: 'state_valid_123',
          scopes: ['https://www.googleapis.com/auth/youtube.upload'],
        }),
      /google_oauth_not_configured/,
    );
  });
});
