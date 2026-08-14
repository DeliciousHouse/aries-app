import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';

/**
 * Component-level coverage for ReportModal (frontend/feedback/report-dialog.tsx).
 * ReportModal itself is not portaled, so react-test-renderer can mount it
 * directly. The harness supplies the minimal focus and keyboard surface needed
 * to exercise the modal contract without a browser DOM.
 */

interface FocusTarget {
  focusCalls: number;
  focus: () => void;
}

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
  dispatchKey: (key: string, shiftKey?: boolean) => { preventDefaultCalled: boolean };
  firstFocusable: FocusTarget;
  lastFocusable: FocusTarget;
  previouslyFocused: FocusTarget;
  setActiveElement: (target: FocusTarget | null) => void;
}

async function withReportDialog(
  fetchImpl: (input: unknown, init?: unknown) => Promise<unknown>,
  run: (h: Harness) => Promise<void>,
  afterUnmount?: (h: Harness) => Promise<void> | void,
): Promise<void> {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  let activeElement: FocusTarget | null = null;
  const makeFocusTarget = (): FocusTarget => {
    const target: FocusTarget = {
      focusCalls: 0,
      focus: () => {
        target.focusCalls += 1;
        activeElement = target;
      },
    };
    return target;
  };
  const firstFocusable = makeFocusTarget();
  const lastFocusable = makeFocusTarget();
  const previouslyFocused = makeFocusTarget();
  activeElement = previouslyFocused;
  const dialogNode = {
    style: {},
    querySelectorAll: () => [firstFocusable, lastFocusable],
    contains: (node: unknown) => node === firstFocusable || node === lastFocusable,
  };
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
    location: {
      pathname: '/insights',
      origin: 'https://aries.example.com',
      href: 'https://aries.example.com/insights?token=query-secret#hash-secret',
      search: '?token=query-secret',
      hash: '#hash-secret',
    },
    consoleErrors: ['console-secret'],
    currentUser: { email: 'person@example.com', tenantId: 'tenant-secret' },
  };
  const documentStub = {};
  Object.defineProperty(documentStub, 'activeElement', { get: () => activeElement });
  (globalThis as Record<string, unknown>).document = documentStub;

  let fetchCalls = 0;
  const requestBodies: Array<Record<string, unknown>> = [];
  (globalThis as Record<string, unknown>).fetch = async (input: unknown, init?: unknown) => {
    fetchCalls += 1;
    const body = (init as { body?: unknown } | undefined)?.body;
    if (typeof body === 'string') requestBodies.push(JSON.parse(body) as Record<string, unknown>);
    const response = (await fetchImpl(input, init)) as {
      status?: number;
      ok?: boolean;
      statusText?: string;
      text?: () => Promise<string>;
      json?: () => Promise<unknown>;
    };
    if (typeof response.text === 'function') return response;
    const responseBody = typeof response.json === 'function' ? await response.json() : null;
    return {
      ...response,
      statusText: response.statusText ?? '',
      text: async () => (responseBody == null ? '' : JSON.stringify(responseBody)),
    };
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
        {
          createNodeMock: (element) =>
            (element.props as { role?: string }).role === 'dialog' ? dialogNode : null,
        },
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
      dispatchKey: (key, shiftKey = false) => {
        let preventDefaultCalled = false;
        const event = {
          key,
          shiftKey,
          preventDefault: () => {
            preventDefaultCalled = true;
          },
        };
        for (const listener of listeners.get('keydown') ?? []) listener(event);
        return { preventDefaultCalled };
      },
      firstFocusable,
      lastFocusable,
      previouslyFocused,
      setActiveElement: (target) => {
        activeElement = target;
      },
    };

    await run(harness);

    await act(async () => {
      root.unmount();
    });
    await afterUnmount?.(harness);
  } finally {
    delete (globalThis as Record<string, unknown>).window;
    delete (globalThis as Record<string, unknown>).document;
    delete (globalThis as Record<string, unknown>).fetch;
  }
}

test('dialog declares modal semantics and mobile-safe overlay containment', async () => {
  await withReportDialog(
    async () => ({ status: 500, ok: false }),
    async (h) => {
      const overlay = h.root.root.findByProps({ role: 'presentation' });
      const dialog = h.root.root.findByProps({ role: 'dialog' });

      assert.equal(dialog.props['aria-modal'], 'true');
      assert.ok(String(overlay.props.className).split(/\s+/).includes('z-[200]'));
      assert.ok(
        String(dialog.props.className).split(/\s+/).includes('max-h-[calc(100dvh-2rem)]'),
      );
    },
  );
});

test('Escape closes and Tab focus stays contained in both directions', async () => {
  await withReportDialog(
    async () => ({ status: 500, ok: false }),
    async (h) => {
      h.setActiveElement(h.lastFocusable);
      assert.equal(h.dispatchKey('Tab').preventDefaultCalled, true);
      assert.equal(h.firstFocusable.focusCalls, 1);

      h.setActiveElement(h.firstFocusable);
      assert.equal(h.dispatchKey('Tab', true).preventDefaultCalled, true);
      assert.equal(h.lastFocusable.focusCalls, 1);

      h.dispatchKey('Escape');
      assert.equal(h.onCloseCalls, 1);
    },
  );
});

test('unmount restores focus to the element active before the dialog opened', async () => {
  await withReportDialog(
    async () => ({ status: 500, ok: false }),
    async (h) => {
      assert.equal(h.previouslyFocused.focusCalls, 0);
    },
    async (h) => {
      assert.equal(h.previouslyFocused.focusCalls, 1);
    },
  );
});

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

test('browser POST uses an exact allowlist and sends only window.location.pathname', async () => {
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

      assert.equal(h.requestBodies.length, 1);
      const body = h.requestBodies[0];
      assert.deepEqual(Object.keys(body).sort(), [
        'category',
        'description',
        'idempotency_key',
        'impact',
        'page_path',
        'screenshot',
        'title',
      ]);
      assert.equal(body.page_path, '/insights');
      const serialized = JSON.stringify(body);
      for (const secret of [
        'aries.example.com',
        'query-secret',
        'hash-secret',
        'console-secret',
        'person@example.com',
        'tenant-secret',
        'priority',
        'labels',
        'project',
      ]) {
        assert.ok(!serialized.includes(secret), `browser payload must not contain ${secret}`);
      }
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

test('401 is announced as an error, preserves input, and offers retry', async () => {
  await withReportDialog(
    async () => ({
      status: 401,
      ok: false,
      json: async () => ({ error: 'unauthorized' }),
    }),
    async (h) => {
      await h.fillValidForm();
      await h.submitOnce();
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(h.onCloseCalls, 0);
      assert.equal(h.titleValue(), 'Broken publish button');
      assert.deepEqual(h.alertMessages(), [
        "We couldn't send that just now. Your text is still here — please retry.",
      ]);
      assert.equal(h.submitLabel(), 'Retry');
    },
  );
});

for (const failure of [
  {
    name: '409 workspace conflict',
    status: 409,
    body: {
      status: 'error',
      reason: 'workspace_mismatch',
      code: 'workspace_mismatch',
      active_workspace_id: '9',
      requested_workspace_id: '7',
      message: 'This tab is using a different workspace. Your action was not performed.',
    },
    expected: 'This tab is using a different workspace. Your action was not performed.',
  },
  {
    name: '503 persistence failure',
    status: 503,
    body: {
      status: 'persist_failed',
      error: 'We could not save your report. Please retry.',
    },
    expected: 'We could not save your report. Please retry.',
  },
]) {
  test(`${failure.name} preserves typed input and renders accurate safe server copy`, async () => {
    await withReportDialog(
      async () => ({
        status: failure.status,
        ok: false,
        json: async () => failure.body,
      }),
      async (h) => {
        await h.fillValidForm();
        await h.submitOnce();
        await new Promise((resolve) => setTimeout(resolve, 20));

        assert.equal(h.onCloseCalls, 0);
        assert.equal(h.titleValue(), 'Broken publish button');
        assert.deepEqual(h.alertMessages(), [failure.expected]);
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
      json: async () => ({
        error: 'This submission key cannot be reused. Please submit again.',
        status: 'idempotency_conflict',
      }),
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
