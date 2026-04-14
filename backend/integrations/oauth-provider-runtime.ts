import { PROVIDER_REGISTRY, type ProviderKey } from './provider-registry';

type ProviderEnvContract = {
  authEnv: string[];
  connectionMode: 'oauth' | 'env_managed';
};

export type ProviderOAuthAvailability = {
  provider: ProviderKey;
  displayName: string;
  available: boolean;
  connectable: boolean;
  missingEnv: string[];
  partiallyConfigured: boolean;
  callbackPath: string;
  message: string;
};

const SHARED_TOKEN_ENV = 'OAUTH_TOKEN_ENCRYPTION_KEY';

const PROVIDER_ENV_CONTRACT: Record<ProviderKey, ProviderEnvContract> = {
  facebook: { authEnv: ['META_PAGE_ID', 'META_ACCESS_TOKEN'], connectionMode: 'env_managed' },
  instagram: { authEnv: ['META_PAGE_ID', 'META_ACCESS_TOKEN'], connectionMode: 'env_managed' },
  linkedin: { authEnv: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'], connectionMode: 'oauth' },
  x: { authEnv: ['X_CLIENT_ID', 'X_CLIENT_SECRET'], connectionMode: 'oauth' },
  youtube: { authEnv: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'], connectionMode: 'oauth' },
  reddit: { authEnv: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET'], connectionMode: 'oauth' },
  tiktok: { authEnv: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'], connectionMode: 'oauth' },
};

function readEnv(name: string): string {
  return process.env[name]?.trim() || '';
}

function isEnvSet(name: string): boolean {
  return readEnv(name).length > 0;
}

function displayNameFor(provider: ProviderKey): string {
  return PROVIDER_REGISTRY[provider].display_name;
}

function providerAuthEnv(provider: ProviderKey): string[] {
  return PROVIDER_ENV_CONTRACT[provider].authEnv;
}

function providerConnectionMode(provider: ProviderKey): ProviderEnvContract['connectionMode'] {
  return PROVIDER_ENV_CONTRACT[provider].connectionMode;
}

function callbackPathFor(provider: ProviderKey): string {
  return `/api/auth/oauth/${provider}/callback`;
}

function buildMissingEnvMessage(provider: ProviderKey, missingEnv: string[]): string {
  if (provider === 'facebook' || provider === 'instagram') {
    return 'Meta publishing needs META_PAGE_ID and META_ACCESS_TOKEN.';
  }
  if (missingEnv.includes(SHARED_TOKEN_ENV)) {
    return 'Contact support to finish channel setup.';
  }
  return 'Publishing is not ready yet.';
}

function buildEnvManagedMessage(provider: ProviderKey): string {
  if (provider === 'facebook' || provider === 'instagram') {
    return 'Meta is configured outside Aries OAuth. Use META_PAGE_ID and META_ACCESS_TOKEN.';
  }
  return 'Contact support to finish channel setup.';
}

export function oauthTokenEncryptionKey(): string {
  return readEnv(SHARED_TOKEN_ENV);
}

export function metaPageId(): string {
  return readEnv('META_PAGE_ID');
}

export function metaAccessToken(): string {
  return readEnv('META_ACCESS_TOKEN');
}

export function metaAppId(): string {
  return readEnv('META_APP_ID');
}

export function metaAppSecret(): string {
  return readEnv('META_APP_SECRET');
}

export function metaAdAccountId(): string {
  return readEnv('META_AD_ACCOUNT_ID');
}

export function metaFacebookClientCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = metaAppId();
  const clientSecret = metaAppSecret();
  if (!clientId || !clientSecret) {
    return null;
  }
  return { clientId, clientSecret };
}

export function googleClientId(): string {
  return readEnv('GOOGLE_CLIENT_ID');
}

export function googleClientSecret(): string {
  return readEnv('GOOGLE_CLIENT_SECRET');
}

export function linkedInClientId(): string {
  return readEnv('LINKEDIN_CLIENT_ID');
}

export function linkedInClientSecret(): string {
  return readEnv('LINKEDIN_CLIENT_SECRET');
}

export function redditClientId(): string {
  return readEnv('REDDIT_CLIENT_ID');
}

export function redditClientSecret(): string {
  return readEnv('REDDIT_CLIENT_SECRET');
}

export function tikTokClientKey(): string {
  return readEnv('TIKTOK_CLIENT_KEY');
}

export function tikTokClientSecret(): string {
  return readEnv('TIKTOK_CLIENT_SECRET');
}

export function xClientId(): string {
  return readEnv('X_CLIENT_ID');
}

export function xClientSecret(): string {
  return readEnv('X_CLIENT_SECRET');
}

export function googleClientCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = googleClientId();
  const clientSecret = googleClientSecret();
  if (!clientId || !clientSecret) {
    return null;
  }
  return { clientId, clientSecret };
}

export function linkedInClientCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = linkedInClientId();
  const clientSecret = linkedInClientSecret();
  if (!clientId || !clientSecret) {
    return null;
  }
  return { clientId, clientSecret };
}

export function redditClientCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = redditClientId();
  const clientSecret = redditClientSecret();
  if (!clientId || !clientSecret) {
    return null;
  }
  return { clientId, clientSecret };
}

export function tikTokClientCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = tikTokClientKey();
  const clientSecret = tikTokClientSecret();
  if (!clientId || !clientSecret) {
    return null;
  }
  return { clientId, clientSecret };
}

export function xClientCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = xClientId();
  const clientSecret = xClientSecret();
  if (!clientId || !clientSecret) {
    return null;
  }
  return { clientId, clientSecret };
}

export function getProviderOAuthAvailability(provider: ProviderKey): ProviderOAuthAvailability {
  const connectionMode = providerConnectionMode(provider);
  const authEnv = providerAuthEnv(provider);
  const missingProviderEnv = authEnv.filter((name) => !isEnvSet(name));
  const presentProviderEnvCount = authEnv.length - missingProviderEnv.length;
  const tokenEnvMissing = connectionMode === 'oauth' && oauthTokenEncryptionKey().length === 0;
  const missingEnv =
    missingProviderEnv.length > 0 ? missingProviderEnv : tokenEnvMissing ? [SHARED_TOKEN_ENV] : [];
  const available = missingEnv.length === 0;
  const connectable = connectionMode === 'oauth' && available;
  const message =
    missingEnv.length > 0
      ? buildMissingEnvMessage(provider, missingEnv)
      : connectionMode === 'env_managed'
        ? buildEnvManagedMessage(provider)
        : '';

  return {
    provider,
    displayName: displayNameFor(provider),
    available,
    connectable,
    missingEnv,
    partiallyConfigured: presentProviderEnvCount > 0 && missingEnv.length > 0,
    callbackPath: callbackPathFor(provider),
    message,
  };
}

export function isProviderOAuthAvailable(provider: ProviderKey): boolean {
  const availability = getProviderOAuthAvailability(provider);
  return availability.available && availability.connectable;
}

export function listProviderOAuthAvailability(): ProviderOAuthAvailability[] {
  return (Object.keys(PROVIDER_REGISTRY) as ProviderKey[]).map((provider) => getProviderOAuthAvailability(provider));
}

export function collectEnabledProviderMisconfigurations(): ProviderOAuthAvailability[] {
  return listProviderOAuthAvailability().filter((availability) => availability.partiallyConfigured);
}
