import { ApiRequestError, requestJson } from './http';
import type { MarketingScheduleRow } from '@/backend/marketing/schedule-store';

/**
 * Browser client for the settings-hub cadence card (multi-brand workspaces
 * Phase 1b, #803 task 1b). Mirrors the small-standalone-module idiom of
 * lib/api/workspace.ts (typed result unions instead of a growing method on
 * the giant createAriesV1Api() client) but — unlike that module — routes
 * through requestJson (lib/api/http.ts) rather than a bare fetch, because the
 * PATCH here is an ordinary tenant-scoped mutation that SHOULD carry the
 * multi-workspace mutation-guard header and participate in the shared 409
 * workspace-mismatch interlock (requestJson already reports that globally);
 * the switch endpoint's bare-fetch bypass is a documented exception specific
 * to that one call, not the general pattern.
 */

export type { MarketingScheduleRow };

export type MarketingSchedulePatch = {
  day?: number | string;
  hour?: number;
  /** Explicit `null` clears the stored timezone; omit the key to leave it untouched. */
  timezone?: string | null;
  enabled?: boolean;
};

export type MarketingScheduleErrorResult = {
  status: 'error';
  code: string;
  message: string;
  httpStatus: number;
};

export type MarketingScheduleFetchResult =
  | { status: 'ok'; schedule: MarketingScheduleRow | null }
  | MarketingScheduleErrorResult;

export type MarketingScheduleUpdateResult =
  | { status: 'ok'; schedule: MarketingScheduleRow }
  | MarketingScheduleErrorResult;

const SCHEDULE_PATH = '/api/marketing/schedule';

/** Same code -> friendly-copy mapping idiom as switchErrorMessage in workspace.ts. */
export function scheduleErrorMessage(code: string, fallback?: string): string {
  switch (code) {
    case 'invalid_day':
      return 'Pick a valid day of the week.';
    case 'invalid_hour':
      return 'Pick a valid hour.';
    case 'invalid_timezone':
      return 'Enter a valid IANA timezone, like America/New_York.';
    case 'invalid_enabled':
      return 'That toggle value was not recognized — try again.';
    case 'forbidden':
      return 'Only workspace admins can change the generation schedule.';
    case 'sign_in_required':
    case 'authentication_required':
    case 'unauthorized':
      return 'Your session expired — sign in again.';
    case 'request_timeout':
      return 'That took too long. Check your connection and try again.';
    default:
      return fallback && fallback.trim() && fallback.length < 160
        ? fallback
        : 'Could not save the generation schedule. Try again.';
  }
}

function toErrorResult(error: unknown): MarketingScheduleErrorResult {
  if (error instanceof ApiRequestError) {
    return {
      status: 'error',
      code: error.code,
      message: scheduleErrorMessage(error.code, error.message),
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

export async function fetchMarketingSchedule(): Promise<MarketingScheduleFetchResult> {
  try {
    const body = await requestJson<{ schedule: MarketingScheduleRow | null }>(SCHEDULE_PATH, {
      method: 'GET',
    });
    return { status: 'ok', schedule: body.schedule ?? null };
  } catch (error) {
    return toErrorResult(error);
  }
}

export async function updateMarketingSchedule(
  patch: MarketingSchedulePatch,
): Promise<MarketingScheduleUpdateResult> {
  try {
    const body = await requestJson<{ schedule: MarketingScheduleRow }>(SCHEDULE_PATH, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    return { status: 'ok', schedule: body.schedule };
  } catch (error) {
    return toErrorResult(error);
  }
}
