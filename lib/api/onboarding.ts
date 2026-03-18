import { requestJson, type ApiClientOptions } from './http';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type OnboardingLifecycleStatus = 'accepted' | 'duplicate' | 'validated' | 'needs_repair';
export type ProvisioningStatus = 'validated' | 'needs_repair' | 'in_progress' | 'duplicate' | 'not_found';
export type ValidationStatus = 'pass' | 'fail' | 'unknown';

export type OnboardingErrorReason =
  | 'workflow_request_failed'
  | 'tenant_context_required'
  | `missing_required_query:${string}`
  | `missing_required_fields:${string}`
  | `workflow_unreachable:${string}`
  | string;

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
}

export interface OnboardingStartError {
  onboarding_status: 'error';
  reason: OnboardingErrorReason;
  message?: string;
  tenant_id?: string;
  tenant_type?: string;
  signup_event_id?: string;
}

export interface OnboardingStatusQuery {
  signup_event_id?: string;
}

export interface OnboardingStatusSuccess {
  onboarding_status: 'ok';
  tenant_id: string;
  signup_event_id?: string;
  provisioning_status: ProvisioningStatus;
  validation_status: ValidationStatus;
  progress_hint:
    | 'not_started'
    | 'waiting_for_validation'
    | 'validated'
    | 'repair_needed'
    | 'duplicate_request';
  artifacts: {
    draft: boolean;
    validated: boolean;
    validation_report: boolean;
    idempotency_marker: boolean;
  };
}

export interface OnboardingStatusError {
  onboarding_status: 'error';
  reason: OnboardingErrorReason;
  message?: string;
}

export type OnboardingStartResponse = OnboardingStartSuccess | OnboardingStartError;
export type OnboardingStatusResponse = OnboardingStatusSuccess | OnboardingStatusError;

export function createOnboardingApi(options: ApiClientOptions = {}) {
  return {
    start(body: OnboardingStartRequest) {
      return requestJson<OnboardingStartResponse>(
        '/api/onboarding/start',
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
        options
      );
    },

    status(tenantId: string, query?: OnboardingStatusQuery) {
      return requestJson<OnboardingStatusResponse>(
        `/api/onboarding/status/${encodeURIComponent(tenantId)}`,
        {
          method: 'GET',
          query: query ? { ...query } : undefined,
        },
        options
      );
    },
  };
}
