import { ApiRequestError, requestJson } from './http';
import type { UsageAnalytics, UsageGranularity } from '@/backend/telemetry/usage-analytics';

/**
 * Browser client for the usage-analytics page (AA-166). Mirrors
 * lib/api/billing-quota.ts: typed result unions, routed through requestJson so
 * the shared 409 workspace-mismatch interlock applies.
 */

export type { UsageAnalytics, UsageGranularity };

export type UsageAnalyticsErrorResult = {
  status: 'error';
  code: string;
  message: string;
  httpStatus: number;
};

export type UsageAnalyticsFetchResult =
  | { status: 'ok'; analytics: UsageAnalytics; enforcementMetric: string }
  | UsageAnalyticsErrorResult;

const USAGE_ANALYTICS_PATH = '/api/telemetry/usage-analytics';

export function usageAnalyticsErrorMessage(code: string, fallback?: string): string {
  switch (code) {
    case 'usage_analytics_disabled':
      return 'Usage analytics is not switched on for this workspace.';
    case 'forbidden':
      return 'Only workspace admins can see the usage breakdown.';
    case 'usage_analytics_unavailable':
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
        : 'Could not load your usage breakdown. Try again.';
  }
}

export async function fetchUsageAnalytics(
  granularity: UsageGranularity,
): Promise<UsageAnalyticsFetchResult> {
  try {
    const body = await requestJson<{ analytics: UsageAnalytics; enforcementMetric?: string }>(
      USAGE_ANALYTICS_PATH,
      { method: 'GET', query: { granularity } },
    );
    return {
      status: 'ok',
      analytics: body.analytics,
      enforcementMetric: body.enforcementMetric ?? 'tasks',
    };
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return {
        status: 'error',
        code: error.code,
        message: usageAnalyticsErrorMessage(error.code, error.message),
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
