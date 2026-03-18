export type {
  JsonValue,
  OnboardingLifecycleStatus,
  ProvisioningStatus,
  ValidationStatus,
  OnboardingErrorReason,
  OnboardingStartRequest,
  OnboardingStartSuccess,
  OnboardingStartError,
  OnboardingStatusQuery,
  OnboardingStatusSuccess,
  OnboardingStatusError,
} from '@/lib/api/onboarding';

export interface OnboardingStatusPathParams {
  tenantId: string;
}
