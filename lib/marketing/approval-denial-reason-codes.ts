export const APPROVAL_DENIAL_REASON_CODES = [
  'wrong-tone',
  'wrong-colors',
  'off-brand',
  'factually-wrong',
  'legal-concern',
  'other',
] as const;

export type ApprovalDenialReasonCode = (typeof APPROVAL_DENIAL_REASON_CODES)[number];

export function isApprovalDenialReasonCode(value: string): value is ApprovalDenialReasonCode {
  return (APPROVAL_DENIAL_REASON_CODES as readonly string[]).includes(value);
}
