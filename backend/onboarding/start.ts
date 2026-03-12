import * as fs from 'node:fs';
import * as path from 'node:path';
import { generatedDataPath } from '../runtime-paths';

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

function webhookUrl(): string {
  const base = process.env.N8N_BASE_URL || 'http://localhost:5678';
  return `${base.replace(/\/$/, '')}/webhook/tenant-provisioning`;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function normalizeStateFromWorkflow(body: Record<string, unknown>): StartResult['state'] {
  const status = typeof body.status === 'string' ? body.status : '';
  if (status === 'duplicate') return 'duplicate';
  if (status === 'success') return 'validated';
  if (status === 'validation_failed') return 'needs_repair';
  return 'accepted';
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

  const requestBody: StartRequest = {
    tenant_id: payload.tenant_id,
    tenant_type: payload.tenant_type,
    signup_event_id: payload.signup_event_id,
    metadata: payload.metadata
  };

  try {
    const res = await fetch(webhookUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      // keep raw text
    }

    const body = asObject(parsed);

    if (res.ok) {
      return {
        status: 'ok',
        tenant_id: (body.tenant_id as string) || payload.tenant_id,
        tenant_type: (body.tenant_type as string) || payload.tenant_type,
        signup_event_id: (body.signup_event_id as string) || payload.signup_event_id,
        state: normalizeStateFromWorkflow(body),
        workflow_status: res.status,
        raw: body as Json
      };
    }

    return {
      status: 'error',
      tenant_id: payload.tenant_id,
      tenant_type: payload.tenant_type,
      signup_event_id: payload.signup_event_id,
      workflow_status: res.status,
      reason: 'workflow_request_failed',
      raw: body as Json
    };
  } catch (error) {
    return {
      status: 'error',
      tenant_id: payload.tenant_id,
      tenant_type: payload.tenant_type,
      signup_event_id: payload.signup_event_id,
      reason: `workflow_unreachable:${String((error as Error).message || error)}`
    };
  }
}

export async function handleStartHttp(req: Request): Promise<Response> {
  let payload: StartRequest = {};
  try {
    payload = (await req.json()) as StartRequest;
  } catch {
    payload = {};
  }

  const result = await startOnboarding(payload);
  const code = result.status === 'ok' ? 200 : (result.reason?.startsWith('missing_required_fields') ? 400 : 502);
  return new Response(JSON.stringify(result), {
    status: code,
    headers: { 'content-type': 'application/json' }
  });
}

export function onboardingStartLocalPaths() {
  return {
    draftRoot: generatedDataPath('draft'),
    validatedRoot: generatedDataPath('validated'),
    idempotencyRoot: generatedDataPath('draft', 'idempotency')
  };
}

export function ensureOnboardingFolders(): void {
  const p = onboardingStartLocalPaths();
  fs.mkdirSync(p.draftRoot, { recursive: true });
  fs.mkdirSync(p.validatedRoot, { recursive: true });
  fs.mkdirSync(p.idempotencyRoot, { recursive: true });
}
