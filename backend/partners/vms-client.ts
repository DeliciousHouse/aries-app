import { vmsBaseUrl, vmsWebhookSecret } from '@/lib/partner-attribution-env';

export type AriesSignupPayload = {
  refCode: string;
  name: string;
  email: string;
  company?: string | null;
  domain?: string | null;
};

export type VmsPostTerminalReason = 'bad_request' | 'unauthorized' | 'unknown_client';

export type VmsPostResult =
  | { ok: true; status: number }
  | { ok: false; retryable: boolean; status: number; terminalReason?: VmsPostTerminalReason; bodySnippet?: string };

const TIMEOUT_MS = 5000;

function snippet(text: string, max = 500): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

export async function postAriesSignup(payload: AriesSignupPayload): Promise<VmsPostResult> {
  const base = vmsBaseUrl();
  const secret = vmsWebhookSecret();
  if (!base || !secret) {
    return { ok: false, retryable: false, status: 0, terminalReason: 'unknown_client' };
  }

  const url = `${base}/api/aries/signup`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-aries-secret': secret,
      },
      body: JSON.stringify({
        refCode: payload.refCode,
        name: payload.name,
        email: payload.email,
        company: payload.company ?? undefined,
        domain: payload.domain ?? undefined,
      }),
      signal: controller.signal,
    });

    const status = res.status;
    const text = await res.text();

    if (status === 201 || status === 200) {
      return { ok: true, status };
    }

    if (status === 401) {
      return { ok: false, retryable: false, status, terminalReason: 'unauthorized', bodySnippet: snippet(text) };
    }

    if (status === 400) {
      return { ok: false, retryable: false, status, terminalReason: 'bad_request', bodySnippet: snippet(text) };
    }

    if (status >= 500 || status === 503) {
      return { ok: false, retryable: true, status, bodySnippet: snippet(text) };
    }

    if (status >= 400 && status < 500) {
      return { ok: false, retryable: false, status, bodySnippet: snippet(text) };
    }

    return { ok: false, retryable: true, status, bodySnippet: snippet(text) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const aborted = err instanceof Error && err.name === 'AbortError';
    return {
      ok: false,
      retryable: true,
      status: aborted ? 408 : 0,
      bodySnippet: snippet(message),
    };
  } finally {
    clearTimeout(timer);
  }
}
