'use client';

import { useCallback, useEffect, useMemo } from 'react';

import { createAriesV1Api, type InsightsCommentsResponse } from '@/lib/api/aries-v1';
import { ApiRequestError } from '@/lib/api/http';
import { customerSafeActionErrorMessage } from '@/frontend/aries-v1/customer-safe-copy';

import { useRequestState } from './use-request-state';

/**
 * Outcome of a single native-reply attempt (#597). The reply endpoint is gated
 * behind ARIES_NATIVE_REPLY_ENABLED and returns a real 404 when off — that case
 * maps to `not_enabled` so the inbox can show a subtle "native reply not
 * enabled" state instead of an error. `needs_attention` covers the 502
 * needs_manual_reconciliation / auth-reconnect classes the operator must act on.
 */
export type CommentReplyOutcome =
  | { kind: 'replied'; repliedAt: string | null }
  | { kind: 'not_enabled' }
  | { kind: 'error'; message: string };

export function useInsightsComments(
  options: { baseUrl?: string; autoLoad?: boolean; platform?: string } = {},
) {
  const baseUrl = options.baseUrl;
  const autoLoad = options.autoLoad;
  const platform = options.platform ?? 'facebook';

  const api = useMemo(() => createAriesV1Api({ baseUrl }), [baseUrl]);
  const state = useRequestState<InsightsCommentsResponse>();
  const { setError, setLoading, setSuccess } = state;

  const load = useCallback(async () => {
    setLoading();
    try {
      const response = await api.getInsightsComments({ platform });
      setSuccess(response);
      return response;
    } catch (error) {
      setError(error, 'Failed to load comments.');
      return null;
    }
  }, [api, platform, setError, setLoading, setSuccess]);

  useEffect(() => {
    if (autoLoad === false) return;
    void load();
  }, [load, autoLoad]);

  const reply = useCallback(
    async (commentId: number, replyText: string): Promise<CommentReplyOutcome> => {
      try {
        const result = await api.replyToInsightComment(commentId, replyText);
        return {
          kind: 'replied',
          repliedAt: result.status === 'replied' ? result.replied_at : null,
        };
      } catch (error) {
        // Flag off (or comment no longer exists) → the route is invisible (404).
        // Treat as "native reply not enabled" rather than a hard error.
        if (error instanceof ApiRequestError && error.status === 404) {
          return { kind: 'not_enabled' };
        }
        const message =
          error instanceof Error
            ? customerSafeActionErrorMessage(error.message, 'Reply could not be sent right now.')
            : 'Reply could not be sent right now.';
        return { kind: 'error', message };
      }
    },
    [api],
  );

  return { ...state, load, reply };
}
