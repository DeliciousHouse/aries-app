import assert from 'node:assert/strict';
import test from 'node:test';

import {
  uploadReplaceCreative,
  type UploadReplaceDb,
  type UploadReplaceDeps,
  type UploadReplaceFile,
  type UploadReplaceOverride,
  type UploadReplaceResult,
} from '../backend/marketing/upload-replace';
import type { VisionQAClient } from '../backend/creative-memory/vision-qa';
import { runGcOrphanUploads, type GcDb } from '../scripts/gc-orphan-uploads';

type AcceptedResult = Extract<UploadReplaceResult, { status: 202 }>;
type ErrorResult = Exclude<UploadReplaceResult, { status: 202 }>;

function expectAccepted(result: UploadReplaceResult): asserts result is AcceptedResult {
  if (result.status !== 202) {
    assert.fail(`expected 202 accepted, got ${result.status} (${result.error.code})`);
  }
}

function expectError(result: UploadReplaceResult): asserts result is ErrorResult {
  if (result.status === 202) {
    assert.fail(`expected error response, got 202 with verdict ${result.verdict}`);
  }
}

type AssetRow = {
  id: string;
  tenant_id: number;
  storage_kind: string;
  storage_key: string | null;
  source_type: string;
  permission_scope: string;
  media_type: string;
  aspect_ratio: string | null;
  checksum: string | null;
  superseded_by: string | null;
  orphaned_at: string | null;
};

type VisionQARun = {
  tenant_id: number;
  post_id: bigint | number | null;
  creative_id: bigint | number | string | null;
  attempt_number: number;
  brand_color_match_score: number;
  text_legibility_score: number;
  forbidden_pattern_hits: number;
  brand_violation_score: number;
  verdict: string;
  model_version: string | null;
  raw_model_output: string | null;
};

class StubDb implements UploadReplaceDb, GcDb {
  rows: AssetRow[] = [];
  visionRuns: VisionQARun[] = [];
  insertedSequence = 0;

  constructor(initialRows: AssetRow[]) {
    this.rows = initialRows.map((row) => ({ ...row }));
  }

  async query(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: unknown[]; rowCount?: number | null }> {
    const trimmed = sql.replace(/\s+/g, ' ').trim();

    if (trimmed.startsWith('SELECT id, tenant_id, storage_kind')) {
      const id = String(params[0] ?? '');
      const found = this.rows.find((row) => row.id === id && row.orphaned_at === null);
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    if (trimmed.startsWith('INSERT INTO creative_assets')) {
      const tenantId = Number(params[0]);
      const storageKey = String(params[1]);
      const sha = String(params[2]);
      const aspectRatio = params[3] === null ? null : String(params[3]);
      this.insertedSequence += 1;
      const id = `asset-new-${this.insertedSequence}`;
      const row: AssetRow = {
        id,
        tenant_id: tenantId,
        storage_kind: 'ingested_asset',
        storage_key: storageKey,
        source_type: 'manual_upload',
        permission_scope: 'user_uploaded',
        media_type: 'image',
        aspect_ratio: aspectRatio,
        checksum: sha,
        superseded_by: null,
        orphaned_at: null,
      };
      this.rows.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (trimmed.startsWith('UPDATE creative_assets SET orphaned_at')) {
      const orphanedAt = String(params[0]);
      const id = String(params[1]);
      const target = this.rows.find((row) => row.id === id);
      if (target) {
        target.orphaned_at = orphanedAt;
      }
      return { rows: [], rowCount: target ? 1 : 0 };
    }

    if (trimmed.startsWith('INSERT INTO vision_qa_runs')) {
      this.visionRuns.push({
        tenant_id: Number(params[0]),
        post_id: params[1] as bigint | number | null,
        creative_id: params[2] as bigint | number | string | null,
        attempt_number: Number(params[3]),
        brand_color_match_score: Number(params[4]),
        text_legibility_score: Number(params[5]),
        forbidden_pattern_hits: Number(params[6]),
        brand_violation_score: Number(params[7]),
        verdict: String(params[8]),
        model_version: (params[9] ?? null) as string | null,
        raw_model_output: (params[10] ?? null) as string | null,
      });
      return { rows: [], rowCount: 1 };
    }

    if (trimmed.startsWith('SELECT id, tenant_id, storage_key, orphaned_at')) {
      const cutoff = String(params[0]);
      const matched = this.rows
        .filter((row) => row.orphaned_at !== null && row.orphaned_at < cutoff)
        .map((row) => ({
          id: row.id,
          tenant_id: row.tenant_id,
          storage_key: row.storage_key,
          orphaned_at: row.orphaned_at,
        }));
      return { rows: matched, rowCount: matched.length };
    }

    if (trimmed.startsWith('DELETE FROM creative_assets')) {
      const id = String(params[0]);
      const cutoff = String(params[1]);
      const before = this.rows.length;
      this.rows = this.rows.filter(
        (row) => !(row.id === id && row.orphaned_at !== null && row.orphaned_at < cutoff),
      );
      const removed = before - this.rows.length;
      return { rows: [], rowCount: removed };
    }

    return { rows: [], rowCount: 0 };
  }
}

function passClient(): VisionQAClient {
  return async () => ({
    brand_color_match: 0.91,
    text_legibility: 0.94,
    brand_violation: 0.05,
    forbidden_patterns_detected: [],
    model_version: 'vision-qa-stub-pass',
    raw: { stub: 'pass' },
  });
}

function failClient(): VisionQAClient {
  return async () => ({
    brand_color_match: 0.21,
    text_legibility: 0.4,
    brand_violation: 0.65,
    forbidden_patterns_detected: ['nsfw_explicit'],
    model_version: 'vision-qa-stub-fail',
    raw: { stub: 'fail', kind: 'nsfw' },
  });
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngBytes(seed: string): UploadReplaceFile {
  return {
    bytes: Buffer.concat([PNG_MAGIC, Buffer.from(seed, 'utf8')]),
    mimeType: 'image/png',
    fileName: `${seed}.png`,
  };
}

function buildDeps(input: {
  db: StubDb;
  visionClient: VisionQAClient;
  loadJobTenantValue?: string | null;
  fixedNow?: string;
  writes?: Array<{ path: string; bytes: Buffer }>;
}): UploadReplaceDeps {
  return {
    db: input.db,
    visionClient: input.visionClient,
    writeBytes: async (absPath, bytes) => {
      input.writes?.push({ path: absPath, bytes });
    },
    loadJobTenant:
      input.loadJobTenantValue === undefined
        ? undefined
        : async () => input.loadJobTenantValue ?? null,
    now: input.fixedNow ? () => new Date(input.fixedNow!) : undefined,
    dataRoot: '/tmp/aries-test-upload-replace',
  };
}

const BASE_ROW: AssetRow = {
  id: 'asset-existing-1',
  tenant_id: 7,
  storage_kind: 'ingested_asset',
  storage_key: '/tmp/aries-test-upload-replace/ingested-assets/7/ab/oldsha.png',
  source_type: 'generated_by_aries',
  permission_scope: 'generated',
  media_type: 'image',
  aspect_ratio: '4:5',
  checksum: 'oldsha',
  superseded_by: null,
  orphaned_at: null,
};

test('upload-replace: clean upload swaps creative and orphans the previous row', async () => {
  const db = new StubDb([{ ...BASE_ROW }]);
  const writes: Array<{ path: string; bytes: Buffer }> = [];
  const deps = buildDeps({
    db,
    visionClient: passClient(),
    loadJobTenantValue: '7',
    fixedNow: '2026-05-06T10:00:00.000Z',
    writes,
  });

  const result = await uploadReplaceCreative(
    {
      scope: { jobId: 'job-1', tenantId: '7', creativeId: BASE_ROW.id },
      file: pngBytes('clean-upload'),
    },
    deps,
  );

  assert.equal(result.status, 202);
  expectAccepted(result);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.creative.tenant_id, 7);
  assert.equal(result.creative.source_type, 'manual_upload');
  assert.equal(result.creative.permission_scope, 'user_uploaded');
  assert.equal(result.creative.aspect_ratio, '4:5');
  assert.match(result.creative.storage_key, /\/ingested-assets\/7\//);
  assert.equal(result.orphaned_creative_id, BASE_ROW.id);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].bytes.length > 0, true);

  const previous = db.rows.find((row) => row.id === BASE_ROW.id);
  assert.equal(previous?.orphaned_at, '2026-05-06T10:00:00.000Z');
  const replacement = db.rows.find((row) => row.id !== BASE_ROW.id);
  assert.ok(replacement, 'replacement row inserted');
  assert.equal(replacement?.tenant_id, 7);

  assert.equal(db.visionRuns.length, 1);
  assert.equal(db.visionRuns[0].verdict, 'pass');
  assert.equal(db.visionRuns[0].tenant_id, 7);
});

test('upload-replace: failing QA without override returns 422 and never mutates creative', async () => {
  const db = new StubDb([{ ...BASE_ROW }]);
  const writes: Array<{ path: string; bytes: Buffer }> = [];
  const deps = buildDeps({
    db,
    visionClient: failClient(),
    loadJobTenantValue: '7',
    writes,
  });

  const result = await uploadReplaceCreative(
    {
      scope: { jobId: 'job-1', tenantId: '7', creativeId: BASE_ROW.id },
      file: pngBytes('nsfw-payload'),
    },
    deps,
  );

  expectError(result);
  assert.equal(result.status, 422);
  assert.equal(result.error.code, 'nsfw_detected');
  assert.ok(result.qa);
  assert.equal(result.qa?.verdict, 'fail');
  assert.equal(db.rows.length, 1, 'no new creative_assets row created');
  assert.equal(db.rows[0].orphaned_at, null, 'previous row not orphaned');
  assert.equal(db.visionRuns.length, 1, 'failing run still recorded for audit');
  assert.equal(db.visionRuns[0].verdict, 'fail');
  assert.equal(writes.length, 1, 'bytes still written for forensics; just not promoted');
});

test('upload-replace: failing QA with operator_override AND tos_acknowledged is allowed', async () => {
  const db = new StubDb([{ ...BASE_ROW }]);
  const deps = buildDeps({
    db,
    visionClient: failClient(),
    loadJobTenantValue: '7',
    fixedNow: '2026-05-06T10:00:00.000Z',
  });

  const override: UploadReplaceOverride = {
    operator_override: true,
    tos_acknowledged: true,
    acknowledged_by: 'user-42',
  };

  const result = await uploadReplaceCreative(
    {
      scope: { jobId: 'job-1', tenantId: '7', creativeId: BASE_ROW.id },
      file: pngBytes('override-payload'),
      override,
    },
    deps,
  );

  assert.equal(result.status, 202);
  expectAccepted(result);
  assert.equal(result.verdict, 'operator_override');
  assert.equal(result.operator_override, true);
  assert.equal(db.visionRuns.length, 2, 'underlying fail run + override run both persisted');
  const overrideRun = db.visionRuns.find((row) => row.verdict === 'operator_override');
  assert.ok(overrideRun, 'operator_override run recorded');
  const rawOutput = JSON.parse(String(overrideRun!.raw_model_output ?? '{}')) as Record<string, unknown>;
  assert.equal(rawOutput.operator_override, true);
  assert.equal(rawOutput.acknowledged_by, 'user-42');
  const previous = db.rows.find((row) => row.id === BASE_ROW.id);
  assert.equal(previous?.orphaned_at, '2026-05-06T10:00:00.000Z');
});

test('upload-replace: operator_override without tos_acknowledged is rejected', async () => {
  const db = new StubDb([{ ...BASE_ROW }]);
  const deps = buildDeps({
    db,
    visionClient: failClient(),
    loadJobTenantValue: '7',
  });

  const result = await uploadReplaceCreative(
    {
      scope: { jobId: 'job-1', tenantId: '7', creativeId: BASE_ROW.id },
      file: pngBytes('override-no-tos'),
      override: { operator_override: true, tos_acknowledged: false },
    },
    deps,
  );

  assert.equal(result.status, 422);
  expectError(result);
  assert.equal(result.error.code, 'override_requires_tos_acknowledgement');
  assert.equal(db.rows.length, 1, 'no new creative inserted');
  assert.equal(db.rows[0].orphaned_at, null, 'previous row not orphaned');
});

test('upload-replace: cross-tenant creativeId returns creative_not_found (no leak)', async () => {
  const db = new StubDb([{ ...BASE_ROW, tenant_id: 7 }]);
  const deps = buildDeps({
    db,
    visionClient: passClient(),
    loadJobTenantValue: '99',
  });

  const result = await uploadReplaceCreative(
    {
      scope: { jobId: 'job-1', tenantId: '99', creativeId: BASE_ROW.id },
      file: pngBytes('cross-tenant'),
    },
    deps,
  );

  assert.equal(result.status, 404);
  expectError(result);
  assert.equal(result.error.code, 'creative_not_found');
  assert.equal(db.rows.length, 1);
  assert.equal(db.visionRuns.length, 0, 'cross-tenant attempt never reaches QA');
});

test('upload-replace: rejects unsupported mime type', async () => {
  const db = new StubDb([{ ...BASE_ROW }]);
  const deps = buildDeps({ db, visionClient: passClient(), loadJobTenantValue: '7' });

  const result = await uploadReplaceCreative(
    {
      scope: { jobId: 'job-1', tenantId: '7', creativeId: BASE_ROW.id },
      file: { bytes: Buffer.from('hello'), mimeType: 'image/heic', fileName: 'x.heic' },
    },
    deps,
  );

  assert.equal(result.status, 415);
  expectError(result);
  assert.equal(result.error.code, 'unsupported_mime_type');
});

test('upload-replace: rejects oversized payload (> 8MB)', async () => {
  const db = new StubDb([{ ...BASE_ROW }]);
  const deps = buildDeps({ db, visionClient: passClient(), loadJobTenantValue: '7' });

  const tooBig = Buffer.alloc(8 * 1024 * 1024 + 1);
  PNG_MAGIC.copy(tooBig, 0);
  const result = await uploadReplaceCreative(
    {
      scope: { jobId: 'job-1', tenantId: '7', creativeId: BASE_ROW.id },
      file: { bytes: tooBig, mimeType: 'image/png', fileName: 'big.png' },
    },
    deps,
  );

  assert.equal(result.status, 413);
  expectError(result);
  assert.equal(result.error.code, 'file_too_large');
});

test('gc-orphan-uploads: dry-run reports candidates but never mutates DB or filesystem', async () => {
  const orphanedAt = '2026-05-05T00:00:00.000Z';
  const db = new StubDb([
    { ...BASE_ROW, id: 'orphan-old', orphaned_at: orphanedAt },
    { ...BASE_ROW, id: 'orphan-fresh', orphaned_at: '2026-05-06T09:55:00.000Z' },
    { ...BASE_ROW, id: 'live-1', orphaned_at: null },
  ]);

  const stats = await runGcOrphanUploads({
    dryRun: true,
    db,
    maxAgeHours: 24,
    dataRoot: '/tmp/aries-test-upload-replace',
    now: () => new Date('2026-05-06T10:00:00.000Z'),
  });

  assert.equal(stats.scanned, 1, 'only the >24h orphan is in scope');
  assert.equal(stats.candidates[0].id, 'orphan-old');
  assert.equal(stats.rowsDeleted, 0);
  assert.equal(stats.filesDeleted, 0);
  assert.equal(db.rows.length, 3, 'dry-run leaves rows in place');
  const stillOrphaned = db.rows.find((row) => row.id === 'orphan-old');
  assert.equal(stillOrphaned?.orphaned_at, orphanedAt, 'dry-run does not clear orphaned_at');
});

test('gc-orphan-uploads: --commit deletes only rows past retention window', async () => {
  const db = new StubDb([
    { ...BASE_ROW, id: 'orphan-old', orphaned_at: '2026-05-05T00:00:00.000Z' },
    { ...BASE_ROW, id: 'orphan-fresh', orphaned_at: '2026-05-06T09:55:00.000Z' },
    { ...BASE_ROW, id: 'live-1', orphaned_at: null },
  ]);

  const stats = await runGcOrphanUploads({
    dryRun: false,
    db,
    maxAgeHours: 24,
    dataRoot: '/tmp/aries-test-upload-replace',
    now: () => new Date('2026-05-06T10:00:00.000Z'),
  });

  assert.equal(stats.scanned, 1);
  assert.equal(stats.rowsDeleted, 1);
  assert.equal(db.rows.find((row) => row.id === 'orphan-old'), undefined);
  assert.ok(db.rows.find((row) => row.id === 'orphan-fresh'));
  assert.ok(db.rows.find((row) => row.id === 'live-1'));
});
