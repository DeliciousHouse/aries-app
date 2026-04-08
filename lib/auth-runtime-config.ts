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

export function resolveAuthRuntimeConfig(env: NodeJS.ProcessEnv): {
  authUrl?: string;
  trustHost: boolean;
} {
  const authUrl =
    normalizeEnvValue(env.NEXTAUTH_URL) ??
    normalizeEnvValue(env.AUTH_URL) ??
    normalizeEnvValue(env.APP_BASE_URL);

  const configuredTrustHost = parseBoolean(env.AUTH_TRUST_HOST);
  const trustHost = configuredTrustHost ?? (Boolean(authUrl) || env.NODE_ENV !== "production");

  return { authUrl, trustHost };
}
