import { NextResponse } from 'next/server';

import {
  ALLOWED_UPLOAD_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  type UploadReplaceDeps,
  type UploadReplaceFile,
  type UploadReplaceOverride,
  type UploadReplaceResult,
  uploadReplaceCreative,
} from '@/backend/marketing/upload-replace';
import {
  createHermesVisionQAClient,
  type VisionQABrandKitInput,
  type VisionQAClient,
} from '@/backend/creative-memory/vision-qa';
import { loadMarketingJobRuntime } from '@/backend/marketing/runtime-state';
import pool from '@/lib/db';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

export interface SocialContentUploadReplaceHandlerOptions {
  visionClient?: VisionQAClient;
  deps?: Partial<UploadReplaceDeps>;
}

function coerceBoolean(value: FormDataEntryValue | null): boolean {
  if (value === null) return false;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'on' || normalized === 'yes';
}

function coerceString(value: FormDataEntryValue | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function parseUploadRequest(req: Request): Promise<
  | { ok: true; file: UploadReplaceFile; override: UploadReplaceOverride; brandKit: VisionQABrandKitInput | null }
  | { ok: false; status: number; reason: string; detail?: Record<string, unknown> }
> {
  const contentType = req.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return { ok: false, status: 415, reason: 'unsupported_media_type', detail: { expected: 'multipart/form-data' } };
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    return {
      ok: false,
      status: 400,
      reason: 'invalid_multipart',
      detail: { message: (err as Error)?.message ?? 'unknown' },
    };
  }

  const fileEntry = formData.get('image');
  if (!(fileEntry instanceof File) || fileEntry.size === 0) {
    return { ok: false, status: 400, reason: 'missing_file', detail: { field: 'image' } };
  }
  if (fileEntry.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      status: 413,
      reason: 'file_too_large',
      detail: { max_bytes: MAX_UPLOAD_BYTES, received_bytes: fileEntry.size },
    };
  }

  const mimeType = (fileEntry.type || '').toLowerCase();
  if (!ALLOWED_UPLOAD_MIME_TYPES.includes(mimeType as (typeof ALLOWED_UPLOAD_MIME_TYPES)[number])) {
    return {
      ok: false,
      status: 415,
      reason: 'unsupported_mime_type',
      detail: { received: mimeType, allowed: [...ALLOWED_UPLOAD_MIME_TYPES] },
    };
  }

  const bytes = Buffer.from(await fileEntry.arrayBuffer());

  let brandKit: VisionQABrandKitInput | null = null;
  const brandKitField = formData.get('brand_kit');
  if (typeof brandKitField === 'string' && brandKitField.trim()) {
    try {
      brandKit = JSON.parse(brandKitField) as VisionQABrandKitInput;
    } catch {
      brandKit = null;
    }
  }

  const override: UploadReplaceOverride = {
    operator_override: coerceBoolean(formData.get('operator_override')),
    tos_acknowledged: coerceBoolean(formData.get('tos_acknowledged')),
    acknowledged_by: coerceString(formData.get('acknowledged_by')),
  };

  return {
    ok: true,
    file: {
      bytes,
      mimeType,
      fileName: fileEntry.name || null,
    },
    override,
    brandKit,
  };
}

function buildVisionClient(): VisionQAClient {
  const gateway = process.env.HERMES_GATEWAY_URL?.trim();
  const apiKey = process.env.HERMES_API_SERVER_KEY?.trim();
  if (!gateway || !apiKey) {
    return async () => {
      throw new Error('vision_qa_unavailable: HERMES_GATEWAY_URL or HERMES_API_SERVER_KEY missing');
    };
  }
  return createHermesVisionQAClient({ gatewayUrl: gateway, apiKey });
}

function applyResult(result: UploadReplaceResult): NextResponse {
  if (result.status === 202) {
    return NextResponse.json(
      {
        status: 'accepted',
        verdict: result.verdict,
        creative: result.creative,
        orphaned_creative_id: result.orphaned_creative_id,
        operator_override: Boolean(result.operator_override),
        qa: {
          verdict: result.qa.verdict,
          scores: result.qa.scores,
          reasons: result.qa.reasons,
          attempt_number: result.qa.attempt_number,
        },
      },
      { status: 202 },
    );
  }
  const body: Record<string, unknown> = {
    status: 'error',
    error: result.error.code,
    detail: result.error.detail ?? null,
  };
  if (result.qa) {
    body.qa = {
      verdict: result.qa.verdict,
      scores: result.qa.scores,
      reasons: result.qa.reasons,
      attempt_number: result.qa.attempt_number,
    };
  }
  return NextResponse.json(body, { status: result.status });
}

export async function handleSocialContentUploadReplace(
  jobId: string,
  creativeId: string,
  req: Request,
  tenantContextLoader?: TenantContextLoader,
  options: SocialContentUploadReplaceHandlerOptions = {},
): Promise<Response> {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }
  const { tenantId, userId } = tenantResult.tenantContext;

  const parsed = await parseUploadRequest(req);
  if (!parsed.ok) {
    return NextResponse.json(
      { status: 'error', error: parsed.reason, detail: parsed.detail ?? null },
      { status: parsed.status },
    );
  }

  const deps: UploadReplaceDeps = {
    db: options.deps?.db ?? pool,
    visionClient: options.visionClient ?? options.deps?.visionClient ?? buildVisionClient(),
    writeBytes: options.deps?.writeBytes,
    loadJobTenant:
      options.deps?.loadJobTenant ??
      (async (id) => {
        const doc = await loadMarketingJobRuntime(id);
        return doc?.tenant_id ?? null;
      }),
    now: options.deps?.now,
    dataRoot: options.deps?.dataRoot,
  };

  const result = await uploadReplaceCreative(
    {
      scope: { jobId, tenantId, creativeId },
      file: parsed.file,
      override: parsed.override,
      brandKit: parsed.brandKit,
      acknowledgedBy: parsed.override.acknowledged_by ?? userId,
    },
    deps,
  );

  return applyResult(result);
}
