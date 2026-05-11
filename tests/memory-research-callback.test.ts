import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import pool from '../lib/db';
import type { HonchoTransport } from '../backend/memory/honcho-client';
import type { ResearchJob } from '../backend/memory/research-jobs';

const SALT = 'callback-test-salt-1234567890ab';
const INTERNAL_SECRET = 'test-internal-secret';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function makeCtx(overrides?: Partial<{ secret: string }>): { secret: string } {
  return { secret: overrides?.secret ?? INTERNAL_SECRET };
}

function callbackRequest(body: unknown, opts?: { bearer?: string }): Request {
  return new Request('https://aries.example.com/api/internal/aries-research/callback', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts?.bearer ?? INTERNAL_SECRET}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

type FindingRow = {
  id: string;
  job_id: string;
  raw: Record<string, unknown>;
  curator_decision: string;
  peer: string | null;
  approved_message_id: string | null;
};

function makeDbHarness(job: ResearchJob) {
  const jobs = new Map<string, ResearchJob>([[job.id, { ...job }]]);
  const findings: FindingRow[] = [];

  async function query(sql: string, params: unknown[] = []) {
    const text = String(sql);

    if (text.includes('FROM aries_research_jobs') && text.includes('WHERE id = $1') && params.length === 1) {
      const row = jobs.get(String(params[0]));
      if (!row) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          id: row.id,
          tenant_id: row.tenant_id,
          status: row.status,
          task_spec: row.task_spec,
          callback_token_hash: row.callback_token_hash,
          hermes_envelope: row.hermes_envelope,
          created_at: row.created_at,
          updated_at: row.updated_at,
        }],
        rowCount: 1,
      };
    }

    if (text.includes('SET hermes_envelope') && text.includes('WHERE id = $2')) {
      const id = String(params[1]);
      const row = jobs.get(id);
      if (row) row.hermes_envelope = params[0] as ResearchJob['hermes_envelope'];
      return { rows: [], rowCount: 1 };
    }

    if (text.includes('INSERT INTO aries_research_findings')) {
      findings.push({
        id: String(params[0]),
        job_id: String(params[1]),
        raw: params[2] as Record<string, unknown>,
        curator_decision: String(params[3]),
        peer: params[4] != null ? String(params[4]) : null,
        approved_message_id: params[5] != null ? String(params[5]) : null,
      });
      return { rows: [], rowCount: 1 };
    }

    if (text.includes('SET status = $1') && text.includes('WHERE id = $2')) {
      const id = String(params[1]);
      const row = jobs.get(id);
      if (row) row.status = params[0] as ResearchJob['status'];
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unhandled SQL in research-callback harness: ${text.slice(0, 120)}`);
  }

  return { jobs, findings, query };
}

type TransportCall = { method: string; path: string; workspaceId: string; body?: unknown };

function recordingTransport(): { transport: HonchoTransport; calls: TransportCall[] } {
  const calls: TransportCall[] = [];
  return {
    calls,
    transport: {
      async request<T>(args: { method: string; path: string; workspaceId: string; body?: unknown }): Promise<T> {
        calls.push({ method: args.method, path: args.path, workspaceId: args.workspaceId, body: args.body });
        return { id: `msg-${calls.length}`, items: [] } as unknown as T;
      },
    },
  };
}

async function withEnv<T>(run: () => Promise<T>): Promise<T> {
  const prevSalt = process.env.ARIES_TENANT_PSEUDONYM_SALT;
  const prevSecret = process.env.INTERNAL_API_SECRET;
  process.env.ARIES_TENANT_PSEUDONYM_SALT = SALT;
  process.env.INTERNAL_API_SECRET = INTERNAL_SECRET;
  try {
    return await run();
  } finally {
    if (prevSalt === undefined) delete process.env.ARIES_TENANT_PSEUDONYM_SALT;
    else process.env.ARIES_TENANT_PSEUDONYM_SALT = prevSalt;
    if (prevSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = prevSecret;
  }
}

const NOW = '2026-05-08T00:00:00.000Z';

function makeJob(callbackToken: string): ResearchJob {
  return {
    id: randomUUID(),
    tenant_id: 'tenant-callback-test',
    status: 'submitted',
    task_spec: {},
    callback_token_hash: sha256Hex(callbackToken),
    hermes_envelope: null,
    created_at: NOW,
    updated_at: NOW,
  };
}

const CALLBACK_TOKEN = 'callback-token-' + 'x'.repeat(48);

const VALID_ENVELOPE = {
  status: 'ok' as const,
  findings: [
    {
      kind: 'fact',
      claim: 'Acme was founded in 2018.',
      sources: [{ url: 'https://acme.example.com/about', fetched_at: NOW, trust: 'first_party' }],
      confidence: 0.9,
    },
    {
      kind: 'research_conclusion',
      claim: 'Competitor X repositioned upmarket.',
      sources: [{ url: 'https://news.example.com/article', fetched_at: NOW, trust: 'third_party' }],
      confidence: 0.95,
    },
    {
      kind: 'fact',
      claim: 'Uncertain claim about something.',
      sources: [{ url: 'https://acme.example.com/maybe', fetched_at: NOW, trust: 'first_party' }],
      confidence: 0.4,
    },
    {
      kind: 'fact',
      claim: '',
      sources: [],
      confidence: 0.9,
    },
  ],
};

test('happy path: correct counts, Honcho write for auto-approved only, status becomes needs_review', async (t) => {
  await withEnv(async () => {
    const job = makeJob(CALLBACK_TOKEN);
    const harness = makeDbHarness(job);
    const { transport, calls } = recordingTransport();

    t.mock.method(pool, 'query', harness.query as typeof pool.query);

    const { handleResearchCallback: POST } = await import('../app/api/internal/aries-research/callback/route');

    const req = callbackRequest({
      jobId: job.id,
      callbackToken: CALLBACK_TOKEN,
      envelope: VALID_ENVELOPE,
    });

    const res = await POST(req, { transport });
    assert.equal(res.status, 200);

    const body = await res.json() as { ok: boolean; counts: { approved: number; queued: number; dropped: number } };
    assert.equal(body.ok, true);
    assert.equal(body.counts.approved, 1);
    assert.equal(body.counts.queued, 1);
    assert.equal(body.counts.dropped, 2);
  });
});

test('all 4 findings recorded in aries_research_findings', async (t) => {
  await withEnv(async () => {
    const job = makeJob(CALLBACK_TOKEN);
    const harness = makeDbHarness(job);
    const { transport } = recordingTransport();

    t.mock.method(pool, 'query', harness.query as typeof pool.query);

    const { handleResearchCallback: POST } = await import('../app/api/internal/aries-research/callback/route');

    await POST(callbackRequest({
      jobId: job.id,
      callbackToken: CALLBACK_TOKEN,
      envelope: VALID_ENVELOPE,
    }), { transport });

    assert.equal(harness.findings.length, 4, 'all 4 findings must be recorded');
  });
});

test('only auto-approved finding reaches Honcho transport', async (t) => {
  await withEnv(async () => {
    const job = makeJob(CALLBACK_TOKEN);
    const harness = makeDbHarness(job);
    const { transport, calls } = recordingTransport();

    t.mock.method(pool, 'query', harness.query as typeof pool.query);

    const { handleResearchCallback: POST } = await import('../app/api/internal/aries-research/callback/route');

    await POST(callbackRequest({
      jobId: job.id,
      callbackToken: CALLBACK_TOKEN,
      envelope: VALID_ENVELOPE,
    }), { transport });

    const writes = calls.filter(c => c.method === 'POST');
    assert.equal(writes.length, 1, 'exactly one Honcho write for the auto-approved fact');
    const writtenBody = writes[0].body as Record<string, unknown>;
    const content = JSON.parse(writtenBody.content as string) as { claim: string };
    assert.equal(content.claim, 'Acme was founded in 2018.');
  });
});

test('job status flips to needs_review when something is queued', async (t) => {
  await withEnv(async () => {
    const job = makeJob(CALLBACK_TOKEN);
    const harness = makeDbHarness(job);
    const { transport } = recordingTransport();

    t.mock.method(pool, 'query', harness.query as typeof pool.query);

    const { handleResearchCallback: POST } = await import('../app/api/internal/aries-research/callback/route');

    await POST(callbackRequest({
      jobId: job.id,
      callbackToken: CALLBACK_TOKEN,
      envelope: VALID_ENVELOPE,
    }), { transport });

    const updatedJob = harness.jobs.get(job.id);
    assert.equal(updatedJob?.status, 'needs_review');
  });
});

test('wrong callback token returns 403', async (t) => {
  await withEnv(async () => {
    const job = makeJob(CALLBACK_TOKEN);
    const harness = makeDbHarness(job);
    const { transport } = recordingTransport();

    t.mock.method(pool, 'query', harness.query as typeof pool.query);

    const { handleResearchCallback: POST } = await import('../app/api/internal/aries-research/callback/route');

    const res = await POST(callbackRequest({
      jobId: job.id,
      callbackToken: 'wrong-token',
      envelope: VALID_ENVELOPE,
    }), { transport });

    assert.equal(res.status, 403);
    const body = await res.json() as { status: string; reason: string };
    assert.equal(body.reason, 'invalid_callback_token');
  });
});

test('unknown jobId returns 404', async (t) => {
  await withEnv(async () => {
    const job = makeJob(CALLBACK_TOKEN);
    const harness = makeDbHarness(job);
    const { transport } = recordingTransport();

    t.mock.method(pool, 'query', harness.query as typeof pool.query);

    const { handleResearchCallback: POST } = await import('../app/api/internal/aries-research/callback/route');

    const res = await POST(callbackRequest({
      jobId: randomUUID(),
      callbackToken: CALLBACK_TOKEN,
      envelope: VALID_ENVELOPE,
    }), { transport });

    assert.equal(res.status, 404);
  });
});

test('missing INTERNAL_API_SECRET bearer returns 401 or 403', async (t) => {
  await withEnv(async () => {
    const job = makeJob(CALLBACK_TOKEN);
    const harness = makeDbHarness(job);
    const { transport } = recordingTransport();

    t.mock.method(pool, 'query', harness.query as typeof pool.query);

    const { handleResearchCallback: POST } = await import('../app/api/internal/aries-research/callback/route');

    const res = await POST(callbackRequest({
      jobId: job.id,
      callbackToken: CALLBACK_TOKEN,
      envelope: VALID_ENVELOPE,
    }, { bearer: 'wrong-secret' }), { transport });

    assert.ok(res.status === 401 || res.status === 403, `expected 401 or 403, got ${res.status}`);
  });
});
