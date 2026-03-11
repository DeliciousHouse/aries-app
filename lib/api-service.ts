/**
 * Shared server-side service for proxying requests to n8n webhooks.
 * Handles timeouts, error normalization, and structured logging.
 * Server-only — never import from client code.
 */

import { config, n8nWebhookUrl } from './config';

const TIMEOUT_MS = 15_000;

export interface N8nProxyResult {
  ok: boolean;
  status: number;
  data: unknown;
  webhookPath: string;
  durationMs: number;
}

export interface ApiPayload {
  source: string;
  surface: 'marketing-site' | 'app-shell';
  page: string;
  intent: string;
  timestamp: string;
  user?: {
    name?: string;
    email?: string;
    company?: string;
    teamSize?: string;
    budget?: string;
  };
  details?: {
    useCase?: string;
    message?: string;
    utm?: Record<string, string>;
    referrer?: string;
  };
  [key: string]: unknown;
}

function log(level: string, message: string, meta?: Record<string, unknown>) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    service: 'aries-api',
    message,
    ...meta,
  };
  if (level === 'error') {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

/** POST to an n8n webhook with timeout and error handling */
export async function postToN8n(
  webhookPath: string,
  payload: unknown
): Promise<N8nProxyResult> {
  const url = n8nWebhookUrl(webhookPath);
  const start = Date.now();

  log('info', `n8n proxy: POST ${webhookPath}`, { url });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const durationMs = Date.now() - start;
    let data: unknown;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    log(res.ok ? 'info' : 'warn', `n8n response: ${res.status}`, {
      webhookPath,
      status: res.status,
      durationMs,
    });

    return { ok: res.ok, status: res.status, data, webhookPath, durationMs };
  } catch (error) {
    const durationMs = Date.now() - start;
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = message.includes('abort');

    log('error', `n8n proxy failed: ${webhookPath}`, {
      error: message,
      isTimeout,
      durationMs,
    });

    return {
      ok: false,
      status: isTimeout ? 504 : 502,
      data: { error: message, isTimeout },
      webhookPath,
      durationMs,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Build a standardized API payload */
export function buildPayload(
  partial: Partial<ApiPayload> & { intent: string; page: string }
): ApiPayload {
  return {
    source: 'aries-ai-website',
    surface: partial.surface || 'marketing-site',
    timestamp: new Date().toISOString(),
    ...partial,
  };
}

/** Standard JSON error response */
export function errorResponse(status: number, message: string, details?: unknown) {
  return new Response(
    JSON.stringify({ status: 'error', message, details }),
    { status, headers: { 'Content-Type': 'application/json' } }
  );
}

/** Standard JSON success response */
export function successResponse(data: unknown, status = 200) {
  return new Response(
    JSON.stringify({ status: 'ok', ...( typeof data === 'object' && data !== null ? data : { data }) }),
    { status, headers: { 'Content-Type': 'application/json' } }
  );
}
