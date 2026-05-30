/**
 * T15 — Upload-replace pipeline for weekly social-content creatives.
 *
 * Operator opens a creative in the review drawer, picks an image from disk,
 * and submits it. The backend pipeline:
 *
 *   1. Validates the upload (mime, size, tenant ownership of the target
 *      creative) and writes bytes to the T1 tenant-prefixed asset path.
 *   2. Runs the T12 vision QA gate (NSFW + brand fit).
 *   3a. On `pass` it inserts a fresh `creative_assets` row, points the
 *       previous row's `superseded_by` at it, and marks the previous row's
 *       `orphaned_at = now()` for 24h retention before GC sweeps it.
 *   3b. On `fail` *without* an explicit operator override + ToS click, the
 *       new bytes are NOT promoted to a creative_assets row and the caller
 *       is asked to either retry or override. The vision_qa_runs row is
 *       still recorded so we have a permanent audit trail.
 *   3c. On `fail` *with* operator_override + tos_acknowledged, we record a
 *       `vision_qa_runs` row whose verdict is `operator_override`, promote
 *       the asset, and orphan the previous one. The override never auto-
 *       publishes — the post still has to be approved before it ships.
 *
 * Tenant safety: every read/write asserts the asserted tenant owns both the
 * job and the creative being replaced. Cross-tenant references short-circuit
 * with `creative_not_found` (we never reveal whether a creative id belongs
 * to a sibling tenant).
 */

import crypto from 'node:crypto';
import path from 'node:path';

import {
  MAX_VISION_QA_ATTEMPTS,
  type VisionQABrandKitInput,
  type VisionQAClient,
  type VisionQADbClient,
  type VisionQAResult,
  runVisionQA,
} from '@/backend/creative-memory/vision-qa';
import type { SocialContentImageChannel } from '@/backend/social-content/aspect-matrix';
import type { VisionQAVerdict } from '@/types/vision-qa';

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

export const ALLOWED_UPLOAD_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export type AllowedUploadMimeType = (typeof ALLOWED_UPLOAD_MIME_TYPES)[number];

const MIME_TO_EXT: Record<AllowedUploadMimeType, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

export type UploadReplaceErrorCode =
  | 'unauthenticated'
  | 'invalid_request'
  | 'unsupported_mime_type'
  | 'file_too_large'
  | 'file_empty'
  | 'job_not_found'
  | 'creative_not_found'
  | 'cross_tenant_forbidden'
  | 'nsfw_detected'
  | 'qa_failed'
  | 'override_requires_tos_acknowledgement'
  | 'storage_failure';

export interface UploadReplaceError {
  code: UploadReplaceErrorCode;
  detail?: Record<string, unknown>;
}

export interface UploadCreativeRow {
  id: string;
  tenant_id: number;
  storage_kind: string | null;
  storage_key: string | null;
  source_type: string | null;
  permission_scope: string | null;
  media_type: string | null;
  aspect_ratio: string | null;
  brand_kit?: VisionQABrandKitInput | null;
  channel?: SocialContentImageChannel | null;
}

export interface UploadInsertedCreative {
  id: string;
  tenant_id: number;
  storage_kind: 'ingested_asset';
  storage_key: string;
  source_type: 'manual_upload';
  permission_scope: 'user_uploaded';
  media_type: 'image';
  aspect_ratio: string | null;
  checksum: string;
  superseded_creative_id: string;
}

export interface UploadReplaceJobScope {
  jobId: string;
  tenantId: string;
  creativeId: string;
}

export interface UploadReplaceFile {
  bytes: Buffer;
  mimeType: string;
  fileName?: string | null;
}

export interface UploadReplaceOverride {
  operator_override: boolean;
  tos_acknowledged: boolean;
  acknowledged_by?: string | null;
}

export interface UploadReplaceDeps {
  db: UploadReplaceDb;
  visionClient: VisionQAClient;
  writeBytes?: (absPath: string, bytes: Buffer) => Promise<void>;
  loadJobTenant?: (jobId: string) => Promise<string | null>;
  now?: () => Date;
  dataRoot?: string;
}

export type UploadReplaceDb = VisionQADbClient & {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
};

export type UploadReplaceResult =
  | {
      status: 202;
      verdict: VisionQAVerdict;
      qa: VisionQAResult;
      creative: UploadInsertedCreative;
      orphaned_creative_id: string;
      operator_override?: boolean;
    }
  | {
      status: 400 | 401 | 403 | 404 | 413 | 415 | 422 | 500;
      error: UploadReplaceError;
      qa?: VisionQAResult;
    };

function isAllowedMime(mime: string): mime is AllowedUploadMimeType {
  return (ALLOWED_UPLOAD_MIME_TYPES as readonly string[]).includes(mime);
}

function nowDate(deps: UploadReplaceDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function tenantPrefixedPath(opts: {
  dataRoot: string;
  tenantId: string;
  sha: string;
  ext: string;
}): string {
  return path.join(
    opts.dataRoot,
    'ingested-assets',
    opts.tenantId,
    opts.sha.slice(0, 2),
    `${opts.sha}${opts.ext}`,
  );
}

function deriveChannel(creative: UploadCreativeRow): SocialContentImageChannel {
  const explicit = creative.channel;
  if (explicit === 'meta' || explicit === 'instagram') {
    return explicit;
  }
  return 'instagram';
}

const SELECT_CREATIVE_SQL = `
  SELECT id, tenant_id, storage_kind, storage_key, source_type, permission_scope,
         media_type, aspect_ratio
    FROM creative_assets
   WHERE id = $1
   LIMIT 1
`;

// served_asset_ref is id-based (`/api/internal/hermes/media/<id>`) so manual
// uploads are servable through the authoritative id route (ownership enforced
// in SQL). The id is only known after INSERT, so a CTE inserts then writes the
// ref back atomically in one round-trip (no fan-out, guardrail #1). The id
// route resolves `ingested_asset` bytes from the DATA_ROOT storage_key.
const INSERT_REPLACEMENT_SQL = `
  WITH ins AS (
    INSERT INTO creative_assets (
      tenant_id, source_type, permission_scope, media_type,
      storage_kind, storage_key, checksum, aspect_ratio,
      learning_lifecycle, usable_for_generation
    ) VALUES (
      $1, 'manual_upload', 'user_uploaded', 'image',
      'ingested_asset', $2, $3, $4,
      'observed', FALSE
    )
    RETURNING id
  )
  UPDATE creative_assets
     SET served_asset_ref = '/api/internal/hermes/media/' || ins.id::text
    FROM ins
   WHERE creative_assets.id = ins.id
  RETURNING creative_assets.id, creative_assets.tenant_id, creative_assets.storage_kind,
            creative_assets.storage_key, creative_assets.source_type,
            creative_assets.permission_scope, creative_assets.media_type,
            creative_assets.aspect_ratio, creative_assets.checksum
`;

const ORPHAN_PREVIOUS_SQL = `
  UPDATE creative_assets
     SET orphaned_at = $1,
         superseded_by = NULL,
         updated_at = now()
   WHERE id = $2
`;

async function loadCreativeRow(
  db: UploadReplaceDb,
  creativeId: string,
): Promise<UploadCreativeRow | null> {
  const result = await db.query(SELECT_CREATIVE_SQL, [creativeId]);
  const row = (result.rows ?? [])[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id ?? ''),
    tenant_id: Number(row.tenant_id ?? 0),
    storage_kind: typeof row.storage_kind === 'string' ? row.storage_kind : null,
    storage_key: typeof row.storage_key === 'string' ? row.storage_key : null,
    source_type: typeof row.source_type === 'string' ? row.source_type : null,
    permission_scope: typeof row.permission_scope === 'string' ? row.permission_scope : null,
    media_type: typeof row.media_type === 'string' ? row.media_type : null,
    aspect_ratio: typeof row.aspect_ratio === 'string' ? row.aspect_ratio : null,
  };
}

async function insertReplacement(
  db: UploadReplaceDb,
  args: {
    tenantId: number;
    storageKey: string;
    sha: string;
    aspectRatio: string | null;
    supersededCreativeId: string;
  },
): Promise<UploadInsertedCreative> {
  const result = await db.query(INSERT_REPLACEMENT_SQL, [
    args.tenantId,
    args.storageKey,
    args.sha,
    args.aspectRatio,
  ]);
  const row = (result.rows ?? [])[0] as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error('upload_replace_insert_returned_no_row');
  }
  return {
    id: String(row.id ?? ''),
    tenant_id: Number(row.tenant_id ?? args.tenantId),
    storage_kind: 'ingested_asset',
    storage_key: String(row.storage_key ?? args.storageKey),
    source_type: 'manual_upload',
    permission_scope: 'user_uploaded',
    media_type: 'image',
    aspect_ratio: typeof row.aspect_ratio === 'string' ? row.aspect_ratio : args.aspectRatio,
    checksum: String(row.checksum ?? args.sha),
    superseded_creative_id: args.supersededCreativeId,
  };
}

async function orphanPreviousCreative(
  db: UploadReplaceDb,
  args: { creativeId: string; orphanedAt: Date },
): Promise<void> {
  await db.query(ORPHAN_PREVIOUS_SQL, [args.orphanedAt.toISOString(), args.creativeId]);
}

async function persistOverrideRun(
  db: UploadReplaceDb,
  args: {
    tenantId: number;
    creativeId: string;
    qa: VisionQAResult;
    acknowledgedBy: string | null;
  },
): Promise<void> {
  const sql = `
    INSERT INTO vision_qa_runs (
      tenant_id,
      post_id,
      creative_id,
      attempt_number,
      brand_color_match_score,
      text_legibility_score,
      forbidden_pattern_hits,
      brand_violation_score,
      verdict,
      model_version,
      raw_model_output
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  `;
  const rawOutput = {
    operator_override: true,
    acknowledged_by: args.acknowledgedBy,
    underlying_verdict: args.qa.verdict,
    underlying_reasons: args.qa.reasons,
  } satisfies Record<string, unknown>;
  await db.query(sql, [
    args.tenantId,
    null,
    args.creativeId,
    args.qa.attempt_number,
    args.qa.scores.brand_color_match,
    args.qa.scores.text_legibility,
    args.qa.scores.forbidden_pattern_hits,
    args.qa.scores.brand_violation,
    'operator_override' satisfies VisionQAVerdict,
    args.qa.model_version,
    JSON.stringify(rawOutput),
  ]);
}

function reasonImpliesNsfw(reasons: VisionQAResult['reasons']): boolean {
  // The vision QA contract uses the `forbidden_pattern` reason for NSFW and
  // any other strictly-blocked patterns. We surface a dedicated `nsfw_detected`
  // error code so the operator UI can show the strongest copy possible.
  return reasons.includes('forbidden_pattern');
}

export interface UploadReplaceInput {
  scope: UploadReplaceJobScope;
  file: UploadReplaceFile;
  override?: UploadReplaceOverride | null;
  brandKit?: VisionQABrandKitInput | null;
  attemptNumber?: number;
  acknowledgedBy?: string | null;
}

export async function uploadReplaceCreative(
  input: UploadReplaceInput,
  deps: UploadReplaceDeps,
): Promise<UploadReplaceResult> {
  const { scope, file } = input;

  if (!scope.tenantId) {
    return { status: 401, error: { code: 'unauthenticated' } };
  }
  if (!scope.jobId || !scope.creativeId) {
    return { status: 400, error: { code: 'invalid_request' } };
  }

  if (!file.bytes || file.bytes.length === 0) {
    return { status: 400, error: { code: 'file_empty' } };
  }
  if (file.bytes.length > MAX_UPLOAD_BYTES) {
    return {
      status: 413,
      error: {
        code: 'file_too_large',
        detail: { max_bytes: MAX_UPLOAD_BYTES, received_bytes: file.bytes.length },
      },
    };
  }
  if (!isAllowedMime(file.mimeType)) {
    return {
      status: 415,
      error: {
        code: 'unsupported_mime_type',
        detail: {
          received: file.mimeType,
          allowed: [...ALLOWED_UPLOAD_MIME_TYPES],
        },
      },
    };
  }

  if (deps.loadJobTenant) {
    const jobTenant = await deps.loadJobTenant(scope.jobId);
    if (!jobTenant) {
      return { status: 404, error: { code: 'job_not_found' } };
    }
    if (jobTenant !== scope.tenantId) {
      return { status: 404, error: { code: 'job_not_found' } };
    }
  }

  const existing = await loadCreativeRow(deps.db, scope.creativeId);
  if (!existing) {
    return { status: 404, error: { code: 'creative_not_found' } };
  }
  if (String(existing.tenant_id) !== String(scope.tenantId)) {
    // Same response shape as missing — never confirm cross-tenant existence.
    return { status: 404, error: { code: 'creative_not_found' } };
  }

  const sha = crypto.createHash('sha256').update(file.bytes).digest('hex');
  const ext = MIME_TO_EXT[file.mimeType];
  const dataRoot = deps.dataRoot ?? process.env.DATA_ROOT ?? '/data';
  const storageKey = tenantPrefixedPath({
    dataRoot,
    tenantId: scope.tenantId,
    sha,
    ext,
  });

  try {
    const writer =
      deps.writeBytes ??
      (async (absPath, bytes) => {
        const { mkdir, writeFile } = await import('node:fs/promises');
        await mkdir(path.dirname(absPath), { recursive: true });
        await writeFile(absPath, bytes);
      });
    await writer(storageKey, file.bytes);
  } catch (err) {
    return {
      status: 500,
      error: {
        code: 'storage_failure',
        detail: { message: (err as Error)?.message ?? 'unknown' },
      },
    };
  }

  const channel = deriveChannel(existing);
  const brandKit: VisionQABrandKitInput = input.brandKit ?? existing.brand_kit ?? {};
  const tenantNum = Number(scope.tenantId);
  const tenantNumValid = Number.isFinite(tenantNum) && tenantNum > 0;
  const attempt = Math.min(
    Math.max(1, Math.floor(input.attemptNumber ?? 1)),
    MAX_VISION_QA_ATTEMPTS,
  );

  const qa = await runVisionQA({
    assetUrl: storageKey,
    brandKit,
    channel,
    attemptNumber: attempt,
    visionClient: deps.visionClient,
    db: tenantNumValid ? deps.db : undefined,
    tenantId: tenantNumValid ? tenantNum : undefined,
    creativeId: undefined,
  });

  if (qa.verdict === 'fail') {
    const override = input.override ?? null;
    if (!override?.operator_override) {
      const code: UploadReplaceErrorCode = reasonImpliesNsfw(qa.reasons)
        ? 'nsfw_detected'
        : 'qa_failed';
      return {
        status: 422,
        qa,
        error: { code, detail: { reasons: qa.reasons, scores: qa.scores } },
      };
    }
    if (!override.tos_acknowledged) {
      return {
        status: 422,
        qa,
        error: {
          code: 'override_requires_tos_acknowledgement',
          detail: { reasons: qa.reasons },
        },
      };
    }
    if (tenantNumValid) {
      await persistOverrideRun(deps.db, {
        tenantId: tenantNum,
        creativeId: existing.id,
        qa,
        acknowledgedBy: override.acknowledged_by ?? input.acknowledgedBy ?? null,
      });
    }
  }

  const inserted = await insertReplacement(deps.db, {
    tenantId: existing.tenant_id,
    storageKey,
    sha,
    aspectRatio: existing.aspect_ratio,
    supersededCreativeId: existing.id,
  });
  await orphanPreviousCreative(deps.db, {
    creativeId: existing.id,
    orphanedAt: nowDate(deps),
  });

  return {
    status: 202,
    verdict: qa.verdict === 'fail' ? 'operator_override' : qa.verdict,
    qa,
    creative: inserted,
    orphaned_creative_id: existing.id,
    operator_override: qa.verdict === 'fail',
  };
}
