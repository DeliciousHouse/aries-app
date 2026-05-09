import { randomUUID } from 'node:crypto';
import pool from '@/lib/db';
import type { TenantContext } from '@/lib/tenant-context';
import type { CuratorOutcome, ResearchEnvelope } from './types';

export type ResearchJobStatus =
  | 'pending'
  | 'submitted'
  | 'completed'
  | 'partial'
  | 'needs_review'
  | 'failed';

export type ResearchJob = {
  id: string;
  tenant_id: string;
  status: ResearchJobStatus;
  task_spec: Record<string, unknown>;
  callback_token_hash: string;
  hermes_envelope: ResearchEnvelope | null;
  created_at: string;
  updated_at: string;
};

export type ResearchFinding = {
  id: string;
  job_id: string;
  raw: Record<string, unknown>;
  curator_decision: string;
  peer: string | null;
  approved_message_id: string | null;
  created_at: string;
};

type Queryable = {
  query(sql: string, params: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
};

export async function ensureResearchJobSchema(client: Queryable = pool): Promise<void> {
  await client.query(
    `
    CREATE TABLE IF NOT EXISTS aries_research_jobs (
      id UUID PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      task_spec JSONB NOT NULL DEFAULT '{}',
      callback_token_hash TEXT NOT NULL,
      hermes_envelope JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    `,
    [],
  );
  await client.query(
    `
    CREATE TABLE IF NOT EXISTS aries_research_findings (
      id UUID PRIMARY KEY,
      job_id UUID NOT NULL REFERENCES aries_research_jobs(id) ON DELETE CASCADE,
      raw JSONB NOT NULL,
      curator_decision TEXT NOT NULL,
      peer TEXT,
      approved_message_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
    `,
    [],
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_aries_research_jobs_tenant_id ON aries_research_jobs(tenant_id)`,
    [],
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_aries_research_findings_job_id ON aries_research_findings(job_id)`,
    [],
  );
}

export async function createJob(
  ctx: Pick<TenantContext, 'tenantId'>,
  taskSpec: Record<string, unknown>,
  callbackTokenHash: string,
  client: Queryable = pool,
): Promise<ResearchJob> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await client.query(
    `
    INSERT INTO aries_research_jobs (id, tenant_id, status, task_spec, callback_token_hash, created_at, updated_at)
    VALUES ($1, $2, 'pending', $3, $4, $5, $5)
    `,
    [id, String(ctx.tenantId), JSON.stringify(taskSpec), callbackTokenHash, now],
  );
  return {
    id,
    tenant_id: String(ctx.tenantId),
    status: 'pending',
    task_spec: taskSpec,
    callback_token_hash: callbackTokenHash,
    hermes_envelope: null,
    created_at: now,
    updated_at: now,
  };
}

export async function recordEnvelope(
  jobId: string,
  envelope: ResearchEnvelope,
  client: Queryable = pool,
): Promise<void> {
  await client.query(
    `
    UPDATE aries_research_jobs
    SET hermes_envelope = $1, updated_at = NOW()
    WHERE id = $2
    `,
    [JSON.stringify(envelope), jobId],
  );
}

export async function recordFinding(
  jobId: string,
  finding: Record<string, unknown>,
  outcome: CuratorOutcome,
  approvedMessageId?: string | null,
  client: Queryable = pool,
): Promise<void> {
  const id = randomUUID();
  const peer = outcome.decision !== 'drop' ? (outcome.peer ?? null) : null;
  await client.query(
    `
    INSERT INTO aries_research_findings (id, job_id, raw, curator_decision, peer, approved_message_id)
    VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [id, jobId, JSON.stringify(finding), outcome.decision, peer, approvedMessageId ?? null],
  );
}

export async function setStatus(
  jobId: string,
  status: ResearchJobStatus,
  client: Queryable = pool,
): Promise<void> {
  await client.query(
    `
    UPDATE aries_research_jobs
    SET status = $1, updated_at = NOW()
    WHERE id = $2
    `,
    [status, jobId],
  );
}

export async function getJob(
  ctx: Pick<TenantContext, 'tenantId'>,
  jobId: string,
  client: Queryable = pool,
): Promise<ResearchJob | null> {
  const result = await client.query(
    `
    SELECT id, tenant_id, status, task_spec, callback_token_hash, hermes_envelope, created_at, updated_at
    FROM aries_research_jobs
    WHERE id = $1 AND tenant_id = $2
    LIMIT 1
    `,
    [jobId, String(ctx.tenantId)],
  );
  const row = result.rows[0];
  if (!row) return null;
  return rowToJob(row);
}

export type ResearchFindingRow = {
  id: string;
  job_id: string;
  raw: Record<string, unknown>;
  curator_decision: string;
  peer: string | null;
  approved_message_id: string | null;
  created_at: string;
  job_status: ResearchJobStatus | null;
};

export async function listQueuedResearchFindingsForTenant(
  tenantId: string,
  options: { limit?: number } = {},
  client: Queryable = pool,
): Promise<ResearchFindingRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const result = await client.query(
    `
    SELECT
      f.id,
      f.job_id,
      f.raw,
      f.curator_decision,
      f.peer,
      f.approved_message_id,
      f.created_at,
      j.status AS job_status
    FROM aries_research_findings f
    INNER JOIN aries_research_jobs j ON j.id = f.job_id
    WHERE j.tenant_id = $1
      AND f.curator_decision = 'queue_for_review'
    ORDER BY f.created_at DESC
    LIMIT $2
    `,
    [String(tenantId), limit],
  );

  return result.rows.map((row: Record<string, unknown>) => ({
    id: String(row.id),
    job_id: String(row.job_id),
    raw: (row.raw ?? {}) as Record<string, unknown>,
    curator_decision: String(row.curator_decision),
    peer: row.peer == null ? null : String(row.peer),
    approved_message_id: row.approved_message_id == null ? null : String(row.approved_message_id),
    created_at: String(row.created_at),
    job_status: (row.job_status == null ? null : String(row.job_status)) as ResearchJobStatus | null,
  }));
}

export async function getJobById(
  jobId: string,
  client: Queryable = pool,
): Promise<ResearchJob | null> {
  const result = await client.query(
    `
    SELECT id, tenant_id, status, task_spec, callback_token_hash, hermes_envelope, created_at, updated_at
    FROM aries_research_jobs
    WHERE id = $1
    LIMIT 1
    `,
    [jobId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return rowToJob(row);
}

function rowToJob(row: Record<string, unknown>): ResearchJob {
  return {
    id: String(row.id),
    tenant_id: String(row.tenant_id),
    status: String(row.status) as ResearchJobStatus,
    task_spec: (row.task_spec ?? {}) as Record<string, unknown>,
    callback_token_hash: String(row.callback_token_hash),
    hermes_envelope: row.hermes_envelope as ResearchEnvelope | null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}
