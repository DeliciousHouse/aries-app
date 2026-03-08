// @ts-nocheck

export type PublishStage = 'create' | 'update' | 'activate' | 'repair' | 'unknown';

export interface StructuredFailurePayload {
  timestamp: string;
  stage: PublishStage;
  httpStatus: number | null;
  message: string;
  code?: string;
  details?: unknown;
  sectionPath: string;
  retryable: boolean;
  raw: unknown;
}

function inferSectionPath(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('connection')) return 'connections';
  if (m.includes('type') && m.includes('node')) return 'nodes[*].type';
  if (m.includes('parameter') || m.includes('expression')) return 'nodes[*].parameters';
  if (m.includes('activate') || m.includes('active')) return 'active';
  return 'workflow';
}

export function captureFailurePayload(input: {
  stage?: PublishStage;
  httpStatus?: number | null;
  responseBody?: unknown;
  error?: unknown;
}): StructuredFailurePayload {
  const stage = input.stage ?? 'unknown';
  const body = input.responseBody as any;
  const err = input.error as any;

  const message =
    body?.message ??
    body?.error?.message ??
    body?.reason ??
    err?.message ??
    'Unknown publish error';

  const code = body?.code ?? body?.error?.code ?? err?.code;
  const details = body?.details ?? body?.error?.details ?? err?.details;
  const sectionPath = inferSectionPath(String(message));
  const retryable = input.httpStatus !== 401 && input.httpStatus !== 403;

  return {
    timestamp: new Date().toISOString(),
    stage,
    httpStatus: input.httpStatus ?? null,
    message: String(message),
    code,
    details,
    sectionPath,
    retryable,
    raw: {
      responseBody: body,
      error: err
    }
  };
}
