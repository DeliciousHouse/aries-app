/**
 * Shared server-side helpers for API payload shaping and standardized
 * responses. Server-only — never import from client code.
 */

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
