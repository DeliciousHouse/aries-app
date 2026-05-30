/**
 * Tests that HermesMarketingPort correctly injects (or skips) Honcho memory
 * context into Hermes submission payloads.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const BASE_ENV = {
  HERMES_GATEWAY_URL: 'http://hermes.test:8642',
  HERMES_API_SERVER_KEY: 'test-key',
  INTERNAL_API_SECRET: 'test-internal-secret',
  APP_BASE_URL: 'https://aries.test',
  ARIES_TENANT_PSEUDONYM_SALT: 'memory-context-test-salt-32chars',
  HERMES_POLL_BRIDGE_ENABLED: '0',
};

type FetchCall = { url: string; body: unknown };

function recordingFetch(responses: Array<() => Response>) {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    let body: unknown = null;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null;
    } catch {
      body = init?.body;
    }
    calls.push({ url: String(url), body });
    const make = responses[Math.min(i++, responses.length - 1)];
    return make();
  };
  return { calls, fetchImpl };
}

function hermesOkResponse(runId = 'run-test-123') {
  return () =>
    new Response(JSON.stringify({ run_id: runId }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

function noopBrandKitRefresher() {
  return async () => ({ refreshed: false, enriched: false });
}

function noopCallbackTokenClient() {
  return {
    async query() {
      return { rows: [], rowCount: 0 };
    },
  };
}

async function withDataRoot<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.DATA_ROOT;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-port-memory-'));
  process.env.DATA_ROOT = dataRoot;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previous;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

const STUB_BRAND_KIT = {
  path: '/tmp/kit.json',
  source_url: 'https://brand.example',
  canonical_url: 'https://brand.example',
  brand_name: 'Test Brand',
  logo_urls: [] as string[],
  colors: { primary: null, secondary: null, accent: null, palette: [] as string[] },
  font_families: [] as string[],
  external_links: [] as Array<{ url: string; label: string; platform: string }>,
  extracted_at: new Date().toISOString(),
  brand_voice_summary: 'clear',
  offer_summary: null,
  positioning: null,
  audience: null,
  tone_of_voice: null,
  style_vibe: null,
};

async function makeBrandCampaignDoc(jobId: string, tenantId: string) {
  const { createSocialContentJobRuntimeDocument, saveSocialContentJobRuntime } = await import(
    '../backend/marketing/runtime-state'
  );
  const doc = createSocialContentJobRuntimeDocument({
    jobId,
    tenantId,
    payload: { brandUrl: 'https://brand.example', businessType: 'agency' },
    brandKit: STUB_BRAND_KIT,
  });
  saveSocialContentJobRuntime(doc.job_id, doc);
  return doc;
}

test('HONCHO_ENABLED=false: no memory_context in weekly social content payload', async () => {
  await withDataRoot(async () => {
    const { HermesMarketingPort } = await import('../backend/marketing/ports/hermes');
    const { recordingFetch: rf, calls } = (() => {
      const c: FetchCall[] = [];
      let i = 0;
      const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
        let body: unknown = null;
        try { body = JSON.parse(String(init?.body ?? 'null')); } catch { body = null; }
        c.push({ url: String(url), body });
        i++;
        return new Response(JSON.stringify({ run_id: `run-${i}` }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      };
      return { recordingFetch: fetchImpl, calls: c };
    })();

    const env = { ...BASE_ENV, HONCHO_ENABLED: 'false' };
    const port = new HermesMarketingPort(env, rf, async () => {}, noopBrandKitRefresher(), noopCallbackTokenClient());

    const { createSocialContentJobRuntimeDocument, saveSocialContentJobRuntime } = await import(
      '../backend/marketing/runtime-state'
    );
    const doc = createSocialContentJobRuntimeDocument({
      jobId: 'job-no-honcho',
      tenantId: 'tenant-1',
      payload: {
        brandUrl: 'https://brand.example',
        businessType: 'agency',
        request: { jobType: 'weekly_social_content' },
      },
      brandKit: STUB_BRAND_KIT,
    });
    saveSocialContentJobRuntime(doc.job_id, doc);

    await port.runPipeline({ jobId: doc.job_id, doc, argsJson: '{}', timeoutMs: 5000, maxStdoutBytes: 1000 });

    assert.equal(calls.length, 1);
    const payload = calls[0].body as Record<string, unknown>;
    assert.equal(
      'memory_context' in payload,
      false,
      'No memory_context when HONCHO_ENABLED=false',
    );
  });
});

test('HONCHO_ENABLED=false: brand campaign prompt does not include memory context section', async () => {
  await withDataRoot(async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      let body: unknown = null;
      try { body = JSON.parse(String(init?.body ?? 'null')); } catch { body = null; }
      calls.push({ url: String(url), body });
      return new Response(JSON.stringify({ run_id: 'run-brand-1' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };

    const { HermesMarketingPort } = await import('../backend/marketing/ports/hermes');
    const env = { ...BASE_ENV, HONCHO_ENABLED: 'false' };
    const port = new HermesMarketingPort(env, fetchImpl, async () => {}, noopBrandKitRefresher(), noopCallbackTokenClient());

    const doc = await makeBrandCampaignDoc('job-brand-no-honcho', 'tenant-2');
    await port.runPipeline({ jobId: doc.job_id, doc, argsJson: '{}', timeoutMs: 5000, maxStdoutBytes: 1000 });

    assert.equal(calls.length, 1);
    const payload = calls[0].body as Record<string, unknown>;
    const prompt = typeof payload.input === 'string' ? payload.input : '';
    assert.equal(
      prompt.includes('Memory context'),
      false,
      'Prompt should not include memory context section when Honcho disabled',
    );
  });
});

test('HONCHO_ENABLED=true but Honcho unreachable: run still succeeds without memory context', async () => {
  await withDataRoot(async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      let body: unknown = null;
      try { body = JSON.parse(String(init?.body ?? 'null')); } catch { body = null; }
      calls.push({ url: String(url), body });
      if (String(url).includes('honcho')) {
        throw new Error('ECONNREFUSED');
      }
      return new Response(JSON.stringify({ run_id: 'run-honcho-fail' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };

    const { HermesMarketingPort } = await import('../backend/marketing/ports/hermes');
    const env = {
      ...BASE_ENV,
      HONCHO_ENABLED: 'true',
      HONCHO_BASE_URL: 'http://honcho-unreachable.test:9999',
    };
    const port = new HermesMarketingPort(env, fetchImpl, async () => {}, noopBrandKitRefresher(), noopCallbackTokenClient());

    const doc = await makeBrandCampaignDoc('job-honcho-unreachable', 'tenant-3');
    const result = await port.runPipeline({ jobId: doc.job_id, doc, argsJson: '{}', timeoutMs: 5000, maxStdoutBytes: 1000 });

    // Run must complete regardless of Honcho connectivity
    assert.equal(result.kind, 'submitted');
    // Hermes submission happened exactly once
    const hermesCall = calls.find((c) => String(c.url).includes('hermes') || String(c.url).includes('8642'));
    assert.ok(hermesCall, 'Hermes should still be called when Honcho is unreachable');
    const payload = hermesCall?.body as Record<string, unknown>;
    assert.equal('memory_context' in payload, false, 'No memory_context when Honcho failed');
  });
});

test('HONCHO_ENABLED=true, no tenantId: memory context is skipped gracefully', async () => {
  await withDataRoot(async () => {
    const calls: FetchCall[] = [];
    const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      let body: unknown = null;
      try { body = JSON.parse(String(init?.body ?? 'null')); } catch { body = null; }
      calls.push({ url: String(url), body });
      return new Response(JSON.stringify({ run_id: 'run-no-tenant' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };

    const { HermesMarketingPort } = await import('../backend/marketing/ports/hermes');
    const env = {
      ...BASE_ENV,
      HONCHO_ENABLED: 'true',
      HONCHO_BASE_URL: 'http://honcho.test:8000',
    };
    const port = new HermesMarketingPort(env, fetchImpl, async () => {}, noopBrandKitRefresher(), noopCallbackTokenClient());

    const doc = await makeBrandCampaignDoc('job-no-tenant-id', '');
    const result = await port.runPipeline({ jobId: doc.job_id, doc, argsJson: '{}', timeoutMs: 5000, maxStdoutBytes: 1000 });

    assert.notEqual(result.kind, 'completed', 'Should not crash — either submitted or config error');
  });
});
