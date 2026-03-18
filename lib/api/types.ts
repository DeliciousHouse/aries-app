export type RequestState = 'idle' | 'loading' | 'success' | 'error';

export interface ApiError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

export interface QueryResult<TData> {
  data: TData | null;
  error: ApiError | null;
  status: RequestState;
}

export interface MutationResult<TData> extends QueryResult<TData> {
  isSubmitting: boolean;
}

export function buildApiError(
  message: string,
  overrides: Partial<ApiError> = {}
): ApiError {
  return {
    status: overrides.status ?? 500,
    code: overrides.code ?? 'request_failed',
    message,
    details: overrides.details,
  };
}

export function normalizeApiError(error: unknown): ApiError {
  if (error instanceof Error && 'status' in error && 'code' in error) {
    return {
      status: Number((error as Error & { status?: number }).status ?? 500),
      code: String((error as Error & { code?: string }).code ?? 'request_failed'),
      message: error.message,
      details: (error as Error & { details?: unknown }).details,
    };
  }

  if (error instanceof Error) {
    return buildApiError(error.message);
  }

  return buildApiError('Unexpected request failure.');
}

export function isTerminalErrorCode(code: string): boolean {
  return [
    'workflow_missing_for_route',
    'tenant_context_required',
    'forbidden',
    'connection_not_found',
    'invalid_provider',
  ].includes(code);
}
