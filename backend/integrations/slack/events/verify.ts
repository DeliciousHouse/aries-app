/**
 * Slack Events API signature verification.
 *
 * Implements the v0 signing scheme per https://api.slack.com/authentication/verifying-requests-from-slack.
 *
 * Hard rules:
 *   - HMAC-SHA256 over `v0:{timestamp}:{rawBody}` using the signing secret.
 *   - `timingSafeEqual` for the comparison (never `===`).
 *   - Reject timestamps more than 5 minutes in the past or future.
 *   - Reject missing/malformed headers explicitly so the caller can log a
 *     structured reason.
 *
 * Called from the inbound route handler before any JSON parsing or business
 * logic. Pass the RAW request body bytes (as a UTF-8 string) — the signature
 * is computed over the bytes Slack sent, so parsing and re-serializing will
 * break the comparison.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type SlackSignatureFailureReason =
  | 'missing_signing_secret'
  | 'missing_timestamp_header'
  | 'missing_signature_header'
  | 'malformed_signature_header'
  | 'bad_timestamp'
  | 'stale_timestamp'
  | 'future_timestamp'
  | 'length_mismatch'
  | 'signature_mismatch';

export type SlackSignatureResult =
  | { ok: true }
  | { ok: false; reason: SlackSignatureFailureReason };

export interface VerifySlackSignatureInput {
  signingSecret: string;
  rawBody: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  /** Override clock for tests. Defaults to `Date.now()`. */
  nowMs?: number;
  /** Allowed clock skew in seconds. Defaults to 5 minutes per Slack docs. */
  toleranceSeconds?: number;
}

const DEFAULT_TOLERANCE_SECONDS = 60 * 5;

export function verifySlackSignature(input: VerifySlackSignatureInput): SlackSignatureResult {
  const { signingSecret, rawBody, timestamp, signature } = input;
  if (!signingSecret) {
    return { ok: false, reason: 'missing_signing_secret' };
  }
  if (timestamp === null || timestamp === undefined || timestamp === '') {
    return { ok: false, reason: 'missing_timestamp_header' };
  }
  if (signature === null || signature === undefined || signature === '') {
    return { ok: false, reason: 'missing_signature_header' };
  }
  if (!signature.startsWith('v0=')) {
    return { ok: false, reason: 'malformed_signature_header' };
  }

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: 'bad_timestamp' };
  }

  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowSeconds = (input.nowMs ?? Date.now()) / 1000;
  const delta = nowSeconds - ts;
  if (delta > tolerance) {
    return { ok: false, reason: 'stale_timestamp' };
  }
  if (delta < -tolerance) {
    return { ok: false, reason: 'future_timestamp' };
  }

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmac('sha256', signingSecret).update(base).digest('hex')}`;

  const expectedBuf = Buffer.from(expected, 'utf8');
  const providedBuf = Buffer.from(signature, 'utf8');
  if (expectedBuf.length !== providedBuf.length) {
    return { ok: false, reason: 'length_mismatch' };
  }
  return timingSafeEqual(expectedBuf, providedBuf)
    ? { ok: true }
    : { ok: false, reason: 'signature_mismatch' };
}

/** Test helper: compute the v0 signature for a given body + timestamp. */
export function computeSlackSignatureForTests(input: {
  signingSecret: string;
  rawBody: string;
  timestamp: string;
}): string {
  const base = `v0:${input.timestamp}:${input.rawBody}`;
  return `v0=${createHmac('sha256', input.signingSecret).update(base).digest('hex')}`;
}
