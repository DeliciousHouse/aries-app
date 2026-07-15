import assert from "node:assert/strict";
import test from "node:test";

import React from "react";

import { SocialContentNewJobScreenContent } from "../frontend/social-content/new-job";
import { WEBSITE_UNREACHABLE_COPY } from "../lib/marketing-create-errors";

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("social content form blocks missing required brand URL, business type, and goal", async () => {
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
        React.createElement(SocialContentNewJobScreenContent, {
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

    const form = root.root.findByType("form");

    await act(async () => {
      await form.props.onSubmit({ preventDefault() {} });
      await flushMicrotasks();
    });
    assert.match(JSON.stringify(root.toJSON()), /Website URL is required\./);

    const websiteInput = root.root.findByProps({ placeholder: "https://yourbusiness.com" });
    await act(async () => {
      websiteInput.props.onChange({ target: { value: "https://example.com" } });
      await flushMicrotasks();
    });
    await act(async () => {
      await form.props.onSubmit({ preventDefault() {} });
      await flushMicrotasks();
    });
    assert.match(JSON.stringify(root.toJSON()), /Business type is required\./);

    const businessTypeInput = root.root.findByProps({
      placeholder: "Fitness studio, SaaS, local service...",
    });
    await act(async () => {
      businessTypeInput.props.onChange({ target: { value: "Fitness studio" } });
      await flushMicrotasks();
    });
    await act(async () => {
      await form.props.onSubmit({ preventDefault() {} });
      await flushMicrotasks();
    });
    assert.match(JSON.stringify(root.toJSON()), /Weekly goal is required\./);
    assert.deepEqual(pushCalls, []);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("social content form submits defaults and navigates to social-content status", async () => {
  const previousFetch = globalThis.fetch;
  const pushCalls: string[] = [];
  const fetchCalls: Array<{ url: string; body: FormData | null }> = [];

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({
      url: typeof input === "string" ? input : input.toString(),
      body: init?.body instanceof FormData ? init.body : null,
    });
    return new Response(JSON.stringify({ jobId: "job_123" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const { act, create } = await import("react-test-renderer");
    let root!: import("react-test-renderer").ReactTestRenderer;

    await act(async () => {
      root = create(
        React.createElement(SocialContentNewJobScreenContent, {
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

    const websiteInput = root.root.findByProps({ placeholder: "https://yourbusiness.com" });
    const businessTypeInput = root.root.findByProps({
      placeholder: "Fitness studio, SaaS, local service...",
    });
    const goalInput = root.root.findByProps({
      placeholder: "Get more consultation calls, promote a launch, book demos...",
    });
    const form = root.root.findByType("form");

    await act(async () => {
      websiteInput.props.onChange({ target: { value: "https://example.com" } });
      businessTypeInput.props.onChange({ target: { value: "SaaS" } });
      goalInput.props.onChange({ target: { value: "Book demos" } });
      await flushMicrotasks();
    });
    await act(async () => {
      await form.props.onSubmit({ preventDefault() {} });
      await flushMicrotasks();
      await flushMicrotasks();
    });

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]?.url, "/api/social-content/jobs");
    const submitted = fetchCalls[0]?.body;
    assert.ok(submitted);

    assert.equal(submitted?.get("postWindowDays"), "7");
    assert.equal(submitted?.get("staticPostCount"), "7");
    assert.equal(submitted?.get("imageCreativeCount"), "6");
    assert.equal(submitted?.get("videoScriptCount"), "1");
    assert.equal(submitted?.get("videoRenderCount"), "0");
    assert.equal(submitted?.get("renderVideoAfterApproval"), "false");
    assert.deepEqual(submitted?.getAll("channels"), ["meta", "instagram"]);
    assert.deepEqual(submitted?.getAll("forbiddenVisualPatterns"), [
      "split-screen",
      "before/after",
      "side-by-side comparison",
      "two-panel layout",
      "old way vs new way",
      "generic stock office",
      "fake UI screenshot",
      "garbled text",
      "extra logos",
    ]);
    assert.equal(pushCalls[0], "/social-content/status?jobId=job_123");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("social content form renders server fieldErrors inline and hides raw codes (AA-131)", async () => {
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
        React.createElement(SocialContentNewJobScreenContent, {
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

    const websiteInput = root.root.findByProps({ placeholder: "https://yourbusiness.com" });
    const businessTypeInput = root.root.findByProps({
      placeholder: "Fitness studio, SaaS, local service...",
    });
    const goalInput = root.root.findByProps({
      placeholder: "Get more consultation calls, promote a launch, book demos...",
    });
    await act(async () => {
      websiteInput.props.onChange({ target: { value: "https://unreachable.example" } });
      businessTypeInput.props.onChange({ target: { value: "SaaS" } });
      goalInput.props.onChange({ target: { value: "Book demos" } });
      await flushMicrotasks();
    });

    const form = root.root.findByType("form");
    await act(async () => {
      await form.props.onSubmit({ preventDefault() {} });
      await flushMicrotasks();
      await flushMicrotasks();
    });

    const rendered = JSON.stringify(root.toJSON());
    const copyPattern = new RegExp(WEBSITE_UNREACHABLE_COPY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    assert.match(rendered, copyPattern);
    assert.doesNotMatch(rendered, /brand_kit_fetch_failed/);
    assert.deepEqual(pushCalls, []);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
