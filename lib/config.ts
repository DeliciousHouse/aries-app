/**
 * Server-only configuration. Never import this from client components.
 * All n8n credentials stay server-side.
 */

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export const config = {
  n8n: {
    baseUrl: requiredEnv('N8N_BASE_URL').replace(/\/$/, ''),
    apiKey: requiredEnv('N8N_API_KEY'),
  },
  app: {
    baseUrl: optionalEnv('APP_BASE_URL', 'http://localhost:3000'),
    env: optionalEnv('NODE_ENV', 'development'),
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
  },
} as const;

/** Build full n8n webhook URL from a path like "tenant-provisioning" */
export function n8nWebhookUrl(webhookPath: string): string {
  const clean = webhookPath.replace(/^\//, '');
  return `${config.n8n.baseUrl}/webhook/${clean}`;
}
