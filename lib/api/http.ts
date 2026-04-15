import { buildApiError } from './types';

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
  const { query, headers, ...init } = options;
  const url = buildApiUrl(path, baseUrl, query);
  const normalizedHeaders = new Headers(headers || undefined);
  if (!(init.body instanceof FormData) && !normalizedHeaders.has('content-type')) {
    normalizedHeaders.set('content-type', 'application/json');
  }
  const response = await fetchImpl(url, {
    ...init,
    headers: normalizedHeaders,
  });

  const body = await readJsonBody(response);

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
  const attempts = Math.max(1, policy.maxAttempts);
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
  throw lastError;
}
