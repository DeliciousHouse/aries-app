import { createHash, randomBytes } from 'node:crypto';

import type { DbProvider } from './oauth-db';
import {
  googleClientId,
  linkedInClientId,
  metaAppId,
  redditClientId,
  tikTokClientKey,
  xClientId,
} from './oauth-provider-runtime';

function base64Url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function createCodeVerifier(): string {
  return base64Url(randomBytes(32));
}

export function createCodeChallengeS256(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest());
}

function metaGraphVersion(): string {
  const raw = (process.env.META_GRAPH_API_VERSION || 'v21.0').trim();
  return raw.startsWith('v') ? raw : `v${raw}`;
}

export type BuildAuthorizeUrlInput = {
  provider: DbProvider;
  redirectUri: string;
  state: string;
  scopes: string[];
  codeVerifier?: string;
};

export function buildProviderAuthorizationUrl(input: BuildAuthorizeUrlInput): URL {
  const { provider, redirectUri, state, scopes, codeVerifier } = input;

  switch (provider) {
    case 'linkedin': {
      const clientId = linkedInClientId();
      if (!clientId) {
        throw new Error('linkedin_oauth_not_configured');
      }
      const url = new URL('https://www.linkedin.com/oauth/v2/authorization');
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      if (scopes.length > 0) {
        url.searchParams.set('scope', scopes.join(' '));
      }
      return url;
    }

    case 'x': {
      const clientId = xClientId();
      if (!clientId) {
        throw new Error('x_oauth_not_configured');
      }
      const url = new URL('https://twitter.com/i/oauth2/authorize');
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      if (scopes.length > 0) {
        url.searchParams.set('scope', scopes.join(' '));
      }
      if (codeVerifier) {
        url.searchParams.set('code_challenge', createCodeChallengeS256(codeVerifier));
        url.searchParams.set('code_challenge_method', 'S256');
      }
      return url;
    }

    case 'facebook': {
      const clientId = metaAppId();
      if (!clientId) {
        throw new Error('meta_oauth_not_configured');
      }
      const url = new URL(`https://www.facebook.com/${metaGraphVersion()}/dialog/oauth`);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('response_type', 'code');
      if (scopes.length > 0) {
        url.searchParams.set('scope', scopes.join(','));
      }
      return url;
    }

    case 'instagram':
      throw new Error('meta_oauth_not_supported');

    case 'youtube': {
      const clientId = googleClientId();
      if (!clientId) {
        throw new Error('google_oauth_not_configured');
      }
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('state', state);
      if (scopes.length > 0) {
        const mapped = scopes.map((s) =>
          s.startsWith('https://') ? s : `https://www.googleapis.com/auth/${s.replace(/^\.+/, '')}`,
        );
        url.searchParams.set('scope', mapped.join(' '));
      }
      url.searchParams.set('access_type', 'offline');
      url.searchParams.set('include_granted_scopes', 'true');
      return url;
    }

    case 'reddit': {
      const clientId = redditClientId();
      if (!clientId) {
        throw new Error('reddit_oauth_not_configured');
      }
      const url = new URL('https://www.reddit.com/api/v1/authorize');
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('state', state);
      url.searchParams.set('redirect_uri', redirectUri);
      if (scopes.length > 0) {
        url.searchParams.set('scope', scopes.join(' '));
      }
      url.searchParams.set('duration', 'permanent');
      return url;
    }

    case 'tiktok': {
      const clientKey = tikTokClientKey();
      if (!clientKey) {
        throw new Error('tiktok_oauth_not_configured');
      }
      const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
      url.searchParams.set('client_key', clientKey);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      if (scopes.length > 0) {
        url.searchParams.set('scope', scopes.join(' '));
      }
      return url;
    }

    default:
      throw new Error(`unsupported_provider:${String(provider)}`);
  }
}
