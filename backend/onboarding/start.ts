import * as fs from 'node:fs';
import {
  resolveDataPath,
  resolveDraftRoot,
  resolveValidatedRoot
} from '../../lib/runtime-paths';
import { runAriesWorkflow } from '../execution';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

type StartRequest = {
  tenant_id?: string;
  tenant_type?: string;
  signup_event_id?: string;
  metadata?: Json;
};

type StartResult = {
  status: 'ok' | 'error';
  tenant_id?: string;
  tenant_type?: string;
  signup_event_id?: string;
  state?: 'accepted' | 'duplicate' | 'validated' | 'needs_repair';
  workflow_status?: number;
  raw?: Json;
  reason?: string;
};

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function readJsonSafe(filePath: string): unknown {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function validateStartInput(payload: StartRequest): string[] {
  const missing: string[] = [];
  if (!payload.tenant_id) missing.push('tenant_id');
  if (!payload.tenant_type) missing.push('tenant_type');
  if (!payload.signup_event_id) missing.push('signup_event_id');
  return missing;
}

export async function startOnboarding(payload: StartRequest): Promise<StartResult> {
  const missing = validateStartInput(payload);
  if (missing.length > 0) {
    return {
      status: 'error',
      reason: `missing_required_fields:${missing.join(',')}`,
      tenant_id: payload.tenant_id,
      tenant_type: payload.tenant_type,
      signup_event_id: payload.signup_event_id
    };
  }

  const tenantId = payload.tenant_id!;
  const tenantType = payload.tenant_type!;
  const signupEventId = payload.signup_event_id!;

  const executed = await runAriesWorkflow('onboarding_start', {
    tenant_id: tenantId,
    tenant_type: tenantType,
    signup_event_id: signupEventId,
    metadata: payload.metadata ?? {},
  });
  if (executed.kind === 'gateway_error') {
    throw executed.error;
  }
  if (executed.kind === 'not_implemented') {
    return {
      status: 'error',
      tenant_id: tenantId,
      tenant_type: tenantType,
      signup_event_id: signupEventId,
      reason: executed.payload.code,
      raw: executed.payload as Json,
    };
  }

  return {
    status: 'ok',
    tenant_id: tenantId,
    tenant_type: tenantType,
    signup_event_id: signupEventId,
    state: 'accepted',
    workflow_status: 202,
    raw: (executed.primaryOutput ?? { envelope_status: executed.envelope.status }) as Json,
  };
}

export async function handleStartHttp(req: Request): Promise<Response> {
  let payload: StartRequest = {};
  try {
    payload = (await req.json()) as StartRequest;
  } catch {
    payload = {};
  }

  const result = await startOnboarding(payload);
  const code =
    result.status === 'ok'
      ? 200
      : result.reason === 'workflow_missing_for_route'
        ? 501
        : result.reason?.startsWith('missing_required_fields')
          ? 400
          : 502;
  return new Response(JSON.stringify(result), {
    status: code,
    headers: { 'content-type': 'application/json' }
  });
}

export function onboardingStartLocalPaths() {
  return {
    draftRoot: resolveDraftRoot(),
    validatedRoot: resolveValidatedRoot(),
    idempotencyRoot: resolveDataPath('generated', 'draft', 'idempotency')
  };
}

export function ensureOnboardingFolders(): void {
  const p = onboardingStartLocalPaths();
  fs.mkdirSync(p.draftRoot, { recursive: true });
  fs.mkdirSync(p.validatedRoot, { recursive: true });
  fs.mkdirSync(p.idempotencyRoot, { recursive: true });
}
