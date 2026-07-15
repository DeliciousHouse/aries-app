import assert from "node:assert/strict";
import test from "node:test";

import React from "react";

import { MarketingNewJobScreenContent } from "../frontend/marketing/new-job";
import { BUSINESS_TYPE_MISSING_COPY, WEBSITE_UNREACHABLE_COPY } from "../lib/marketing-create-errors";

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// AA-131 regression: a create failure must highlight the exact field that
// needs attention (inline red box + one-line message) instead of dumping a
// raw error code into the bottom alert.

test("marketing new-job form renders inline field errors for missing one-off inputs", async () => {
  const previousFetch = globalThis.fetch;
  const pushCalls: string[] = [];
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ jobId: "job_ignored" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  try {
    const { act, create } = await import("react-test-renderer");
    let root!: import("react-test-renderer").ReactTestRenderer;

    await act(async () => {
      root = create(
        React.createElement(MarketingNewJobScreenContent, {
          embedded: true,
          router: {
            push(href: string) {
              pushCalls.push(href);
            },
          },
        }),
      );
      await flushMicrotasks();
    });

    // Switch to one-off mode (submit is not disabled there) and submit the
    // empty form: every missing required field reports at once. The one-off
    // toggle is the initially-unchecked radio in the Content type group.
    const oneOffToggle = root.root
      .findAll((node) => node.type === "button" && node.props.role === "radio")
      .find((node) => node.props["aria-checked"] === false);
    assert.ok(oneOffToggle);
    await act(async () => {
      oneOffToggle.props.onClick();
      await flushMicrotasks();
    });

    const form = root.root.findByType("form");
    await act(async () => {
      await form.props.onSubmit({ preventDefault() {} });
      await flushMicrotasks();
    });

    const rendered = JSON.stringify(root.toJSON());
    assert.match(rendered, /Website URL is required\./);
    assert.match(rendered, /Name is required\./);
    assert.match(rendered, /End date is required\./);
    assert.match(rendered, /CTA is required\./);
    assert.deepEqual(pushCalls, []);

    // Editing the field dismisses its error until the next submit.
    const websiteInput = root.root.findByProps({ placeholder: "https://yourbrand.com" });
    await act(async () => {
      websiteInput.props.onChange({ target: { value: "https://example.com" } });
      await flushMicrotasks();
    });
    assert.doesNotMatch(JSON.stringify(root.toJSON()), /Website URL is required\./);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("marketing new-job form renders a server brand-kit failure inline on the website field", async () => {
  const previousFetch = globalThis.fetch;
  const pushCalls: string[] = [];
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: "brand_kit_fetch_failed",
        message: WEBSITE_UNREACHABLE_COPY,
        fieldErrors: { websiteUrl: WEBSITE_UNREACHABLE_COPY },
      }),
      { status: 422, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  try {
    const { act, create } = await import("react-test-renderer");
    let root!: import("react-test-renderer").ReactTestRenderer;

    await act(async () => {
      root = create(
        React.createElement(MarketingNewJobScreenContent, {
          embedded: true,
          router: {
            push(href: string) {
              pushCalls.push(href);
            },
          },
        }),
      );
      await flushMicrotasks();
    });

    const websiteInput = root.root.findByProps({ placeholder: "https://yourbrand.com" });
    await act(async () => {
      websiteInput.props.onChange({ target: { value: "https://unreachable.example" } });
      await flushMicrotasks();
    });

    const form = root.root.findByType("form");
    await act(async () => {
      await form.props.onSubmit({ preventDefault() {} });
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const rendered = JSON.stringify(root.toJSON());
    // The one-line sentence renders inline at the website field...
    assert.match(rendered, new RegExp(WEBSITE_UNREACHABLE_COPY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    // ...and the raw machine code never reaches the operator.
    assert.doesNotMatch(rendered, /brand_kit_fetch_failed/);
    assert.deepEqual(pushCalls, []);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("marketing new-job form surfaces a fieldError for an unrendered field in the top alert", async () => {
  // businessType has no input on this form — its server fieldError must fall
  // back to the alert instead of being silently dropped.
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        error: "missing_required_fields:payload.businessType",
        message: BUSINESS_TYPE_MISSING_COPY,
        fieldErrors: { businessType: BUSINESS_TYPE_MISSING_COPY },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    )) as typeof fetch;

  try {
    const { act, create } = await import("react-test-renderer");
    let root!: import("react-test-renderer").ReactTestRenderer;

    await act(async () => {
      root = create(
        React.createElement(MarketingNewJobScreenContent, {
          embedded: true,
          router: { push() {} },
        }),
      );
      await flushMicrotasks();
    });

    const websiteInput = root.root.findByProps({ placeholder: "https://yourbrand.com" });
    await act(async () => {
      websiteInput.props.onChange({ target: { value: "https://example.com" } });
      await flushMicrotasks();
    });

    const form = root.root.findByType("form");
    await act(async () => {
      await form.props.onSubmit({ preventDefault() {} });
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const rendered = JSON.stringify(root.toJSON());
    assert.match(rendered, new RegExp(BUSINESS_TYPE_MISSING_COPY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(rendered, /missing_required_fields/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("marketing new-job form still shows a server field error dismissed mid-flight", async () => {
  // Editing a field while the request is in flight adds it to dismissedFields;
  // the arriving server failure must clear dismissals so its red box renders —
  // otherwise the submit fails with zero visible feedback.
  const previousFetch = globalThis.fetch;
  let resolveResponse!: (response: Response) => void;
  globalThis.fetch = (async () =>
    new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    })) as typeof fetch;
  // The submit-progress effect calls window.setInterval while the request is
  // in flight; give the node test env a minimal window.
  const previousWindow = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).window = {
    setInterval: setInterval.bind(globalThis),
    clearInterval: clearInterval.bind(globalThis),
  };

  try {
    const { act, create } = await import("react-test-renderer");
    let root!: import("react-test-renderer").ReactTestRenderer;

    await act(async () => {
      root = create(
        React.createElement(MarketingNewJobScreenContent, {
          embedded: true,
          router: { push() {} },
        }),
      );
      await flushMicrotasks();
    });

    const websiteInput = root.root.findByProps({ placeholder: "https://yourbrand.com" });
    await act(async () => {
      websiteInput.props.onChange({ target: { value: "https://unreachable.example" } });
      await flushMicrotasks();
    });

    const form = root.root.findByType("form");
    await act(async () => {
      form.props.onSubmit({ preventDefault() {} });
      await flushMicrotasks();
    });

    // Mid-flight edit dismisses the (not-yet-existing) websiteUrl error.
    await act(async () => {
      websiteInput.props.onChange({ target: { value: "https://unreachable2.example" } });
      await flushMicrotasks();
    });

    await act(async () => {
      resolveResponse(
        new Response(
          JSON.stringify({
            error: "brand_kit_fetch_failed",
            message: WEBSITE_UNREACHABLE_COPY,
            fieldErrors: { websiteUrl: WEBSITE_UNREACHABLE_COPY },
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
      );
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const rendered = JSON.stringify(root.toJSON());
    assert.match(rendered, new RegExp(WEBSITE_UNREACHABLE_COPY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = previousWindow;
    }
  }
});
