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
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
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
