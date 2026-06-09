import assert from 'node:assert/strict';
import test from 'node:test';

import { postSlackMessage } from '../backend/integrations/slack/client';
import {
  approvalReviewUrl,
  buildApprovalRequiredMessage,
  notifyApprovalRequired,
} from '../backend/integrations/slack/notifications';
import { isSlackNotificationsEnabled } from '../backend/integrations/slack/notify-env';

// ── Fakes ────────────────────────────────────────────────────────────────────

/** A fetch stub that records the last call and returns a scripted response. */
function makeFetchStub(
  response: { ok: boolean; status?: number; body: unknown },
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      json: async () => response.body,
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/**
 * A SQL-aware pool stub. The SELECT (alreadyDelivered) returns a row only when
 * `alreadySent` is true; the INSERT (recordNotified) always succeeds. Records
 * every query so tests can assert the check-then-post-then-record order.
 */
function makePoolStub(opts: { alreadySent?: boolean } = {}): {
  pool: { query: (sql: string, params: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }> };
  queries: Array<{ sql: string; params: unknown[] }>;
} {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      if (/^\s*SELECT/i.test(sql)) {
        return opts.alreadySent
          ? { rowCount: 1, rows: [{ exists: 1 }] }
          : { rowCount: 0, rows: [] };
      }
      // INSERT ... ON CONFLICT DO NOTHING
      return { rowCount: 1, rows: [{ dedup_key: params[0] }] };
    },
  };
  return { pool, queries };
}

function inserts(queries: Array<{ sql: string; params: unknown[] }>) {
  return queries.filter((q) => /^\s*INSERT/i.test(q.sql));
}

const ENABLED_ENV = { ARIES_SLACK_NOTIFICATIONS_ENABLED: '1', SLACK_NOTIFY_CHANNEL: 'C0TEST' };

// ── isSlackNotificationsEnabled ────────────────────────────────────────────────

test('isSlackNotificationsEnabled treats 1/true/yes/on as enabled, else off', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
    assert.equal(isSlackNotificationsEnabled({ ARIES_SLACK_NOTIFICATIONS_ENABLED: v }), true, v);
  }
  for (const v of [undefined, '', '0', 'false', 'no', 'off', 'enabled?']) {
    assert.equal(isSlackNotificationsEnabled({ ARIES_SLACK_NOTIFICATIONS_ENABLED: v }), false, String(v));
  }
});

// ── approvalReviewUrl ──────────────────────────────────────────────────────────

test('approvalReviewUrl builds the per-job review deep link and strips trailing slash', () => {
  assert.equal(
    approvalReviewUrl('https://aries.example.com/', 'mkt_abc 1'),
    'https://aries.example.com/social-content/review?jobId=mkt_abc%201',
  );
});

// ── buildApprovalRequiredMessage (pure) ────────────────────────────────────────

test('buildApprovalRequiredMessage renders headline, prompt, and a Review button linking to the job', () => {
  const { text, blocks } = buildApprovalRequiredMessage({
    stage: 'publish',
    prompt: 'Review creative assets before publish.',
    brandName: 'Sugar & Leather',
    reviewUrl: 'https://aries.example.com/social-content/review?jobId=mkt_1',
  });

  assert.match(text, /Sugar &amp; Leather needs your approval: Publish/);
  assert.match(text, /https:\/\/aries\.example\.com\/social-content\/review\?jobId=mkt_1/);

  // Find the actions block and assert the button URL.
  const actions = (blocks as Array<{ type: string; elements?: Array<{ url?: string; text?: { text?: string } }> }>)
    .find((b) => b.type === 'actions');
  assert.ok(actions, 'expected an actions block');
  const button = actions!.elements?.[0];
  assert.equal(button?.url, 'https://aries.example.com/social-content/review?jobId=mkt_1');
  assert.equal(button?.text?.text, 'Review in Aries');

  // The prompt text must appear in a section block.
  const serialized = JSON.stringify(blocks);
  assert.match(serialized, /Review creative assets before publish\./);
});

test('buildApprovalRequiredMessage falls back when brand name and prompt are absent', () => {
  const { text, blocks } = buildApprovalRequiredMessage({
    stage: 'strategy',
    prompt: null,
    brandName: null,
    reviewUrl: 'https://x/social-content/review?jobId=j',
  });
  assert.match(text, /A marketing campaign needs your approval: Weekly plan/);
  assert.match(JSON.stringify(blocks), /waiting for your review/);
});

test('buildApprovalRequiredMessage escapes mrkdwn-significant chars in untrusted prompt/brand', () => {
  const { blocks } = buildApprovalRequiredMessage({
    stage: 'publish',
    prompt: 'Ping <!channel> & review <https://evil/|here>',
    brandName: 'A & B <fake>',
    reviewUrl: 'https://x/social-content/review?jobId=j',
  });
  const serialized = JSON.stringify(blocks);
  // No raw < > & survive — they are escaped to entities so mrkdwn can't be injected.
  assert.doesNotMatch(serialized, /<!channel>/);
  assert.doesNotMatch(serialized, /<https:\/\/evil/);
  assert.match(serialized, /&lt;!channel&gt;/);
  assert.match(serialized, /&amp;/);
});

test('buildApprovalRequiredMessage truncates an oversized prompt below Slack limits', () => {
  const huge = 'x'.repeat(5000);
  const { blocks } = buildApprovalRequiredMessage({
    stage: 'production',
    prompt: huge,
    brandName: null,
    reviewUrl: 'https://x/social-content/review?jobId=j',
  });
  // The prompt section text must be capped well under Slack's 3000-char section limit.
  const sections = (blocks as Array<{ type: string; text?: { text?: string } }>).filter(
    (b) => b.type === 'section',
  );
  const promptSection = sections.find((s) => (s.text?.text ?? '').includes('x'));
  assert.ok(promptSection, 'expected a section carrying the prompt');
  assert.ok((promptSection!.text!.text!.length) <= 2500, 'prompt truncated to <= 2500 chars');
  assert.match(promptSection!.text!.text!, /…$/);
});

// ── notifyApprovalRequired (dispatcher) ────────────────────────────────────────

test('notifyApprovalRequired is a no-op when the flag is OFF (no DB, no fetch)', async () => {
  const { pool, queries } = makePoolStub();
  const { fetchImpl, calls } = makeFetchStub({ ok: true, body: { ok: true } });
  const res = await notifyApprovalRequired({
    tenantId: 15,
    jobId: 'mkt_1',
    stage: 'publish',
    appBaseUrl: 'https://aries.example.com',
    pool: pool as never,
    clientDeps: { fetchImpl, botToken: 'xoxb-test' },
    env: { ARIES_SLACK_NOTIFICATIONS_ENABLED: '0', SLACK_NOTIFY_CHANNEL: 'C0TEST' },
  });
  assert.deepEqual(res, { delivered: false, reason: 'disabled' });
  assert.equal(queries.length, 0, 'must not touch the DB when disabled');
  assert.equal(calls.length, 0, 'must not call Slack when disabled');
});

test('notifyApprovalRequired returns missing_channel when SLACK_NOTIFY_CHANNEL is unset', async () => {
  const { pool, queries } = makePoolStub();
  const { fetchImpl, calls } = makeFetchStub({ ok: true, body: { ok: true } });
  const res = await notifyApprovalRequired({
    tenantId: 15,
    jobId: 'mkt_1',
    stage: 'publish',
    appBaseUrl: 'https://aries.example.com',
    pool: pool as never,
    clientDeps: { fetchImpl, botToken: 'xoxb-test' },
    env: { ARIES_SLACK_NOTIFICATIONS_ENABLED: '1' },
  });
  assert.equal(res.delivered, false);
  assert.equal(res.reason, 'missing_channel');
  assert.equal(queries.length, 0);
  assert.equal(calls.length, 0);
});

test('notifyApprovalRequired posts on first delivery then records on success (stable job+stage key)', async () => {
  const { pool, queries } = makePoolStub({ alreadySent: false });
  const { fetchImpl, calls } = makeFetchStub({ ok: true, body: { ok: true, ts: '111.222' } });
  const res = await notifyApprovalRequired({
    tenantId: 15,
    jobId: 'mkt_abc',
    stage: 'production',
    prompt: 'Approve the post copy.',
    brandName: 'Sugar & Leather',
    appBaseUrl: 'https://aries.example.com',
    pool: pool as never,
    clientDeps: { fetchImpl, botToken: 'xoxb-test' },
    env: ENABLED_ENV,
  });
  assert.deepEqual(res, { delivered: true });

  // Order: SELECT (check) → post → INSERT (record). Posts before recording.
  assert.equal(calls.length, 1, 'posted exactly once');
  const recorded = inserts(queries);
  assert.equal(recorded.length, 1, 'recorded delivery exactly once, AFTER a successful post');
  // Dedup key is the stable (job, stage) identity — NOT a per-delivery approval id.
  assert.equal(recorded[0].params[0], 'approval:mkt_abc:production');

  const sentBody = JSON.parse(String((calls[0].init as { body: string }).body));
  assert.equal(sentBody.channel, 'C0TEST');
  assert.match(sentBody.text, /Sugar &amp; Leather needs your approval: Post copy & creative/);
  assert.ok(Array.isArray(sentBody.blocks) && sentBody.blocks.length > 0);
});

test('notifyApprovalRequired does NOT post when already delivered (re-delivery)', async () => {
  const { pool, queries } = makePoolStub({ alreadySent: true });
  const { fetchImpl, calls } = makeFetchStub({ ok: true, body: { ok: true } });
  const res = await notifyApprovalRequired({
    tenantId: 15,
    jobId: 'mkt_abc',
    stage: 'production',
    appBaseUrl: 'https://aries.example.com',
    pool: pool as never,
    clientDeps: { fetchImpl, botToken: 'xoxb-test' },
    env: ENABLED_ENV,
  });
  assert.equal(res.delivered, false);
  assert.equal(res.reason, 'duplicate');
  assert.equal(calls.length, 0, 'must NOT re-post on a delivered notification');
  assert.equal(inserts(queries).length, 0, 'no record written on a duplicate');
});

test('notifyApprovalRequired records NOTHING when the post fails, so re-delivery retries', async () => {
  const { pool, queries } = makePoolStub({ alreadySent: false });
  const { fetchImpl, calls } = makeFetchStub({ ok: true, body: { ok: false, error: 'channel_not_found' } });
  const res = await notifyApprovalRequired({
    tenantId: 15,
    jobId: 'mkt_abc',
    stage: 'strategy',
    appBaseUrl: 'https://aries.example.com',
    pool: pool as never,
    clientDeps: { fetchImpl, botToken: 'xoxb-test' },
    env: ENABLED_ENV,
  });
  assert.equal(res.delivered, false);
  assert.equal(res.reason, 'channel_not_found');
  assert.equal(calls.length, 1, 'attempted the post');
  assert.equal(inserts(queries).length, 0, 'no dedup row recorded on failure — next delivery retries');
});

// ── postSlackMessage (client) ──────────────────────────────────────────────────

test('postSlackMessage no-ops without a bot token', async () => {
  const { fetchImpl, calls } = makeFetchStub({ ok: true, body: { ok: true } });
  const res = await postSlackMessage(
    { channel: 'C0TEST', text: 'hi' },
    { fetchImpl, botToken: '' },
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, 'missing_bot_token');
  assert.equal(calls.length, 0);
});

test('postSlackMessage returns ok:true and the message ts on success', async () => {
  const { fetchImpl } = makeFetchStub({ ok: true, body: { ok: true, ts: '999.000' } });
  const res = await postSlackMessage(
    { channel: 'C0TEST', text: 'hi', blocks: [{ type: 'section' }] },
    { fetchImpl, botToken: 'xoxb-test' },
  );
  assert.equal(res.ok, true);
  assert.equal(res.ts, '999.000');
});

test('postSlackMessage surfaces a Slack API ok:false body as an error (HTTP 200)', async () => {
  const { fetchImpl } = makeFetchStub({ ok: true, body: { ok: false, error: 'not_in_channel' } });
  const res = await postSlackMessage(
    { channel: 'C0TEST', text: 'hi' },
    { fetchImpl, botToken: 'xoxb-test' },
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_in_channel');
});

test('postSlackMessage surfaces an HTTP error', async () => {
  const { fetchImpl } = makeFetchStub({ ok: false, status: 429, body: { ok: false, error: 'rate_limited' } });
  const res = await postSlackMessage(
    { channel: 'C0TEST', text: 'hi' },
    { fetchImpl, botToken: 'xoxb-test' },
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, 'rate_limited');
});

test('postSlackMessage never throws when fetch rejects', async () => {
  const fetchImpl = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
  const res = await postSlackMessage(
    { channel: 'C0TEST', text: 'hi' },
    { fetchImpl, botToken: 'xoxb-test' },
  );
  assert.equal(res.ok, false);
  assert.equal(res.error, 'network down');
});
