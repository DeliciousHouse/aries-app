export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

export type OnboardingTransportStatus = 'ok' | 'error';
export type OnboardingLifecycleStatus = 'accepted' | 'duplicate' | 'validated' | 'needs_repair';
export type ProvisioningStatus = 'validated' | 'needs_repair' | 'in_progress' | 'duplicate' | 'not_found';
export type ValidationStatus = 'pass' | 'fail' | 'unknown';

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
  onboarding_status: OnboardingLifecycleStatus;
  workflow_status: number;
  raw: JsonValue;
}

export interface OnboardingStartError {
  onboarding_status: 'error';
  reason: OnboardingErrorReason;
  tenant_id?: string;
  tenant_type?: string;
  signup_event_id?: string;
  workflow_status?: number;
  raw?: JsonValue;
}

export interface OnboardingStatusPathParams {
  tenantId: string;
}

export interface OnboardingStatusQuery {
  signup_event_id?: string;
}

export interface OnboardingStatusSuccess {
  onboarding_status: 'ok';
  tenant_id: string;
  provisioning_status: ProvisioningStatus;
  validation_status: ValidationStatus;
  signup_event_id?: string;
  paths: {
    draft?: string;
    validated?: string;
    validation_report?: string;
    idempotency_marker?: string;
  };
}

export interface OnboardingStatusError {
  onboarding_status: 'error';
  reason: OnboardingErrorReason;
}
