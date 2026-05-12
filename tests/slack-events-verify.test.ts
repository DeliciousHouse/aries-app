import assert from 'node:assert/strict';
import test from 'node:test';

import pool from '../lib/db';
import {
  computeSlackSignatureForTests,
  verifySlackSignature,
} from '../backend/integrations/slack/events/verify';

const SIGNING_SECRET = 'unit-test-signing-secret';

function freshTimestamp(nowMs: number = Date.now()): string {
  return String(Math.floor(nowMs / 1000));
}

test('verifySlackSignature accepts a valid v0 signature', () => {
  const rawBody = JSON.stringify({ type: 'event_callback', event_id: 'evt-1' });
  const timestamp = freshTimestamp();
  const signature = computeSlackSignatureForTests({
    signingSecret: SIGNING_SECRET,
    rawBody,
    timestamp,
  });

  const result = verifySlackSignature({
    signingSecret: SIGNING_SECRET,
    rawBody,
    timestamp,
    signature,
  });
  assert.deepEqual(result, { ok: true });
});

test('verifySlackSignature rejects a forged signature', () => {
  const rawBody = '{"type":"event_callback"}';
  const timestamp = freshTimestamp();
  const result = verifySlackSignature({
    signingSecret: SIGNING_SECRET,
    rawBody,
    timestamp,
    // Same length as a real signature so we exercise timingSafeEqual.
    signature: 'v0=' + 'a'.repeat(64),
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'signature_mismatch');
  }
});

test('verifySlackSignature rejects stale timestamps (>5 minutes old)', () => {
  const nowMs = 1_700_000_000_000;
  const staleTs = String(Math.floor(nowMs / 1000) - 60 * 6); // 6 minutes ago
  const rawBody = '{}';
  const signature = computeSlackSignatureForTests({
    signingSecret: SIGNING_SECRET,
    rawBody,
    timestamp: staleTs,
  });

  const result = verifySlackSignature({
    signingSecret: SIGNING_SECRET,
    rawBody,
    timestamp: staleTs,
    signature,
    nowMs,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'stale_timestamp');
});

test('verifySlackSignature rejects future timestamps (>5 minutes ahead)', () => {
  const nowMs = 1_700_000_000_000;
  const futureTs = String(Math.floor(nowMs / 1000) + 60 * 6);
  const rawBody = '{}';
  const signature = computeSlackSignatureForTests({
    signingSecret: SIGNING_SECRET,
    rawBody,
    timestamp: futureTs,
  });

  const result = verifySlackSignature({
    signingSecret: SIGNING_SECRET,
    rawBody,
    timestamp: futureTs,
    signature,
    nowMs,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'future_timestamp');
});

test('verifySlackSignature reports missing headers with structured reasons', () => {
  const rawBody = '{}';
  const timestamp = freshTimestamp();

  const noTs = verifySlackSignature({
    signingSecret: SIGNING_SECRET,
    rawBody,
    timestamp: null,
    signature: 'v0=abc',
  });
  assert.equal(noTs.ok, false);
  if (!noTs.ok) assert.equal(noTs.reason, 'missing_timestamp_header');

  const noSig = verifySlackSignature({
    signingSecret: SIGNING_SECRET,
    rawBody,
    timestamp,
    signature: null,
  });
  assert.equal(noSig.ok, false);
  if (!noSig.ok) assert.equal(noSig.reason, 'missing_signature_header');

  const badSig = verifySlackSignature({
    signingSecret: SIGNING_SECRET,
    rawBody,
    timestamp,
    signature: 'sha256=abc',
  });
  assert.equal(badSig.ok, false);
  if (!badSig.ok) assert.equal(badSig.reason, 'malformed_signature_header');

  const noSecret = verifySlackSignature({
    signingSecret: '',
    rawBody,
    timestamp,
    signature: 'v0=abc',
  });
  assert.equal(noSecret.ok, false);
  if (!noSecret.ok) assert.equal(noSecret.reason, 'missing_signing_secret');
});

function signedRequest(opts: {
  rawBody: string;
  signingSecret?: string;
  timestamp?: string;
  retryNum?: number;
  retryReason?: string;
  signatureOverride?: string;
}): Request {
  const secret = opts.signingSecret ?? SIGNING_SECRET;
  const ts = opts.timestamp ?? freshTimestamp();
  const signature =
    opts.signatureOverride ??
    computeSlackSignatureForTests({ signingSecret: secret, rawBody: opts.rawBody, timestamp: ts });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-slack-request-timestamp': ts,
    'x-slack-signature': signature,
  };
  if (opts.retryNum !== undefined) headers['x-slack-retry-num'] = String(opts.retryNum);
  if (opts.retryReason !== undefined) headers['x-slack-retry-reason'] = opts.retryReason;
  return new Request('https://aries.example.com/api/integrations/slack/events', {
    method: 'POST',
    headers,
    body: opts.rawBody,
  });
}

async function withSigningSecret<T>(value: string | null, run: () => Promise<T>): Promise<T> {
  const previous = process.env.SLACK_SIGNING_SECRET;
  if (value === null) {
    delete process.env.SLACK_SIGNING_SECRET;
  } else {
    process.env.SLACK_SIGNING_SECRET = value;
  }
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.SLACK_SIGNING_SECRET;
    else process.env.SLACK_SIGNING_SECRET = previous;
  }
}

test('Slack events route handles the URL verification handshake', async (t) => {
  await withSigningSecret(SIGNING_SECRET, async () => {
    const { POST } = await import('../app/api/integrations/slack/events/route');
    // Stub pool.query — handshake should not touch DB, but be defensive.
    t.mock.method(pool, 'query', (async () => ({ rows: [], rowCount: 0 })) as unknown as typeof pool.query);
    const rawBody = JSON.stringify({ type: 'url_verification', challenge: 'abc-xyz' });
    const res = await POST(signedRequest({ rawBody }));
    assert.equal(res.status, 200);
    const payload = (await res.json()) as { challenge?: string };
    assert.equal(payload.challenge, 'abc-xyz');
  });
});

test('Slack events route rejects invalid signature with 401', async () => {
  await withSigningSecret(SIGNING_SECRET, async () => {
    const { POST } = await import('../app/api/integrations/slack/events/route');
    const rawBody = JSON.stringify({ type: 'event_callback', event_id: 'evt-bad' });
    const req = signedRequest({
      rawBody,
      signatureOverride: 'v0=' + 'b'.repeat(64),
    });
    const res = await POST(req);
    assert.equal(res.status, 401);
  });
});

test('Slack events route returns 503 when signing secret is unset', async () => {
  await withSigningSecret(null, async () => {
    const { POST } = await import('../app/api/integrations/slack/events/route');
    const rawBody = JSON.stringify({ type: 'event_callback', event_id: 'evt-1' });
    const res = await POST(signedRequest({ rawBody }));
    assert.equal(res.status, 503);
  });
});

test('Slack events route 200s an event_callback and inserts into slack_event_ids', async (t) => {
  await withSigningSecret(SIGNING_SECRET, async () => {
    const { POST } = await import('../app/api/integrations/slack/events/route');
    const seen: string[] = [];
    t.mock.method(pool, 'query', (async (sql: string, params: unknown[] = []) => {
      if (String(sql).includes('INSERT INTO slack_event_ids')) {
        const id = String(params[0]);
        if (seen.includes(id)) return { rows: [], rowCount: 0 };
        seen.push(id);
        return { rows: [{ event_id: id }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }) as unknown as typeof pool.query);

    const rawBody = JSON.stringify({
      type: 'event_callback',
      event_id: 'evt-happy',
      team_id: 'T123',
      event: { type: 'reaction_added', user: 'U1', reaction: 'white_check_mark' },
    });
    const res1 = await POST(signedRequest({ rawBody }));
    assert.equal(res1.status, 200);
    assert.deepEqual(seen, ['evt-happy']);

    // Replay (Slack retry) — same event_id, same body, with retry header.
    const res2 = await POST(signedRequest({ rawBody, retryNum: 1, retryReason: 'http_timeout' }));
    assert.equal(res2.status, 200);
    // No new insert; dedupe path returned 200 idempotently.
    assert.deepEqual(seen, ['evt-happy']);
  });
});
