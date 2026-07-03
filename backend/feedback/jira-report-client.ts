/**
 * Jira REST client for customer incident reports (SC-70 port).
 *
 * One shared client per config (module-level, lazily created, injectable fetch
 * for tests), 15s timeout, Basic auth (email + API token).
 *
 * INVARIANT (SC-70) — token scrubbing: the raw API token AND its precomputed
 * base64 basic credential never appear in exception text, stored errors, logs,
 * or responses. Scrubbing runs BEFORE any truncation (a truncation boundary
 * could otherwise leak a prefix). Transport exceptions are re-thrown as a
 * fresh JiraReportError with no `cause` so the auth-bearing original can never
 * surface via a traceback/inspect. Non-JSON 2xx bodies wrap into the same
 * typed error — callers only ever catch JiraReportError for the retry path.
 *
 * INVARIANT (SC-70) — JQL injection guard: the idempotency label is validated
 * ^[a-z0-9-]+$ before any JQL interpolation (reject → error, zero HTTP). The
 * search uses GET /rest/api/3/search/jql (the classic /rest/api/3/search is
 * deprecated). Issue keys interpolated into URL paths are validated
 * ^[A-Z][A-Z0-9]*-\d+$.
 */

import type { FeedbackReportJiraConfig } from './report-config';

export const JIRA_REQUEST_TIMEOUT_MS = 15_000;

const ERROR_DETAIL_MAX = 400;

const JQL_LABEL_RE = /^[a-z0-9-]+$/;
export const ISSUE_KEY_RE = /^[A-Z][A-Z0-9]*-\d+$/;

/** The single error type callers catch for the park/retry path. */
export class JiraReportError extends Error {
  /** HTTP status when the failure came from a Jira response; null for transport/local. */
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'JiraReportError';
    this.status = status;
  }
}

/** Replace every occurrence of `secret` in `text` (plain string, not regex). */
function replaceAll(text: string, secret: string, replacement: string): string {
  return secret.length > 0 ? text.split(secret).join(replacement) : text;
}

/**
 * Scrub the raw token and the precomputed base64 basic credential from a
 * string. MUST run before any truncation.
 */
export function scrubJiraSecrets(text: string, config: FeedbackReportJiraConfig): string {
  const basic = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
  let out = replaceAll(text, config.apiToken, '[REDACTED]');
  out = replaceAll(out, basic, '[REDACTED]');
  return out;
}

function scrubAndClip(text: string, config: FeedbackReportJiraConfig): string {
  return scrubJiraSecrets(text, config).slice(0, ERROR_DETAIL_MAX);
}

export interface CreateIssueInput {
  fields: Record<string, unknown>;
}

export interface JiraReportTransport {
  /** POST /rest/api/3/issue → created issue key. */
  createIssue(input: CreateIssueInput): Promise<string>;
  /** GET /rest/api/3/search/jql for one label → issue key or null. */
  searchIssueKeyByLabel(label: string): Promise<string | null>;
  /** POST /rest/api/3/issue/{key}/attachments (multipart, no-check token). */
  attachScreenshot(
    issueKey: string,
    bytes: Buffer,
    mime: string,
    filename: string,
  ): Promise<void>;
}

class LiveJiraReportClient implements JiraReportTransport {
  private readonly config: FeedbackReportJiraConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly authHeader: string;

  constructor(config: FeedbackReportJiraConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.authHeader = `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString('base64')}`;
  }

  private async request(
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: BodyInit },
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JIRA_REQUEST_TIMEOUT_MS);
    try {
      return await this.fetchImpl(`${this.config.baseUrl}${path}`, {
        method: init.method,
        headers: {
          Authorization: this.authHeader,
          Accept: 'application/json',
          ...init.headers,
        },
        body: init.body,
        signal: controller.signal,
      });
    } catch (error) {
      // Re-thrown WITHOUT the original as cause: the transport error can carry
      // the request (and its Authorization header) on some runtimes.
      const aborted = error instanceof Error && error.name === 'AbortError';
      const message = aborted
        ? `jira request timed out after ${JIRA_REQUEST_TIMEOUT_MS}ms`
        : `jira transport error: ${scrubAndClip(
            error instanceof Error ? error.message : String(error),
            this.config,
          )}`;
      throw new JiraReportError(message);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Extract Jira's structured error detail — scrubbed BEFORE clipping. */
  private async errorFromResponse(response: Response, context: string): Promise<JiraReportError> {
    let detail = '';
    try {
      const raw = await response.text();
      try {
        const body = JSON.parse(raw) as {
          errorMessages?: unknown;
          errors?: Record<string, unknown>;
        };
        const msgs = Array.isArray(body.errorMessages) ? body.errorMessages.join('; ') : '';
        const fieldErrs = body.errors
          ? Object.entries(body.errors)
              .map(([k, v]) => `${k}: ${String(v)}`)
              .join('; ')
          : '';
        detail = [msgs, fieldErrs].filter(Boolean).join(' | ');
      } catch {
        detail = raw;
      }
    } catch {
      detail = '';
    }
    const scrubbed = detail ? `: ${scrubAndClip(detail, this.config)}` : '';
    return new JiraReportError(
      `${context} failed (HTTP ${response.status})${scrubbed}`,
      response.status,
    );
  }

  private async parseJson<T>(response: Response, context: string): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch {
      // A non-JSON 2xx body is the same typed error as everything else.
      throw new JiraReportError(`${context} returned a non-JSON response`, response.status);
    }
  }

  async createIssue(input: CreateIssueInput): Promise<string> {
    const response = await this.request('/rest/api/3/issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw await this.errorFromResponse(response, 'jira create');
    const created = await this.parseJson<{ key?: unknown }>(response, 'jira create');
    const key = typeof created.key === 'string' ? created.key : '';
    if (!ISSUE_KEY_RE.test(key)) {
      throw new JiraReportError('jira create returned an invalid issue key', response.status);
    }
    return key;
  }

  async searchIssueKeyByLabel(label: string): Promise<string | null> {
    // INVARIANT: validate before interpolating into JQL; zero HTTP on reject.
    if (!JQL_LABEL_RE.test(label)) {
      throw new JiraReportError(`refusing JQL search for unsafe label`);
    }
    const jql = `labels = "${label}"`;
    const response = await this.request(
      `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=key&maxResults=1`,
      { method: 'GET' },
    );
    if (!response.ok) throw await this.errorFromResponse(response, 'jira search');
    const body = await this.parseJson<{ issues?: Array<{ key?: unknown }> }>(
      response,
      'jira search',
    );
    const key = body.issues?.[0]?.key;
    if (typeof key !== 'string') return null;
    if (!ISSUE_KEY_RE.test(key)) {
      throw new JiraReportError('jira search returned an invalid issue key', response.status);
    }
    return key;
  }

  async attachScreenshot(
    issueKey: string,
    bytes: Buffer,
    mime: string,
    filename: string,
  ): Promise<void> {
    // INVARIANT: validate the key before it enters the URL path.
    if (!ISSUE_KEY_RE.test(issueKey)) {
      throw new JiraReportError('refusing attachment upload for unsafe issue key');
    }
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    const response = await this.request(`/rest/api/3/issue/${issueKey}/attachments`, {
      method: 'POST',
      headers: { 'X-Atlassian-Token': 'no-check' },
      body: form,
    });
    if (!response.ok) throw await this.errorFromResponse(response, 'jira attach');
    // Body content is irrelevant on success; drain defensively.
    await response.text().catch(() => undefined);
  }
}

let sharedClient: { signature: string; client: JiraReportTransport } | null = null;

/**
 * Shared lazily-created client, re-built only when the config changes. Tests
 * construct their own via createJiraReportClient with an injected fetch.
 */
export function getJiraReportClient(config: FeedbackReportJiraConfig): JiraReportTransport {
  const signature = `${config.baseUrl}\n${config.email}\n${config.apiToken}\n${config.projectKey}\n${config.issueType}`;
  if (!sharedClient || sharedClient.signature !== signature) {
    sharedClient = { signature, client: new LiveJiraReportClient(config) };
  }
  return sharedClient.client;
}

/** Test/DI constructor: a fresh client with an injectable fetch. */
export function createJiraReportClient(
  config: FeedbackReportJiraConfig,
  fetchImpl: typeof fetch = fetch,
): JiraReportTransport {
  return new LiveJiraReportClient(config, fetchImpl);
}
