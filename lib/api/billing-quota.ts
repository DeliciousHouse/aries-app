import { ApiRequestError, requestJson } from './http';
import type { QuotaSummary } from '@/backend/billing/quota-summary';

/**
 * Browser client for the settings-hub "Usage & capacity" card (AA-164).
 * Mirrors lib/api/posting-times.ts: typed result unions, routed through
 * requestJson so the mutation-guard header + shared 409 workspace-mismatch
 * interlock apply.
 */

export type { QuotaSummary };

export type BillingQuotaErrorResult = {
  status: 'error';
  code: string;
  message: string;
  httpStatus: number;
};

export type BillingQuotaFetchResult =
  | { status: 'ok'; quota: QuotaSummary; canPurchase: boolean; purchaseEnabled: boolean }
  | BillingQuotaErrorResult;

const QUOTA_PATH = '/api/billing/quota';

export function billingQuotaErrorMessage(code: string, fallback?: string): string {
  switch (code) {
    case 'quota_unavailable':
      return "We couldn't read your usage right now. Try again in a moment.";
    case 'sign_in_required':
    case 'authentication_required':
    case 'unauthorized':
      return 'Your session expired — sign in again.';
    case 'request_timeout':
      return 'That took too long. Check your connection and try again.';
    default:
      return fallback && fallback.trim() && fallback.length < 160
        ? fallback
        : 'Could not load your usage. Try again.';
  }
}

export async function fetchBillingQuota(): Promise<BillingQuotaFetchResult> {
  try {
    const body = await requestJson<{
      quota: QuotaSummary;
      canPurchase?: boolean;
      purchaseEnabled?: boolean;
    }>(QUOTA_PATH, { method: 'GET' });
    return {
      status: 'ok',
      quota: body.quota,
      canPurchase: body.canPurchase === true,
      purchaseEnabled: body.purchaseEnabled === true,
    };
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return {
        status: 'error',
        code: error.code,
        message: billingQuotaErrorMessage(error.code, error.message),
        httpStatus: error.status,
      };
    }
    return {
      status: 'error',
      code: 'network_error',
      message: 'Could not reach the server. Check your connection and try again.',
      httpStatus: 0,
    };
  }
}
