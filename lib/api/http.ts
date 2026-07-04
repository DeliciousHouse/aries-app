import { buildApiError } from './types';
import {
  WORKSPACE_ID_HEADER,
  getBootedWorkspaceId,
  isStateChangingMethod,
  isWorkspaceGuardActive,
  readWorkspaceMismatchBody,
  reportWorkspaceMismatch,
} from './workspace-guard';

/**
 * The workspace switch endpoint must NEVER carry the mutation-guard header: the
 * tab is, by definition, pinned to the OLD workspace, so a header would 409 the
 * very switch it is performing (plan Decision 2a). The switcher calls the
 * endpoint via a dedicated fetch that bypasses this wrapper, but guard the path
 * here too so a future caller routing through requestJson can't break switching.
 */
const WORKSPACE_SWITCH_PATH = '/api/tenant/workspace/switch';

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, status: number, code: string, details?: unknown) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ApiClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface RequestJsonOptions extends RequestInit {
  query?: Record<string, string | number | boolean | null | undefined>;
  /**
   * Abort the request after this many ms and throw a retryable
   * `request_timeout` ApiRequestError. Bounds a hung fetch (dropped
   * connection, stuck upstream) so list screens surface an error+retry instead
   * of an infinite spinner. Unset = no timeout (unchanged legacy behavior).
   */
  timeoutMs?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function buildApiUrl(
  path: string,
  baseUrl = '',
  query?: RequestJsonOptions['query']
): string {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = `${normalizedBaseUrl}${normalizedPath}`;

  if (!query) {
    return url;
  }

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  }

  const suffix = search.toString();
  return suffix ? `${url}?${suffix}` : url;
}

async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function extractErrorCode(body: unknown, fallbackCode: string): string {
  if (isObject(body)) {
    if (typeof body.code === 'string' && body.code.trim()) {
      return body.code;
    }
    if (typeof body.reason === 'string' && body.reason.trim()) {
      return body.reason;
    }
    if (typeof body.error === 'string' && body.error.trim()) {
      return body.error;
    }
    if (isObject(body.error) && typeof body.error.code === 'string' && body.error.code.trim()) {
      return body.error.code;
    }
  }

  return fallbackCode;
}

function extractErrorMessage(body: unknown, response: Response): string {
  if (isObject(body)) {
    if (typeof body.message === 'string' && body.message.trim()) {
      return body.message;
    }
    if (typeof body.error === 'string' && body.error.trim()) {
      return body.error;
    }
    if (isObject(body.error) && typeof body.error.message === 'string' && body.error.message.trim()) {
      return body.error.message;
    }
    if (typeof body.reason === 'string' && body.reason.trim()) {
      return body.reason;
    }
  }

  if (typeof body === 'string' && body.trim()) {
    return body;
  }

  return response.statusText || `Request failed with status ${response.status}`;
}

export async function requestJson<TResponse>(
  path: string,
  options: RequestJsonOptions = {},
  clientOptions: ApiClientOptions = {}
): Promise<TResponse> {
  const { baseUrl = '', fetchImpl = fetch } = clientOptions;
  const { query, headers, timeoutMs, ...init } = options;
  const url = buildApiUrl(path, baseUrl, query);
  const normalizedHeaders = new Headers(headers || undefined);
  if (!(init.body instanceof FormData) && !normalizedHeaders.has('content-type')) {
    normalizedHeaders.set('content-type', 'application/json');
  }

  // Multi-workspace mutation guard (plan Decision 2a): pin the tab's booted
  // workspace id on state-changing requests ONLY. Never on GET reads (a read
  // may be one render stale) and never on the switch endpoint itself. The
  // header is only attached when the guard was armed at app load (flag ON +
  // multi-workspace tab); server-side (no arm) and single-workspace tabs send
  // nothing, so behavior is byte-identical there.
  if (
    isWorkspaceGuardActive() &&
    isStateChangingMethod(init.method) &&
    !normalizedHeaders.has(WORKSPACE_ID_HEADER) &&
    !path.startsWith(WORKSPACE_SWITCH_PATH)
  ) {
    const bootedId = getBootedWorkspaceId();
    if (bootedId) {
      normalizedHeaders.set(WORKSPACE_ID_HEADER, bootedId);
    }
  }

  // Bounded request timeout: a hung GET must surface as a retryable error, not
  // an infinite spinner. Default (timeoutMs undefined) keeps the old behavior.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let signal = init.signal ?? undefined;
  if (typeof timeoutMs === 'number' && timeoutMs > 0 && typeof AbortController !== 'undefined' && !signal) {
    controller = new AbortController();
    signal = controller.signal;
    timeoutHandle = setTimeout(() => controller?.abort(), timeoutMs);
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      headers: normalizedHeaders,
      signal,
    });
  } catch (error) {
    if (controller?.signal.aborted) {
      throw new ApiRequestError(
        `This request took longer than ${Math.round(timeoutMs! / 1000)}s and was cancelled. Check your connection and try again.`,
        0,
        'request_timeout',
      );
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }

  const body = await readJsonBody(response);

  // Stale-workspace interlock trigger (plan Decision 2a): ANY `409
  // workspace_mismatch` response — from the ~43 wrapper routes or the ~9 raw
  // getTenantContext() mutating routes — routes into the single shell-level
  // interlock, never a toast. We still throw below so the caller's own error
  // handling is unchanged; the interlock is an out-of-band shell overlay.
  if (response.status === 409) {
    const mismatch = readWorkspaceMismatchBody(body);
    if (mismatch) {
      reportWorkspaceMismatch(mismatch);
    }
  }

  if (!response.ok) {
    throw new ApiRequestError(
      extractErrorMessage(body, response),
      response.status,
      extractErrorCode(body, buildApiError('Request failed').code),
      body
    );
  }

  return body as TResponse;
}

export interface RequestJsonRetryPolicy {
  retryOn: number[];
  maxAttempts: number;
  backoffMs: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function requestJsonWithRetry<TResponse>(
  path: string,
  options: RequestJsonOptions = {},
  policy: RequestJsonRetryPolicy,
  clientOptions: ApiClientOptions = {}
): Promise<TResponse> {
  const normalizedMaxAttempts = Number.isFinite(policy.maxAttempts)
    ? Math.trunc(policy.maxAttempts)
    : 1;
  const attempts = Math.max(1, normalizedMaxAttempts);
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await requestJson<TResponse>(path, options, clientOptions);
    } catch (error) {
      lastError = error;
      const isRetryable =
        error instanceof ApiRequestError && policy.retryOn.includes(error.status);
      const hasMoreAttempts = attempt < attempts - 1;
      if (!isRetryable || !hasMoreAttempts) {
        throw error;
      }
      const delay = policy.backoffMs * 2 ** attempt;
      await sleep(delay);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`requestJsonWithRetry: unexpected fallthrough after ${attempts} attempts`);
}
