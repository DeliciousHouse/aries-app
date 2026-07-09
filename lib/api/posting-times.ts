import { ApiRequestError, requestJson } from './http';
import type { PostingTimeView } from '@/backend/marketing/posting-time-advisor';

/**
 * Browser client for the settings-hub "Posting times" card (AI-derived
 * per-platform posting times, ARIES_AI_POSTING_TIMES_ENABLED). Mirrors the
 * lib/api/marketing-schedule.ts idiom: typed result unions, routed through
 * requestJson so the mutation-guard header + shared 409 workspace-mismatch
 * interlock apply.
 */

export type { PostingTimeView };

export type PostingTimesErrorResult = {
  status: 'error';
  code: string;
  message: string;
  httpStatus: number;
};

export type PostingTimesFetchResult =
  | { status: 'ok'; enabled: boolean; postingTimes: PostingTimeView[] }
  | PostingTimesErrorResult;

export type PostingTimesDeriveResult =
  | { status: 'ok' }
  | PostingTimesErrorResult;

const POSTING_TIMES_PATH = '/api/marketing/posting-times';

export function postingTimesErrorMessage(code: string, fallback?: string): string {
  switch (code) {
    case 'forbidden':
      return 'Only workspace admins can trigger a new derivation.';
    case 'posting_times_disabled':
      return 'AI posting times are not enabled for this deployment.';
    case 'sign_in_required':
    case 'authentication_required':
    case 'unauthorized':
      return 'Your session expired — sign in again.';
    case 'request_timeout':
      return 'That took too long. Check your connection and try again.';
    default:
      return fallback && fallback.trim() && fallback.length < 160
        ? fallback
        : 'Could not load posting times. Try again.';
  }
}

function toErrorResult(error: unknown): PostingTimesErrorResult {
  if (error instanceof ApiRequestError) {
    return {
      status: 'error',
      code: error.code,
      message: postingTimesErrorMessage(error.code, error.message),
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

export async function fetchPostingTimes(): Promise<PostingTimesFetchResult> {
  try {
    const body = await requestJson<{ enabled: boolean; postingTimes: PostingTimeView[] }>(
      POSTING_TIMES_PATH,
      { method: 'GET' },
    );
    return {
      status: 'ok',
      enabled: body.enabled === true,
      postingTimes: Array.isArray(body.postingTimes) ? body.postingTimes : [],
    };
  } catch (error) {
    return toErrorResult(error);
  }
}

export async function derivePostingTimesNow(): Promise<PostingTimesDeriveResult> {
  try {
    await requestJson<{ status: string }>(`${POSTING_TIMES_PATH}/derive`, { method: 'POST' });
    return { status: 'ok' };
  } catch (error) {
    return toErrorResult(error);
  }
}
