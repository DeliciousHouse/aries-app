import { MemoryError } from './errors';
import type { HonchoTransport } from './honcho-client';

const DEFAULT_HONCHO_BASE_URL = 'http://host.docker.internal:8000';

type TransportArgs = Parameters<HonchoTransport['request']>[0];

function usesControlPlaneCredential(args: TransportArgs): boolean {
  if (args.method === 'POST' && args.path === '/v3/workspaces') {
    return true;
  }
  if (args.method === 'DELETE' && /^\/v3\/workspaces\/[^/]+$/.test(args.path)) {
    return true;
  }
  return false;
}

export class HonchoHttpTransport implements HonchoTransport {
  private readonly baseUrl: string;
  private readonly controlPlaneToken: string | null;
  private readonly dataPlaneToken: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(
    env: Partial<Record<string, string | undefined>> = process.env,
    fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    this.baseUrl = (env.HONCHO_BASE_URL ?? DEFAULT_HONCHO_BASE_URL).replace(/\/$/, '');
    this.controlPlaneToken = env.HONCHO_CONTROL_PLANE_JWT?.trim() || null;
    this.dataPlaneToken = env.HONCHO_DATA_PLANE_JWT?.trim() || null;
    this.fetchImpl = fetchImpl;
  }

  private bearerTokenFor(args: TransportArgs): string | null {
    if (usesControlPlaneCredential(args)) {
      return this.controlPlaneToken ?? this.dataPlaneToken;
    }
    return this.dataPlaneToken ?? this.controlPlaneToken;
  }

  async request<T>(args: TransportArgs): Promise<T> {
    const url = this.buildUrl(args);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'accept': 'application/json',
    };
    const bearer = this.bearerTokenFor(args);
    if (bearer) {
      headers['authorization'] = `Bearer ${bearer}`;
    }

    const init: RequestInit = {
      method: args.method,
      headers,
    };
    if (args.body !== undefined && args.method !== 'GET' && args.method !== 'DELETE') {
      init.body = JSON.stringify(args.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (err) {
      throw new MemoryError(
        'honcho_unavailable',
        `Honcho request failed: ${err instanceof Error ? err.message : String(err)}`,
        503,
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new MemoryError(
        'honcho_unauthorized',
        `Honcho returned ${response.status} on ${args.method} ${args.path}`,
        response.status,
      );
    }

    if (response.status === 404) {
      throw new MemoryError(
        'workspace_not_found',
        `Honcho resource not found: ${args.path}`,
        404,
      );
    }

    if (!response.ok) {
      throw new MemoryError(
        'honcho_unavailable',
        `Honcho returned ${response.status} on ${args.method} ${args.path}`,
        502,
      );
    }

    if (response.status === 204 || response.headers.get('content-length') === '0') {
      return {} as T;
    }

    const text = await response.text();
    if (!text) return {} as T;

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new MemoryError(
        'honcho_unavailable',
        `Honcho returned non-JSON response on ${args.method} ${args.path}`,
        502,
      );
    }
  }

  private buildUrl(args: TransportArgs): string {
    let url = `${this.baseUrl}${args.path}`;
    if (args.query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(args.query)) {
        if (value !== undefined) {
          params.set(key, String(value));
        }
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }
    return url;
  }
}
