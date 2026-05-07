import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import pool from '../lib/db';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

type DraftRow = {
  draft_id: string;
  status: string;
  website_url: string;
  business_name: string;
  business_type: string;
  approver_name: string;
  channels: string[];
  goal: string;
  offer: string;
  competitor_url: string;
  preview: unknown;
  provenance: unknown;
  materialized_tenant_id: string | null;
  materialized_job_id: string | null;
  created_at: Date;
  updated_at: Date;
};

type QueryResult<T = Record<string, unknown>> = { rows: T[]; rowCount: number };
type QueryHandler = (sql: string, params?: unknown[]) => Promise<QueryResult> | QueryResult;

function installDbMock(t: TestContext, handler: QueryHandler): void {
  t.mock.method(pool, 'query', (async (sql: string, params?: unknown[]) =>
    handler(String(sql), params ?? [])) as typeof pool.query);
}

function createDraftDbMock(): QueryHandler {
  const drafts = new Map<string, DraftRow>();

  return (sql, params = []) => {
    const text = sql.trim();
    const now = new Date();

    if (text.startsWith('INSERT INTO onboarding_drafts')) {
      const [
        draftId,
        status,
        websiteUrl,
        businessName,
        businessType,
        approverName,
        channels,
        goal,
        offer,
        competitorUrl,
        preview,
        provenance,
        materializedTenantId,
        materializedJobId,
      ] = params as [string, string, string, string, string, string, string[], string, string, string, unknown, unknown, string | null, string | null];
      const row: DraftRow = {
        draft_id: draftId,
        status,
        website_url: websiteUrl,
        business_name: businessName,
        business_type: businessType,
        approver_name: approverName,
        channels,
        goal,
        offer,
        competitor_url: competitorUrl,
        preview,
        provenance,
        materialized_tenant_id: materializedTenantId,
        materialized_job_id: materializedJobId,
        created_at: now,
        updated_at: now,
      };
      drafts.set(draftId, row);
      return { rows: [row], rowCount: 1 };
    }

    if (text.startsWith('SELECT * FROM onboarding_drafts WHERE draft_id = $1')) {
      const draftId = String(params[0] ?? '');
      const row = drafts.get(draftId);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (text.startsWith('UPDATE onboarding_drafts SET')) {
      const [
        draftId,
        status,
        websiteUrl,
        businessName,
        businessType,
        approverName,
        channels,
        goal,
        offer,
        competitorUrl,
        preview,
        provenance,
        materializedTenantId,
        materializedJobId,
      ] = params as [string, string, string, string, string, string, string[], string, string, string, unknown, unknown, string | null, string | null];
      const current = drafts.get(draftId);
      if (!current) return { rows: [], rowCount: 0 };
      const row: DraftRow = {
        ...current,
        status,
        website_url: websiteUrl,
        business_name: businessName,
        business_type: businessType,
        approver_name: approverName,
        channels,
        goal,
        offer,
        competitor_url: competitorUrl,
        preview,
        provenance,
        materialized_tenant_id: materializedTenantId,
        materialized_job_id: materializedJobId,
        updated_at: now,
      };
      drafts.set(draftId, row);
      return { rows: [row], rowCount: 1 };
    }

    throw new Error(`unexpected query: ${text}`);
  };
}


async function withDraftEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousCodeRoot = process.env.CODE_ROOT;
  const previousDataRoot = process.env.DATA_ROOT;
  const previousDbHost = process.env.DB_HOST;
  const previousDbUser = process.env.DB_USER;
  const previousDbPassword = process.env.DB_PASSWORD;
  const previousDbName = process.env.DB_NAME;
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'aries-onboarding-draft-route-'));

  process.env.CODE_ROOT = PROJECT_ROOT;
  process.env.DATA_ROOT = dataRoot;
  delete process.env.DB_HOST;
  delete process.env.DB_USER;
  delete process.env.DB_PASSWORD;
  delete process.env.DB_NAME;

  try {
    return await run();
  } finally {
    if (previousCodeRoot === undefined) delete process.env.CODE_ROOT;
    else process.env.CODE_ROOT = previousCodeRoot;
    if (previousDataRoot === undefined) delete process.env.DATA_ROOT;
    else process.env.DATA_ROOT = previousDataRoot;
    if (previousDbHost === undefined) delete process.env.DB_HOST;
    else process.env.DB_HOST = previousDbHost;
    if (previousDbUser === undefined) delete process.env.DB_USER;
    else process.env.DB_USER = previousDbUser;
    if (previousDbPassword === undefined) delete process.env.DB_PASSWORD;
    else process.env.DB_PASSWORD = previousDbPassword;
    if (previousDbName === undefined) delete process.env.DB_NAME;
    else process.env.DB_NAME = previousDbName;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

test('/api/onboarding/draft creates, reads, and updates an onboarding draft by explicit token', async (t) => {
  await withDraftEnv(async () => {
    installDbMock(t, createDraftDbMock());
    const route = await import('../app/api/onboarding/draft/route');

    const createdResponse = await route.POST();
    const createdBody = (await createdResponse.json()) as {
      draft: { draftId: string; status: string };
    };

    assert.equal(createdResponse.status, 201);
    assert.equal(createdBody.draft.status, 'draft');

    const patchResponse = await route.PATCH(
      new Request(`http://localhost/api/onboarding/draft?draft=${encodeURIComponent(createdBody.draft.draftId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          businessName: 'The FrameX',
          websiteUrl: 'https://theframex.com',
          channels: ['meta-ads'],
          goal: 'Book more design consultations',
          status: 'ready_for_auth',
        }),
      }),
    );
    const patchedBody = (await patchResponse.json()) as {
      draft: { businessName: string; websiteUrl: string; channels: string[]; goal: string; status: string };
    };

    assert.equal(patchResponse.status, 200);
    assert.equal(patchedBody.draft.businessName, 'The FrameX');
    assert.equal(patchedBody.draft.websiteUrl, 'https://theframex.com/');
    assert.deepEqual(patchedBody.draft.channels, ['meta-ads']);
    assert.equal(patchedBody.draft.goal, 'Book more design consultations');
    assert.equal(patchedBody.draft.status, 'ready_for_auth');

    const getResponse = await route.GET(
      new Request(`http://localhost/api/onboarding/draft?draft=${encodeURIComponent(createdBody.draft.draftId)}`),
    );
    const getBody = (await getResponse.json()) as {
      draft: { businessName: string; status: string };
    };

    assert.equal(getResponse.status, 200);
    assert.equal(getBody.draft.businessName, 'The FrameX');
    assert.equal(getBody.draft.status, 'ready_for_auth');
  });
});

test('/api/onboarding/draft rejects reads and writes without an explicit draft token', async (t) => {
  await withDraftEnv(async () => {
    installDbMock(t, createDraftDbMock());
    const route = await import('../app/api/onboarding/draft/route');

    const getResponse = await route.GET(new Request('http://localhost/api/onboarding/draft'));
    const getBody = (await getResponse.json()) as { error: string };
    assert.equal(getResponse.status, 400);
    assert.equal(getBody.error, 'draft_token_required');

    const patchResponse = await route.PATCH(
      new Request('http://localhost/api/onboarding/draft', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ businessName: 'The FrameX' }),
      }),
    );
    const patchBody = (await patchResponse.json()) as { error: string };
    assert.equal(patchResponse.status, 400);
    assert.equal(patchBody.error, 'draft_token_required');
  });
});


test('/api/onboarding/draft returns a safe unavailable error when persistence fails', async (t) => {
  await withDraftEnv(async () => {
    installDbMock(t, () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:5432 password=secret');
    });
    const route = await import('../app/api/onboarding/draft/route');

    const createdResponse = await route.POST();
    const createdBody = (await createdResponse.json()) as { error: string };

    assert.equal(createdResponse.status, 503);
    assert.equal(createdBody.error, 'onboarding_draft_unavailable');
    assert.doesNotMatch(createdBody.error, /ECONNREFUSED|127\.0\.0\.1|password|secret/i);
  });
});
