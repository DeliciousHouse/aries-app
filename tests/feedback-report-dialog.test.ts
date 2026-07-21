import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

/**
 * Component-level coverage for ReportModal (frontend/feedback/report-dialog.tsx)
 * closing two gaps left by the pure-function tests in feedback-report-form.test.ts:
 *
 *   1. The double-submit guard (`if (submitting || phase === 'success') return;`
 *      + `disabled={submitting}` on the submit button) — proven here as "exactly
 *      one POST" when the form's onSubmit fires twice in quick succession.
 *   2. The 429 branch keeps the dialog open with the typed values intact and
 *      shows the server's rate-limit message (report-dialog.tsx's own comment:
 *      "429 / errors: dialog stays open, values intact, retry works").
 *
 * ReportModal itself is NOT wrapped in createPortal (the widget does that), so
 * react-test-renderer can mount it directly — same pattern as the existing
 * feedback-widget-render.test.ts smoke test. The repo has no jsdom, so this
 * file stubs only the minimal window/document surface the component's effects
 * touch (focus-trap keydown listener, activeElement read on mount/unmount) and
 * a fetch stub, all removed in `finally` so no other test observes them.
 */

interface Harness {
  root: import('react-test-renderer').ReactTestRenderer;
  onCloseCalls: number;
  fetchCalls: number;
  requestBodies: Array<Record<string, unknown>>;
  fillValidForm: () => Promise<void>;
  submitOnce: () => Promise<void>;
  titleValue: () => string;
  hasDialog: () => boolean;
  hasSubmitButton: () => boolean;
  alertMessages: () => string[];
  submitLabel: () => string;
}

async function withReportDialog(
  fetchImpl: (input: unknown, init?: unknown) => Promise<unknown>,
  run: (h: Harness) => Promise<void>,
): Promise<void> {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  (globalThis as Record<string, unknown>).window = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners.get(type)?.delete(fn);
    },
    setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
  (globalThis as Record<string, unknown>).document = {
    activeElement: null,
  };

  let fetchCalls = 0;
  const requestBodies: Array<Record<string, unknown>> = [];
  (globalThis as Record<string, unknown>).fetch = async (input: unknown, init?: unknown) => {
    fetchCalls += 1;
    const body = (init as { body?: unknown } | undefined)?.body;
    if (typeof body === 'string') requestBodies.push(JSON.parse(body) as Record<string, unknown>);
    return fetchImpl(input, init);
  };

  try {
    const { act, create } = await import('react-test-renderer');
    const ReportModal = (await import('../frontend/feedback/report-dialog')).default;

    let onCloseCalls = 0;
    let root!: import('react-test-renderer').ReactTestRenderer;
    await act(async () => {
      root = create(
        React.createElement(ReportModal, {
          onClose: () => {
            onCloseCalls += 1;
          },
        }),
      );
    });

    const findTitleInput = () =>
      root.root.find(
        (node) => node.type === 'input' && (node.props as { type?: string }).type === 'text',
      );

    const harness: Harness = {
      root,
      get onCloseCalls() {
        return onCloseCalls;
      },
      get fetchCalls() {
        return fetchCalls;
      },
      get requestBodies() {
        return requestBodies;
      },
      fillValidForm: async () => {
        const radios = root.root.findAllByProps({ name: 'report-impact' });
        await act(async () => {
          radios[0].props.onChange({ target: { value: radios[0].props.value } });
        });
        const titleInput = findTitleInput();
        await act(async () => {
          titleInput.props.onChange({ target: { value: 'Broken publish button' } });
        });
        const textarea = root.root.findByType('textarea');
        await act(async () => {
          textarea.props.onChange({ target: { value: 'Clicking Publish does nothing.' } });
        });
      },
      submitOnce: async () => {
        const form = root.root.findByType('form');
        await act(async () => {
          form.props.onSubmit({ preventDefault() {} });
        });
      },
      titleValue: () => findTitleInput().props.value as string,
      hasDialog: () => root.root.findAllByProps({ role: 'dialog' }).length > 0,
      hasSubmitButton: () => root.root.findAllByProps({ 'data-testid': 'report-submit' }).length > 0,
      alertMessages: () =>
        root.root
          .findAllByProps({ role: 'alert' })
          .map((node) => String((node.props as { children?: unknown }).children)),
      submitLabel: () => {
        const button = root.root.findByProps({ 'data-testid': 'report-submit' });
        return String(button.props.children);
      },
    };

    await run(harness);

    await act(async () => {
      root.unmount();
    });
  } finally {
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).document;
    delete (globalThis as Record<string, unknown>).fetch;
  }
}

test('INVARIANT double-submit guard: firing onSubmit twice sends exactly one POST', async () => {
  await withReportDialog(
    () => new Promise(() => {}), // never resolves — the request is still "in flight"
    async (h) => {
      await h.fillValidForm();
      await h.submitOnce();
      await h.submitOnce();
      assert.equal(h.fetchCalls, 1, 'a second onSubmit while the first request is in flight must be a no-op');
      // The submit button itself must reflect the guard (disabled while submitting).
      const button = h.root.root.findByProps({ 'data-testid': 'report-submit' });
      assert.equal(button.props.disabled, true);
    },
  );
});

test('INVARIANT 429 keeps values and keeps the dialog open', async () => {
  await withReportDialog(
    async () => ({
      status: 429,
      ok: false,
      json: async () => ({ error: 'Too many reports.' }),
    }),
    async (h) => {
      await h.fillValidForm();
      await h.submitOnce();
      // Let the fetch/json promise chain (and the state updates it drives) settle.
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(h.fetchCalls, 1);
      assert.equal(h.onCloseCalls, 0, 'a 429 must never close the dialog');
      assert.ok(h.hasDialog(), 'the dialog must still be rendered after a 429');
      assert.ok(h.hasSubmitButton(), 'the form (and its submit control) must still be present');
      assert.equal(h.titleValue(), 'Broken publish button', 'typed values must survive a 429');

      const alerts = h.alertMessages();
      assert.equal(alerts.length, 1);
      assert.equal(alerts[0], 'Too many reports.');

      // Retry must be possible: the submit button is re-enabled (phase back to idle).
      const button = h.root.root.findByProps({ 'data-testid': 'report-submit' });
      assert.equal(button.props.disabled, false);
    },
  );
});

for (const status of [401, 503]) {
  test(`${status} is announced as an error, preserves input, and offers retry`, async () => {
    await withReportDialog(
      async () => ({
        status,
        ok: false,
        json: async () => ({ error: status === 401 ? 'unauthorized' : 'persist_failed' }),
      }),
      async (h) => {
        await h.fillValidForm();
        await h.submitOnce();
        await new Promise((resolve) => setTimeout(resolve, 20));

        assert.equal(h.onCloseCalls, 0);
        assert.equal(h.titleValue(), 'Broken publish button');
        assert.deepEqual(h.alertMessages(), [
          "We couldn't send that just now. Your text is saved — please retry.",
        ]);
        assert.equal(h.submitLabel(), 'Retry');
      },
    );
  });
}

test('ambiguous failure retries preserve one stable browser idempotency key', async () => {
  await withReportDialog(
    async () => ({
      status: 503,
      ok: false,
      json: async () => ({ error: 'persist_failed' }),
    }),
    async (h) => {
      await h.fillValidForm();
      await h.submitOnce();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await h.submitOnce();
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(h.requestBodies.length, 2);
      const first = h.requestBodies[0].idempotency_key;
      const second = h.requestBodies[1].idempotency_key;
      assert.equal(typeof first, 'string');
      assert.match(String(first), /^[0-9a-f-]{36}$/);
      assert.equal(second, first, 'retrying an unchanged report must reuse the original key');
    },
  );
});

test('a server key conflict rotates the browser idempotency key before retry', async () => {
  await withReportDialog(
    async () => ({
      status: 409,
      ok: false,
      json: async () => ({ error: 'This submission key cannot be reused. Please submit again.' }),
    }),
    async (h) => {
      await h.fillValidForm();
      await h.submitOnce();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await h.submitOnce();
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(h.requestBodies.length, 2);
      assert.notEqual(
        h.requestBodies[1].idempotency_key,
        h.requestBodies[0].idempotency_key,
        'a hard key conflict must not trap Retry on the rejected key',
      );
    },
  );
});
