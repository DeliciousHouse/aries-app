import type { z } from 'zod';
import type {
  ApprovalStageSchema,
  ApprovalStepSchema,
  CallbackAuthSchema,
  CallbackContextSchema,
  CallbackErrorSchema,
  CallbackApprovalSchema,
  CallbackStatusSchema,
  CallbackStageSchema,
  HermesRunCallbackPayloadSchema,
  HermesRunSubmissionSchema,
  HermesRunStatusResponseSchema,
  MarketingStageSchema,
} from './schemas';

export type MarketingStage = z.infer<typeof MarketingStageSchema>;
export type ApprovalStage = z.infer<typeof ApprovalStageSchema>;
export type ApprovalStep = z.infer<typeof ApprovalStepSchema>;
export type CallbackStatus = z.infer<typeof CallbackStatusSchema>;
/** Alias for consumers that used the Aries-internal name before the protocol package. */
export type HermesRunCallbackStatus = CallbackStatus;
export type CallbackStage = z.infer<typeof CallbackStageSchema>;
export type CallbackError = z.infer<typeof CallbackErrorSchema>;
export type CallbackApproval = z.infer<typeof CallbackApprovalSchema>;
export type HermesRunCallbackPayload = z.infer<typeof HermesRunCallbackPayloadSchema>;
export type CallbackAuth = z.infer<typeof CallbackAuthSchema>;
export type CallbackContext = z.infer<typeof CallbackContextSchema>;
export type HermesRunSubmission = z.infer<typeof HermesRunSubmissionSchema>;
export type HermesRunStatusResponse = z.infer<typeof HermesRunStatusResponseSchema>;
