import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveCodePath } from '../../lib/runtime-paths';
import { OpenClawGatewayError, runOpenClawLobsterWorkflow, type LobsterEnvelope } from './gateway-client';
import { getAriesOpenClawWorkflow, type AriesOpenClawWorkflowKey } from './workflow-catalog';

const execFileAsync = promisify(execFile);

export type ParityStubPayload = {
  status: 'not_implemented';
  code: 'workflow_missing_for_route';
  route: string;
  message: string;
  [key: string]: unknown;
};

export type AriesWorkflowExecutionResult =
  | { kind: 'ok'; envelope: LobsterEnvelope; primaryOutput: Record<string, unknown> | null }
  | { kind: 'not_implemented'; payload: ParityStubPayload }
  | { kind: 'gateway_error'; error: OpenClawGatewayError };

function primaryOutputRecord(envelope: LobsterEnvelope): Record<string, unknown> | null {
  if (!Array.isArray(envelope.output) || envelope.output.length === 0) return null;
  const first = envelope.output[0];
  if (!first || typeof first !== 'object' || Array.isArray(first)) return null;
  return first as Record<string, unknown>;
}

function asParityStubPayload(record: Record<string, unknown> | null): ParityStubPayload | null {
  if (!record) return null;
  if (record.status !== 'not_implemented' || record.code !== 'workflow_missing_for_route') return null;
  if (typeof record.route !== 'string' || typeof record.message !== 'string') return null;
  return record as unknown as ParityStubPayload;
}

function asCompatBoolean(value: unknown, fallback = false): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string' && value.trim()) {
    const lowered = value.trim().toLowerCase();
    return ['1', 'true', 'yes', 'y', 'on'].includes(lowered) ? 'true' : 'false';
  }
  return fallback ? 'true' : 'false';
}

function shouldTryMarketingCompat(key: AriesOpenClawWorkflowKey): boolean {
  return key === 'marketing_stage1_research';
}

function isWorkflowFileRuntimeMismatch(value: unknown): boolean {
  const text = JSON.stringify(value || {}).toLowerCase();
  return text.includes('unknown command') || text.includes('unknown workflow');
}

function shouldFallbackForGatewayError(error: OpenClawGatewayError): boolean {
  return [
    'openclaw_gateway_not_configured',
    'openclaw_gateway_unreachable',
    'openclaw_gateway_tool_unavailable',
    'openclaw_gateway_server_error',
  ].includes(error.code) || isWorkflowFileRuntimeMismatch(error.message);
}

async function runLocalMarketingCompat(
  configuredCwd: string,
  args: Record<string, unknown>,
): Promise<{ envelope: LobsterEnvelope; primaryOutput: Record<string, unknown> | null }> {
  const compatPath = path.join(configuredCwd, 'bin', 'marketing-pipeline-compat');
  const commandArgs = [
    '--json',
    '--competitor',
    typeof args.competitor === 'string' ? args.competitor : '',
    '--competitor-facebook-url',
    typeof args.competitor_facebook_url === 'string' ? args.competitor_facebook_url : '',
    '--website-url',
    typeof args.website_url === 'string' ? args.website_url : '',
    '--brand-slug',
    typeof args.brand_slug === 'string' ? args.brand_slug : 'client-brand',
    '--launch-approved',
    asCompatBoolean(args.launch_approved),
    '--notify-chat',
    asCompatBoolean(args.notify_chat, true),
  ];
  const { stdout } = await execFileAsync(compatPath, commandArgs, { cwd: configuredCwd, maxBuffer: 1024 * 1024 * 8 });
  const primaryOutput = JSON.parse(stdout) as Record<string, unknown>;
  return {
    envelope: {
      ok: true,
      status: 'ok',
      output: [primaryOutput],
      requiresApproval: null,
      compatibilityMode: 'marketing-pipeline-compat',
    } as LobsterEnvelope,
    primaryOutput,
  };
}

export async function runAriesOpenClawWorkflow(
  key: AriesOpenClawWorkflowKey,
  args: Record<string, unknown>,
): Promise<AriesWorkflowExecutionResult> {
  const workflow = getAriesOpenClawWorkflow(key);
  const gatewayCwd =
    process.env.OPENCLAW_GATEWAY_LOBSTER_CWD?.trim() ||
    process.env.OPENCLAW_LOBSTER_CWD?.trim() ||
    workflow.cwd ||
    resolveCodePath('lobster');
  const localCompatCwd =
    process.env.OPENCLAW_LOCAL_LOBSTER_CWD?.trim() ||
    process.env.OPENCLAW_LOBSTER_CWD?.trim() ||
    workflow.cwd ||
    resolveCodePath('lobster');
  try {
    const envelope = await runOpenClawLobsterWorkflow({
      pipeline: workflow.pipeline,
      cwd: gatewayCwd,
      argsJson: JSON.stringify(args),
    });
    if (shouldTryMarketingCompat(key) && !envelope.ok && isWorkflowFileRuntimeMismatch(envelope)) {
      const compat = await runLocalMarketingCompat(localCompatCwd, args);
      return { kind: 'ok', envelope: compat.envelope, primaryOutput: compat.primaryOutput };
    }
    const primaryOutput = primaryOutputRecord(envelope);
    const parityStub = asParityStubPayload(primaryOutput);
    if (parityStub) {
      return { kind: 'not_implemented', payload: parityStub };
    }
    return { kind: 'ok', envelope, primaryOutput };
  } catch (error) {
    if (shouldTryMarketingCompat(key) && error instanceof OpenClawGatewayError && shouldFallbackForGatewayError(error)) {
      const compat = await runLocalMarketingCompat(localCompatCwd, args);
      return { kind: 'ok', envelope: compat.envelope, primaryOutput: compat.primaryOutput };
    }
    if (shouldTryMarketingCompat(key) && isWorkflowFileRuntimeMismatch(error)) {
      const compat = await runLocalMarketingCompat(localCompatCwd, args);
      return { kind: 'ok', envelope: compat.envelope, primaryOutput: compat.primaryOutput };
    }
    if (error instanceof OpenClawGatewayError) {
      return { kind: 'gateway_error', error };
    }
    throw error;
  }
}

export function mapOpenClawGatewayError(error: OpenClawGatewayError): { status: number; body: Record<string, unknown> } {
  switch (error.code) {
    case 'openclaw_gateway_not_configured':
      return { status: 503, body: { status: 'error', reason: error.code, message: error.message } };
    case 'openclaw_gateway_unauthorized':
      return { status: 401, body: { status: 'error', reason: error.code, message: error.message } };
    case 'openclaw_gateway_tool_unavailable':
      return { status: 500, body: { status: 'error', reason: error.code, message: error.message } };
    case 'openclaw_gateway_request_invalid':
      return { status: 400, body: { status: 'error', reason: error.code, message: error.message } };
    case 'openclaw_gateway_unreachable':
      return { status: 503, body: { status: 'error', reason: error.code, message: error.message } };
    default:
      return { status: error.status || 500, body: { status: 'error', reason: error.code, message: error.message } };
  }
}
