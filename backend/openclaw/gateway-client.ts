import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

import { resolveCodePath, resolveCodeRoot } from '../../lib/runtime-paths';

const execFileAsync = promisify(execFile);

type OpenClawInvokeResponse = {
  ok: boolean;
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    details?: unknown;
  };
  error?: {
    type?: string;
    message?: string;
    details?: {
      message?: string;
    };
  };
};

export type LobsterApprovalRequest = {
  type?: string;
  prompt?: string;
  resumeToken?: string;
  [key: string]: unknown;
};

export type LobsterEnvelope = {
  ok: boolean;
  status: string;
  output?: unknown[];
  requiresApproval?: LobsterApprovalRequest | null;
  [key: string]: unknown;
};

export type OpenClawWorkflowCallInput = {
  pipeline: string;
  argsJson?: string;
  cwd?: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
};

export type OpenClawResumeCallInput = {
  token: string;
  approve: boolean;
  cwd?: string;
  timeoutMs?: number;
  maxStdoutBytes?: number;
};

export type OpenClawLobsterRuntimeContext = {
  sessionKey: string;
  cwd: string;
  configuredCwd: string;
  stateDir: string;
  gatewayUrl: string | null;
};

export type LobsterResumeTokenDescriptor = {
  fingerprint: string;
  stateKeys: string[];
};

type OpenClawTestInvoker = (
  payload: Record<string, unknown>,
) => Promise<LobsterEnvelope> | LobsterEnvelope;

export class OpenClawGatewayError extends Error {
  code:
    | 'openclaw_gateway_not_configured'
    | 'openclaw_gateway_unauthorized'
    | 'openclaw_gateway_unreachable'
    | 'openclaw_gateway_tool_unavailable'
    | 'openclaw_gateway_request_invalid'
    | 'openclaw_gateway_response_invalid'
    | 'openclaw_gateway_server_error';

  status?: number;

  constructor(
    code: OpenClawGatewayError['code'],
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = 'OpenClawGatewayError';
    this.code = code;
    this.status = status;
  }
}

function createGatewayError(
  code: OpenClawGatewayError['code'],
  message: string,
  status?: number,
  details?: Record<string, unknown>
): OpenClawGatewayError {
  console.error('[openclaw-gateway]', {
    code,
    message,
    status: status ?? null,
    ...details,
  });
  return new OpenClawGatewayError(code, message, status);
}

function requiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw createGatewayError(
      'openclaw_gateway_not_configured',
      `Missing required OpenClaw environment variable: ${key}`,
      undefined,
      { envKey: key }
    );
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key]?.trim() || fallback;
}

function gatewayErrorMessage(body: OpenClawInvokeResponse, fallback: string): string {
  const detailMessage = body.error?.details?.message?.trim();
  if (detailMessage) {
    return detailMessage;
  }
  const message = body.error?.message?.trim();
  return message || fallback;
}

function gatewayBaseUrl(): string {
  return requiredEnv('OPENCLAW_GATEWAY_URL').replace(/\/$/, '');
}

function gatewayToken(): string {
  return requiredEnv('OPENCLAW_GATEWAY_TOKEN');
}

function defaultSessionKey(): string {
  return optionalEnv('OPENCLAW_SESSION_KEY', 'main');
}

function defaultGatewayLobsterCwd(): string {
  const codeRoot = resolveCodeRoot();
  return codeRoot === '/app' ? 'aries-app/lobster' : resolveCodePath('lobster');
}

function defaultLobsterCwd(): string {
  return optionalEnv(
    'OPENCLAW_GATEWAY_LOBSTER_CWD',
    optionalEnv('OPENCLAW_LOBSTER_CWD', defaultGatewayLobsterCwd()),
  );
}

function normalizeGatewayCwd(cwd: string): string {
  const normalized = cwd.trim();
  if (!normalized || !path.isAbsolute(normalized)) {
    return normalized;
  }

  const codeRoot = resolveCodeRoot();
  if (normalized === codeRoot || normalized.startsWith(`${codeRoot}${path.sep}`)) {
    const relative = path.relative(codeRoot, normalized);
    return relative || '.';
  }

  return normalized;
}

function defaultGatewayHome(): string {
  return optionalEnv('OPENCLAW_GATEWAY_HOME', optionalEnv('OPENCLAW_HOME', '/home/node'));
}

function defaultLobsterStateDir(): string {
  return optionalEnv(
    'OPENCLAW_GATEWAY_LOBSTER_STATE_DIR',
    optionalEnv(
      'OPENCLAW_LOBSTER_STATE_DIR',
      optionalEnv('LOBSTER_STATE_DIR', path.join(defaultGatewayHome(), '.lobster', 'state')),
    ),
  );
}

function gatewayUrlOrNull(): string | null {
  return process.env.OPENCLAW_GATEWAY_URL?.trim() ? gatewayBaseUrl() : null;
}

function fingerprintToken(token: string): string {
  return crypto.createHash('sha1').update(token).digest('hex').slice(0, 12);
}

function compatibilityStateKeys(stateKey: string): string[] {
  const normalized = stateKey.trim();
  if (!normalized) {
    return [];
  }

  const candidates = new Set<string>([normalized]);
  const match = normalized.match(/^(workflow[-_]resume)([_-].+)$/);
  if (!match) {
    return [...candidates];
  }

  const suffix = match[2];
  const cleanSuffix = suffix.replace(/^[_-]/, '');
  candidates.add(`workflow_resume${suffix}`);
  candidates.add(`workflow-resume${suffix}`);
  candidates.add(`workflow_resume_${cleanSuffix}`);
  candidates.add(`workflow-resume_${cleanSuffix}`);
  candidates.add(`workflow_resume-${cleanSuffix}`);
  candidates.add(`workflow-resume-${cleanSuffix}`);
  return [...candidates];
}

function decodedOpaqueToken(token: string): { payload: Record<string, unknown>; stateKey: string } | null {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const stateKey = typeof parsed.stateKey === 'string' ? parsed.stateKey.trim() : '';
    if (!stateKey) {
      return null;
    }
    return { payload: parsed, stateKey };
  } catch {
    return null;
  }
}

function compatibleResumeTokens(token: string): string[] {
  const normalized = token.trim();
  if (!normalized) {
    return [];
  }

  const candidates = new Set<string>([normalized]);
  if (/^workflow[-_]resume[_-]/.test(normalized)) {
    for (const stateKey of compatibilityStateKeys(normalized)) {
      candidates.add(stateKey);
    }
    return [...candidates];
  }

  const decoded = decodedOpaqueToken(normalized);
  if (!decoded) {
    return [...candidates];
  }

  for (const stateKey of compatibilityStateKeys(decoded.stateKey)) {
    const payload = {
      ...decoded.payload,
      stateKey,
    };
    candidates.add(Buffer.from(JSON.stringify(payload)).toString('base64url'));
  }
  return [...candidates];
}

export function isOpenClawLobsterResumeStateMissing(error: unknown): boolean {
  if (!(error instanceof OpenClawGatewayError)) {
    return false;
  }
  return /workflow resume state not found/i.test(error.message);
}

export function describeLobsterResumeToken(token: string): LobsterResumeTokenDescriptor {
  const normalized = token.trim();
  if (!normalized) {
    return { fingerprint: 'missing', stateKeys: [] };
  }

  const decoded = decodedOpaqueToken(normalized);
  const stateKeys = decoded
    ? compatibilityStateKeys(decoded.stateKey)
    : /^workflow[-_]resume[_-]/.test(normalized)
      ? compatibilityStateKeys(normalized)
      : [];

  return {
    fingerprint: fingerprintToken(normalized),
    stateKeys,
  };
}

export function resolveOpenClawLobsterRuntimeContext(input: { cwd?: string } = {}): OpenClawLobsterRuntimeContext {
  const configuredCwd = input.cwd?.trim() || defaultLobsterCwd();
  return {
    sessionKey: defaultSessionKey(),
    cwd: normalizeGatewayCwd(configuredCwd),
    configuredCwd,
    stateDir: defaultLobsterStateDir(),
    gatewayUrl: gatewayUrlOrNull(),
  };
}

function asEnvelope(value: unknown): LobsterEnvelope {
  if (!value || typeof value !== 'object') {
    throw new OpenClawGatewayError(
      'openclaw_gateway_response_invalid',
      'OpenClaw returned a non-object Lobster envelope.',
    );
  }

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.status !== 'string' || typeof candidate.ok !== 'boolean') {
    throw new OpenClawGatewayError(
      'openclaw_gateway_response_invalid',
      'OpenClaw returned an invalid Lobster envelope.',
    );
  }

  return candidate as unknown as LobsterEnvelope;
}

function resolveLocalLobsterCwd(configuredCwd: string): string {
  const normalized = configuredCwd.trim();
  if (!normalized) {
    return resolveCodePath('lobster');
  }
  if (path.isAbsolute(normalized)) {
    return normalized;
  }
  return resolveCodePath(normalized);
}

function shouldFallbackToLocalLobster(error: unknown): boolean {
  if (!(error instanceof OpenClawGatewayError)) {
    return false;
  }

  if (
    error.code === 'openclaw_gateway_not_configured' ||
    error.code === 'openclaw_gateway_unreachable' ||
    error.code === 'openclaw_gateway_tool_unavailable'
  ) {
    return true;
  }

  if (error.code !== 'openclaw_gateway_server_error') {
    return false;
  }

  return /spawn lobster enoent|cwd must be a relative path|unknown command|unknown workflow/i.test(error.message);
}

async function invokeLocalLobster(
  runtime: OpenClawLobsterRuntimeContext,
  commandArgs: string[],
  metadata: Record<string, unknown>,
  timeoutMs: number,
  maxStdoutBytes: number,
): Promise<LobsterEnvelope> {
  const cwd = resolveLocalLobsterCwd(runtime.configuredCwd);
  console.warn('[openclaw-gateway]', {
    event: 'workflow-local-fallback',
    sessionKey: runtime.sessionKey,
    cwd,
    stateDir: runtime.stateDir,
    timeoutMs,
    maxStdoutBytes,
    ...metadata,
  });

  let stdout = '';
  try {
    ({ stdout } = await execFileAsync('lobster', commandArgs, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: maxStdoutBytes,
      env: {
        ...process.env,
        LOBSTER_STATE_DIR: runtime.stateDir,
      },
    }));
  } catch (error) {
    const execError = error as Error & { stdout?: string; stderr?: string; code?: number | string | null };
    const localStdout = typeof execError.stdout === 'string' ? execError.stdout.trim() : '';
    const localStderr = typeof execError.stderr === 'string' ? execError.stderr.trim() : '';
    if (localStdout) {
      try {
        const parsed = JSON.parse(localStdout) as Record<string, unknown>;
        const localMessage =
          typeof parsed?.error === 'object' && parsed.error && typeof (parsed.error as Record<string, unknown>).message === 'string'
            ? String((parsed.error as Record<string, unknown>).message)
            : '';
        if (localMessage) {
          throw createGatewayError(
            'openclaw_gateway_server_error',
            localMessage,
            undefined,
            {
              localCli: true,
              stderr: localStderr || null,
              ...metadata,
            },
          );
        }
      } catch (parseOrGatewayError) {
        if (parseOrGatewayError instanceof OpenClawGatewayError) {
          throw parseOrGatewayError;
        }
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    throw createGatewayError(
      'openclaw_gateway_unreachable',
      `Local lobster CLI failed: ${message}`,
      undefined,
      {
        localCli: true,
        stderr: localStderr || null,
        ...metadata,
      },
    );
  }

  try {
    return asEnvelope(JSON.parse(stdout));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw createGatewayError('openclaw_gateway_response_invalid', `Local lobster CLI returned invalid JSON: ${message}`);
  }
}

async function invokeGateway(payload: Record<string, unknown>): Promise<LobsterEnvelope> {
  const testInvoker = (globalThis as Record<string, unknown>).__ARIES_OPENCLAW_TEST_INVOKER__ as OpenClawTestInvoker | undefined;
  if (testInvoker) {
    return await testInvoker(payload);
  }

  const response = await fetch(`${gatewayBaseUrl()}/tools/invoke`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${gatewayToken()}`,
    },
    body: JSON.stringify(payload),
  }).catch((error: unknown) => {
    throw createGatewayError(
      'openclaw_gateway_unreachable',
      String((error as Error)?.message || error),
      undefined,
      { operation: 'invoke', tool: payload.tool ?? null }
    );
  });

  if (response.status === 401) {
    throw createGatewayError('openclaw_gateway_unauthorized', 'OpenClaw gateway rejected the bearer token.', 401);
  }
  if (response.status === 404) {
    throw createGatewayError('openclaw_gateway_tool_unavailable', 'OpenClaw gateway does not expose the requested tool.', 404);
  }
  if (response.status === 400) {
    const body = (await response.json().catch(() => ({}))) as OpenClawInvokeResponse;
    throw createGatewayError(
      'openclaw_gateway_request_invalid',
      gatewayErrorMessage(body, 'OpenClaw gateway rejected the request.'),
      400,
    );
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as OpenClawInvokeResponse;
    throw createGatewayError(
      'openclaw_gateway_server_error',
      gatewayErrorMessage(body, `OpenClaw gateway failed with status ${response.status}.`),
      response.status,
    );
  }

  const body = (await response.json()) as OpenClawInvokeResponse;
  if (!body.ok || !body.result) {
    throw createGatewayError(
      'openclaw_gateway_response_invalid',
      body.error?.message || 'OpenClaw gateway returned an invalid success payload.',
    );
  }

  return asEnvelope(body.result.details);
}

export async function runOpenClawLobsterWorkflow(input: OpenClawWorkflowCallInput): Promise<LobsterEnvelope> {
  const runtime = resolveOpenClawLobsterRuntimeContext({ cwd: input.cwd });
  const timeoutMs = input.timeoutMs ?? 120000;
  const maxStdoutBytes = input.maxStdoutBytes ?? 1024 * 1024;
  console.info('[openclaw-gateway]', {
    event: 'workflow-run-requested',
    sessionKey: runtime.sessionKey,
    cwd: runtime.cwd,
    configuredCwd: runtime.configuredCwd === runtime.cwd ? undefined : runtime.configuredCwd,
    stateDir: runtime.stateDir,
    pipeline: input.pipeline,
    timeoutMs,
    maxStdoutBytes,
  });
  try {
    return await invokeGateway({
      tool: 'lobster',
      sessionKey: runtime.sessionKey,
      args: {
        action: 'run',
        pipeline: input.pipeline,
        argsJson: input.argsJson ?? '',
        cwd: runtime.cwd,
        timeoutMs,
        maxStdoutBytes,
      },
    });
  } catch (error) {
    if (!shouldFallbackToLocalLobster(error)) {
      throw error;
    }

    return invokeLocalLobster(
      runtime,
      ['run', '--mode', 'tool', '--file', input.pipeline, '--args-json', input.argsJson ?? ''],
      {
        action: 'run',
        pipeline: input.pipeline,
        fallbackReason: error instanceof Error ? error.message : String(error),
      },
      timeoutMs,
      maxStdoutBytes,
    );
  }
}

export async function resumeOpenClawLobsterWorkflow(input: OpenClawResumeCallInput): Promise<LobsterEnvelope> {
  const runtime = resolveOpenClawLobsterRuntimeContext({ cwd: input.cwd });
  const descriptor = describeLobsterResumeToken(input.token);
  const attempts = compatibleResumeTokens(input.token);
  const timeoutMs = input.timeoutMs ?? 120000;
  const maxStdoutBytes = input.maxStdoutBytes ?? 1024 * 1024;
  let lastError: unknown = null;

  for (let index = 0; index < attempts.length; index += 1) {
    const candidate = attempts[index];
    const candidateDescriptor = describeLobsterResumeToken(candidate);
    console.info('[openclaw-gateway]', {
      event: 'workflow-resume-requested',
      sessionKey: runtime.sessionKey,
      cwd: runtime.cwd,
      configuredCwd: runtime.configuredCwd === runtime.cwd ? undefined : runtime.configuredCwd,
      stateDir: runtime.stateDir,
      approve: input.approve,
      tokenFingerprint: candidateDescriptor.fingerprint,
      tokenStateKeys: candidateDescriptor.stateKeys,
      timeoutMs,
      maxStdoutBytes,
      compatibilityAttempt: index,
      compatibilityFallback: index > 0,
    });

    try {
      return await invokeGateway({
        tool: 'lobster',
        sessionKey: runtime.sessionKey,
        args: {
          action: 'resume',
          token: candidate,
          approve: input.approve,
          cwd: runtime.cwd,
          timeoutMs,
          maxStdoutBytes,
        },
      });
    } catch (error) {
      lastError = error;
      const canRetry = isOpenClawLobsterResumeStateMissing(error) && index < attempts.length - 1;
      console.warn('[openclaw-gateway]', {
        event: canRetry ? 'workflow-resume-compatibility-retry' : 'workflow-resume-failed',
        sessionKey: runtime.sessionKey,
        cwd: runtime.cwd,
        configuredCwd: runtime.configuredCwd === runtime.cwd ? undefined : runtime.configuredCwd,
        stateDir: runtime.stateDir,
        approve: input.approve,
        tokenFingerprint: candidateDescriptor.fingerprint,
        requestedTokenFingerprint: descriptor.fingerprint,
        tokenStateKeys: candidateDescriptor.stateKeys,
        compatibilityAttempt: index,
        compatibilityFallback: index > 0,
        reason: error instanceof Error ? error.message : String(error),
      });
      if (canRetry) {
        continue;
      }
      if (shouldFallbackToLocalLobster(error)) {
        return invokeLocalLobster(
          runtime,
          ['resume', '--mode', 'tool', '--token', candidate, '--approve', input.approve ? 'yes' : 'no'],
          {
            action: 'resume',
            tokenFingerprint: candidateDescriptor.fingerprint,
            tokenStateKeys: candidateDescriptor.stateKeys,
            fallbackReason: error instanceof Error ? error.message : String(error),
          },
          timeoutMs,
          maxStdoutBytes,
        );
      }
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('workflow_resume_failed');
}
