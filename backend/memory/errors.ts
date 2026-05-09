export type MemoryErrorCode =
  | 'tenant_context_required'
  | 'workspace_lockin_violation'
  | 'pseudonym_salt_missing'
  | 'invalid_finding'
  | 'curator_rejected'
  | 'honcho_unavailable'
  | 'honcho_unauthorized'
  | 'workspace_not_found'
  | 'invalid_request';

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;
  readonly status: number;

  constructor(code: MemoryErrorCode, message: string, status = 400) {
    super(message);
    this.name = 'MemoryError';
    this.code = code;
    this.status = status;
  }
}
