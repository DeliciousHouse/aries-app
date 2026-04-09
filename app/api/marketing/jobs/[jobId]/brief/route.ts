import { NextResponse } from 'next/server';

import {
  appendCampaignHistory,
  ensureCampaignWorkspaceRecord,
  saveCampaignWorkspaceAssets,
  saveCampaignWorkspaceRecord,
  type CampaignWorkspaceAssetUpload,
} from '@/backend/marketing/workspace-store';
import { loadMarketingJobRuntime, saveMarketingJobRuntime } from '@/backend/marketing/runtime-state';
import { loadTenantContextOrResponse, type TenantContextLoader } from '@/lib/tenant-context-http';

function coerceFieldValue(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseStringListField(entries: FormDataEntryValue[]): string[] {
  const fromEntries = entries
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (fromEntries.length > 1) {
    return fromEntries;
  }

  const raw = fromEntries[0];
  if (!raw) {
    return [];
  }

  return raw
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function parseBriefRequest(req: Request): Promise<{
  payload: Record<string, unknown>;
  uploads: CampaignWorkspaceAssetUpload[];
}> {
  const contentType = req.headers.get('content-type') || '';

  if (contentType.includes('multipart/form-data')) {
    const formData = await req.formData();
    const uploadEntries = formData.getAll('brandAssets');
    const uploads: CampaignWorkspaceAssetUpload[] = [];

    for (const entry of uploadEntries) {
      if (!(entry instanceof File) || entry.size <= 0) {
        continue;
      }
      uploads.push({
        name: entry.name,
        contentType: entry.type || 'application/octet-stream',
        data: Buffer.from(await entry.arrayBuffer()),
      });
    }

    return {
      payload: {
        websiteUrl: coerceFieldValue(formData.get('websiteUrl')),
        brandVoice: coerceFieldValue(formData.get('brandVoice')),
        styleVibe: coerceFieldValue(formData.get('styleVibe')),
        visualReferences: parseStringListField(formData.getAll('visualReferences')),
        mustUseCopy: coerceFieldValue(formData.get('mustUseCopy')),
        mustAvoidAesthetics: coerceFieldValue(formData.get('mustAvoidAesthetics')),
        notes: coerceFieldValue(formData.get('notes')),
      },
      uploads,
    };
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    payload = {};
  }

  return { payload, uploads: [] };
}

export async function handlePatchMarketingJobBrief(
  jobId: string,
  req: Request,
  tenantContextLoader?: TenantContextLoader,
) {
  const tenantResult = await loadTenantContextOrResponse(tenantContextLoader);
  if ('response' in tenantResult) {
    return tenantResult.response;
  }
  const tenantId = tenantResult.tenantContext.tenantId;

  const runtimeDoc = loadMarketingJobRuntime(jobId);
  if (!runtimeDoc || runtimeDoc.tenant_id !== tenantId) {
    return NextResponse.json({ error: 'Marketing job not found.' }, { status: 404 });
  }

  const requestBody = await parseBriefRequest(req);
  const record = ensureCampaignWorkspaceRecord({
    jobId,
    tenantId,
    payload: {
      ...(runtimeDoc.inputs.request as Record<string, unknown> | undefined),
      ...requestBody.payload,
    },
  });

  if (requestBody.uploads.length > 0) {
    saveCampaignWorkspaceAssets(record, requestBody.uploads);
  }

  appendCampaignHistory(record, {
    actor: 'operator',
    type: 'comment',
    workflowState: record.workflow_state,
    note: 'Campaign brief updated.',
  });
  saveCampaignWorkspaceRecord(record);
  runtimeDoc.inputs.request = {
    ...(runtimeDoc.inputs.request as Record<string, unknown> | undefined),
    ...requestBody.payload,
  };
  saveMarketingJobRuntime(jobId, runtimeDoc);

  return NextResponse.json({ ok: true }, { status: 200 });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return handlePatchMarketingJobBrief(jobId, req);
}
