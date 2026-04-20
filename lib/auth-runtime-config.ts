function normalizeEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  const normalized = normalizeEnvValue(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  return undefined;
}

function isLoopbackAuthUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  } catch {
    return false;
  }
}

export function resolveAuthRuntimeConfig(env: NodeJS.ProcessEnv): {
  authUrl?: string;
  trustHost: boolean;
} {
  const configuredAuthUrl =
    normalizeEnvValue(env.NEXTAUTH_URL) ??
    normalizeEnvValue(env.AUTH_URL) ??
    normalizeEnvValue(env.APP_BASE_URL);
  const authUrl =
    env.NODE_ENV !== "production" && isLoopbackAuthUrl(configuredAuthUrl)
      ? undefined
      : configuredAuthUrl;

  const configuredTrustHost = parseBoolean(env.AUTH_TRUST_HOST);
  const trustHost = configuredTrustHost ?? (Boolean(authUrl) || env.NODE_ENV !== "production");

  return { authUrl, trustHost };
}
