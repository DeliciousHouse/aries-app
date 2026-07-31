/**
 * AA-111 (S5-2) — the /insights Conversations Reply control.
 *
 * The backend reply path shipped long before the UI: the endpoint
 * (app/api/insights/comments/[commentId]/reply) and its Meta/Composio
 * publishers are covered by insights-comment-reply-route.test.ts and
 * insights-comment-reply-composio-route.test.ts. The section, meanwhile, still
 * rendered `<ActionButton icon="reply" label="Reply" disabled />` behind a
 * "Reply ships soon" tooltip.
 *
 * These tests pin the wiring: flag gating, the POST contract, the
 * already-replied convergence, and that a failure never claims success.
 *
 * Run:
 *   APP_BASE_URL=https://aries.example.com \
 *     ./node_modules/.bin/tsx --test tests/insights-conversations-reply-ui.test.ts
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

import { ConversationsSection } from '../frontend/insights/ConversationsSection';
import type { ConversationItem } from '../frontend/insights/types';

type Renderer = import('react-test-renderer').ReactTestRenderer;

function comment(overrides: Partial<ConversationItem> = {}): ConversationItem {
  return {
    id: 4242,
    author: 'Dana',
    avatar: 'D',
    text: 'Do you ship to Canada?',
    postRef: 'Autumn drop',
    platform: 'instagram',
    receivedAt: '2026-07-30T10:00:00.000Z',
    timeAgo: '1d',
    tag: 'question',
    tagLabel: 'Question',
    handled: false,
    ...overrides,
  };
}

/** Installs a fetch stub and returns the restore fn. The stub must outlive the
 *  initial render — the reply POST happens on a later click, so restoring at
 *  render time would send that request to the real fetch. */
function installFetchStub(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init)) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function conversationsPayload(item: ConversationItem) {
  return {
    status: 'ok',
    period: '90day',
    platform: 'all',
    meta: {
      total: 1,
      positivePercent: 100,
      needsReply: item.handled ? 0 : 1,
      viewAllLabel: 'View all',
    },
    conversations: [item],
    leadQuality: [],
  };
}

async function renderSection(
  t: import('node:test').TestContext,
  opts: {
    item: ConversationItem;
    nativeReplyEnabled: boolean;
    onReply?: (init?: RequestInit) => Response;
  },
): Promise<{ root: Renderer; act: typeof import('react-test-renderer').act; replyCalls: Array<{ url: string; body: unknown }> }> {
  const { act, create } = await import('react-test-renderer');
  const replyCalls: Array<{ url: string; body: unknown }> = [];
  let root!: Renderer;

  const restore = installFetchStub(async (url, init) => {
    if (url.includes('/reply')) {
      replyCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return opts.onReply
        ? opts.onReply(init)
        : new Response(JSON.stringify({ status: 'replied', comment_id: opts.item.id }), { status: 200 });
    }
    return new Response(JSON.stringify(conversationsPayload(opts.item)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  t.after(restore);

  await act(async () => {
    root = create(
      React.createElement(ConversationsSection, {
        period: '90day',
        platform: 'all',
        nativeReplyEnabled: opts.nativeReplyEnabled,
      }),
    );
  });

  return { root, act, replyCalls };
}

/** Collects the visible text under a test instance. Walks `children`
 *  explicitly — JSON.stringify on a ReactTestInstance hits its circular
 *  `parent` back-reference. */
function visibleText(node: unknown): string {
  const parts: string[] = [];
  const walk = (value: unknown): void => {
    if (value == null) return;
    if (typeof value === 'string' || typeof value === 'number') {
      parts.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    const children = (value as { children?: unknown }).children;
    if (children !== undefined) walk(children);
  };
  walk((node as { children?: unknown }).children);
  return parts.join(' ');
}

function findButtonByLabel(root: Renderer, label: string) {
  return root.root.findAll((node) => node.type === 'button' && visibleText(node).includes(label), {
    deep: true,
  });
}

// ---------------------------------------------------------------------------
// Flag gating
// ---------------------------------------------------------------------------

test('Reply stays disabled when ARIES_NATIVE_REPLY_ENABLED is off', async (t) => {
  const { root } = await renderSection(t, { item: comment(), nativeReplyEnabled: false });

  const replyButtons = findButtonByLabel(root, 'Reply');
  assert.ok(replyButtons.length > 0, 'the Reply control is still rendered');
  assert.equal(replyButtons[0].props.disabled, true, 'disabled while the flag is off');
  assert.match(String(replyButtons[0].props.title), /ships soon/i);
});

test('Reply is enabled when the flag is on', async (t) => {
  const { root } = await renderSection(t, { item: comment(), nativeReplyEnabled: true });

  const replyButtons = findButtonByLabel(root, 'Reply');
  assert.ok(replyButtons.length > 0);
  assert.notEqual(replyButtons[0].props.disabled, true, 'enabled once the flag is on');
});

// ---------------------------------------------------------------------------
// The POST contract
// ---------------------------------------------------------------------------

test('sending a reply POSTs reply_text to the comment reply endpoint', async (t) => {
  const { root, act, replyCalls } = await renderSection(t, { item: comment(), nativeReplyEnabled: true });

  await act(async () => {
    findButtonByLabel(root, 'Reply')[0].props.onClick();
  });

  const textareas = root.root.findAllByType('textarea');
  assert.equal(textareas.length, 1, 'the composer opens');

  await act(async () => {
    textareas[0].props.onChange({ target: { value: '  Yes, we ship to Canada!  ' } });
  });
  await act(async () => {
    findButtonByLabel(root, 'Send reply')[0].props.onClick();
  });

  assert.equal(replyCalls.length, 1, 'exactly one POST');
  assert.match(replyCalls[0].url, /\/api\/insights\/comments\/4242\/reply$/);
  assert.deepEqual(replyCalls[0].body, { reply_text: 'Yes, we ship to Canada!' }, 'text is trimmed');

  const rendered = JSON.stringify(root.toJSON());
  assert.match(rendered, /Replied/, 'the row flips to Replied');
});

test('an empty or whitespace-only reply cannot be sent', async (t) => {
  const { root, act, replyCalls } = await renderSection(t, { item: comment(), nativeReplyEnabled: true });

  await act(async () => {
    findButtonByLabel(root, 'Reply')[0].props.onClick();
  });
  await act(async () => {
    root.root.findAllByType('textarea')[0].props.onChange({ target: { value: '   ' } });
  });

  const send = findButtonByLabel(root, 'Send reply')[0];
  assert.equal(send.props.disabled, true, 'Send is disabled for whitespace-only text');

  await act(async () => {
    send.props.onClick?.();
  });
  assert.equal(replyCalls.length, 0, 'no request is made');
});

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

test('a comment already replied to in a previous session renders as Replied', async (t) => {
  const { root } = await renderSection(t, { item: comment({ handled: true }), nativeReplyEnabled: true });

  assert.match(JSON.stringify(root.toJSON()), /Replied/);
  assert.equal(findButtonByLabel(root, 'Reply').length, 0, 'no Reply control on a handled comment');
});

test('already_replied is treated as success, not an error', async (t) => {
  const { root, act } = await renderSection(t, {
    item: comment(),
    nativeReplyEnabled: true,
    onReply: () => new Response(JSON.stringify({ status: 'already_replied', comment_id: 4242 }), { status: 200 }),
  });

  await act(async () => {
    findButtonByLabel(root, 'Reply')[0].props.onClick();
  });
  await act(async () => {
    root.root.findAllByType('textarea')[0].props.onChange({ target: { value: 'Thanks!' } });
  });
  await act(async () => {
    findButtonByLabel(root, 'Send reply')[0].props.onClick();
  });

  const rendered = JSON.stringify(root.toJSON());
  assert.match(rendered, /Replied/, 'converges to Replied');
  assert.doesNotMatch(rendered, /Reply failed/, 'no error surfaced');
});

test('a failed reply surfaces an error and does not claim the reply was sent', async (t) => {
  const { root, act } = await renderSection(t, {
    item: comment(),
    nativeReplyEnabled: true,
    onReply: () =>
      new Response(JSON.stringify({ status: 'error', reason: 'unsupported_platform' }), { status: 400 }),
  });

  await act(async () => {
    findButtonByLabel(root, 'Reply')[0].props.onClick();
  });
  await act(async () => {
    root.root.findAllByType('textarea')[0].props.onChange({ target: { value: 'Hello' } });
  });
  await act(async () => {
    findButtonByLabel(root, 'Send reply')[0].props.onClick();
  });

  const rendered = JSON.stringify(root.toJSON());
  assert.match(rendered, /not supported for this platform/i);
  assert.doesNotMatch(rendered, /"Replied"/, 'the row must not claim success');
});

test('an outcome-unknown failure tells the operator to check before retrying', async (t) => {
  const { root, act } = await renderSection(t, {
    item: comment(),
    nativeReplyEnabled: true,
    onReply: () =>
      new Response(JSON.stringify({ status: 'error', reason: 'needs_manual_reconciliation' }), { status: 502 }),
  });

  await act(async () => {
    findButtonByLabel(root, 'Reply')[0].props.onClick();
  });
  await act(async () => {
    root.root.findAllByType('textarea')[0].props.onChange({ target: { value: 'Hello' } });
  });
  await act(async () => {
    findButtonByLabel(root, 'Send reply')[0].props.onClick();
  });

  // The publish path could not confirm the outcome, so the copy must not
  // invite a blind retry that could double-post.
  assert.match(JSON.stringify(root.toJSON()), /may have posted but could not be confirmed/i);
});
