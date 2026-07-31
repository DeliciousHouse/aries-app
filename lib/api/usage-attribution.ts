import { ApiRequestError, requestJson } from './http';
import type {
  UsageAttribution,
  UsageAttributionFilters,
} from '@/backend/telemetry/usage-attribution';

/**
 * Browser client for the internal usage & cost dashboard (AA-165). Mirrors
 * lib/api/usage-analytics.ts.
 */

export type { UsageAttribution, UsageAttributionFilters };

/** What the screen's filter form holds. All optional except the date range. */
export type UsageAttributionQuery = {
  from: string;
  to: string;
  companyId?: string;
  userId?: string;
  taskKey?: string;
  engine?: string;
};

export type UsageAttributionFetchResult =
  | { status: 'ok'; attribution: UsageAttribution }
  | { status: 'error'; code: string; message: string; httpStatus: number };

const USAGE_ATTRIBUTION_PATH = '/api/internal/usage-attribution';

export function usageAttributionErrorMessage(code: string, fallback?: string): string {
  switch (code) {
    case 'internal_usage_dashboard_disabled':
      return 'The internal usage dashboard is not enabled on this deployment.';
    case 'forbidden':
      return 'This dashboard is limited to internal operations staff.';
    case 'sign_in_required':
      return 'Your session expired — sign in again.';
    case 'invalid_from':
    case 'invalid_to':
      return 'Enter dates as YYYY-MM-DD.';
    case 'invalid_range':
      return 'The start date must be on or before the end date.';
    case 'invalid_company':
      return 'Company must be a numeric id.';
    case 'invalid_user':
      return 'User must be a numeric id.';
    case 'invalid_engine':
      return 'Pick a valid execution type.';
    case 'invalid_task_key':
      return 'That task type is too long.';
    case 'usage_attribution_unavailable':
      return "We couldn't read usage right now. Try again in a moment.";
    default:
      return fallback && fallback.trim() && fallback.length < 160
        ? fallback
        : 'Could not load the usage breakdown. Try again.';
  }
}

export async function fetchUsageAttribution(
  query: UsageAttributionQuery,
): Promise<UsageAttributionFetchResult> {
  try {
    const body = await requestJson<{ attribution: UsageAttribution }>(USAGE_ATTRIBUTION_PATH, {
      method: 'GET',
      // buildApiUrl drops empty/undefined values, so an unset filter is simply
      // absent rather than sent as an empty string the route would reject.
      query: {
        from: query.from,
        to: query.to,
        companyId: query.companyId,
        userId: query.userId,
        taskKey: query.taskKey,
        engine: query.engine,
      },
    });
    return { status: 'ok', attribution: body.attribution };
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return {
        status: 'error',
        code: error.code,
        message: usageAttributionErrorMessage(error.code, error.message),
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
