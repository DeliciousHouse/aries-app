import { resolveCodePath } from '../../lib/runtime-paths';

type OpenClawInvokeResponse = {
  ok: boolean;
  result?: {
    content?: Array<{ type?: string; text?: string }>;
    details?: unknown;
  };
  error?: {
    type?: string;
    message?: string;
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

function requiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new OpenClawGatewayError(
      'openclaw_gateway_not_configured',
      `Missing required OpenClaw environment variable: ${key}`,
    );
  }
  return value;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key]?.trim() || fallback;
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

function defaultLobsterCwd(): string {
  return optionalEnv(
    'OPENCLAW_GATEWAY_LOBSTER_CWD',
    optionalEnv('OPENCLAW_LOBSTER_CWD', resolveCodePath('lobster')),
  );
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
    throw new OpenClawGatewayError(
      'openclaw_gateway_unreachable',
      String((error as Error)?.message || error),
    );
  });

  if (response.status === 401) {
    throw new OpenClawGatewayError('openclaw_gateway_unauthorized', 'OpenClaw gateway rejected the bearer token.', 401);
  }
  if (response.status === 404) {
    throw new OpenClawGatewayError('openclaw_gateway_tool_unavailable', 'OpenClaw gateway does not expose the requested tool.', 404);
  }
  if (response.status === 400) {
    const body = (await response.json().catch(() => ({}))) as OpenClawInvokeResponse;
    throw new OpenClawGatewayError(
      'openclaw_gateway_request_invalid',
      body.error?.message || 'OpenClaw gateway rejected the request.',
      400,
    );
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as OpenClawInvokeResponse;
    throw new OpenClawGatewayError(
      'openclaw_gateway_server_error',
      body.error?.message || `OpenClaw gateway failed with status ${response.status}.`,
      response.status,
    );
  }

  const body = (await response.json()) as OpenClawInvokeResponse;
  if (!body.ok || !body.result) {
    throw new OpenClawGatewayError(
      'openclaw_gateway_response_invalid',
      body.error?.message || 'OpenClaw gateway returned an invalid success payload.',
    );
  }

  return asEnvelope(body.result.details);
}

export async function runOpenClawLobsterWorkflow(input: OpenClawWorkflowCallInput): Promise<LobsterEnvelope> {
  const cwd = input.cwd?.trim() || defaultLobsterCwd();
  return invokeGateway({
    tool: 'lobster',
    sessionKey: defaultSessionKey(),
    args: {
      action: 'run',
      pipeline: input.pipeline,
      argsJson: input.argsJson ?? '',
      cwd,
      timeoutMs: input.timeoutMs ?? 120000,
      maxStdoutBytes: input.maxStdoutBytes ?? 1024 * 1024,
    },
  });
}

export async function resumeOpenClawLobsterWorkflow(input: OpenClawResumeCallInput): Promise<LobsterEnvelope> {
  const cwd = input.cwd?.trim() || defaultLobsterCwd();
  return invokeGateway({
    tool: 'lobster',
    sessionKey: defaultSessionKey(),
    args: {
      action: 'resume',
      token: input.token,
      approve: input.approve,
      cwd,
      timeoutMs: input.timeoutMs ?? 120000,
      maxStdoutBytes: input.maxStdoutBytes ?? 1024 * 1024,
    },
  });
}
