export type BackendErrorKind = 'validation_error' | 'repair_error' | 'hard_failure';
export type BackendErrorStatus = 'invalid' | 'repairable' | 'failed';

export interface BackendErrorBase {
  kind: BackendErrorKind;
  status: BackendErrorStatus;
  code: string;
  message: string;
  details?: object | unknown[] | string | null;
  job_id?: string;
  tenant_id?: string;
  trace_id?: string;
  at?: string;
}

export interface ValidationFieldError {
  field: string;
  reason: string;
}

export interface ValidationError extends BackendErrorBase {
  kind: 'validation_error';
  status: 'invalid';
  field_errors: ValidationFieldError[];
}

export interface RepairError extends BackendErrorBase {
  kind: 'repair_error';
  status: 'repairable';
  stage: string;
  attempt: number;
  max_attempts: number;
}

export type FailureClass = 'env_missing' | 'auth_failure' | 'io_failure' | 'schema_invalid' | 'unhandled_exception';

export interface HardFailureError extends BackendErrorBase {
  kind: 'hard_failure';
  status: 'failed';
  failure_class: FailureClass;
}

export type BackendError = ValidationError | RepairError | HardFailureError;
