export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

export type OnboardingStartState = 'accepted' | 'duplicate' | 'validated' | 'needs_repair';
export type OnboardingStatusState = 'validated' | 'needs_repair' | 'in_progress' | 'duplicate' | 'not_found';
export type OnboardingValidationStatus = 'pass' | 'fail' | 'unknown';

export type OnboardingErrorReason =
  | 'workflow_request_failed'
  | 'missing_required_query:tenant_id'
  | `missing_required_fields:${string}`
  | `workflow_unreachable:${string}`;

export interface OnboardingStartRequest {
  tenant_id: string;
  tenant_type: string;
  signup_event_id: string;
  metadata?: JsonValue;
}

export interface OnboardingStartSuccess {
  status: 'ok';
  tenant_id: string;
  tenant_type: string;
  signup_event_id: string;
  state: OnboardingStartState;
  workflow_status: number;
  raw: JsonValue;
}

export interface OnboardingStartError {
  status: 'error';
  tenant_id?: string;
  tenant_type?: string;
  signup_event_id?: string;
  workflow_status?: number;
  raw?: JsonValue;
  reason: OnboardingErrorReason;
}

export interface OnboardingStatusPathParams {
  tenantId: string;
}

export interface OnboardingStatusQuery {
  signup_event_id?: string;
}

export interface OnboardingStatusSuccess {
  status: 'ok';
  tenant_id: string;
  signup_event_id?: string;
  state: OnboardingStatusState;
  validation_status: OnboardingValidationStatus;
  paths: {
    draft?: string;
    validated?: string;
    validation_report?: string;
    idempotency_marker?: string;
  };
}

export interface OnboardingStatusError {
  status: 'error';
  reason: OnboardingErrorReason;
}
