import { assertFrontendSafeValue, CreativeMemoryValidationError } from '@/validators/creative-memory';

export class CreativeMemoryServiceError extends Error {
  readonly reason: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(reason: string, message: string, status = 500, details?: Record<string, unknown>) {
    super(message);
    this.name = 'CreativeMemoryServiceError';
    this.reason = reason;
    this.status = status;
    this.details = details;
  }
}

export function assertFrontendSafeResponse<T>(value: T): T {
  assertFrontendSafeValue(value);
  return value;
}

export function creativeMemoryOk<T>(data: T, init?: ResponseInit): Response {
  assertFrontendSafeResponse(data);
  return Response.json({ status: 'ok', data }, init);
}

function statusForUnknown(error: unknown): number {
  if (error instanceof CreativeMemoryServiceError) return error.status;
  if (error instanceof CreativeMemoryValidationError) return 400;
  return 500;
}

function reasonForUnknown(error: unknown): string {
  if (error instanceof CreativeMemoryServiceError) return error.reason;
  if (error instanceof CreativeMemoryValidationError) return error.reason;
  return 'creative_memory_error';
}

function messageForUnknown(error: unknown): string {
  if (error instanceof CreativeMemoryServiceError) return error.message;
  if (error instanceof CreativeMemoryValidationError) return error.message;
  return 'Creative Memory request failed.';
}

export function creativeMemoryErrorResponse(error: unknown): Response {
  const status = statusForUnknown(error);
  const body: Record<string, unknown> = {
    status: 'error',
    reason: reasonForUnknown(error),
    message: messageForUnknown(error),
  };
  if (error instanceof CreativeMemoryServiceError && error.details && status < 500) {
    body.details = error.details;
  }
  assertFrontendSafeResponse(body);
  return Response.json(body, { status });
}
