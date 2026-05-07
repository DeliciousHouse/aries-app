'use client';

import { useCallback, useEffect, useMemo } from 'react';

import {
  createAriesV1Api,
  type ReviewDecisionRequest,
  type ReviewItemCopyEditRequest,
  type ReviewItemCopyEditResponse,
  type ReviewItemResponse,
} from '@/lib/api/aries-v1';
import { useAsyncAction, useRequestState } from './use-request-state';

export function useRuntimeReviewItem(
  reviewId: string,
  options: { baseUrl?: string; autoLoad?: boolean; initialData?: ReviewItemResponse | null } = {},
) {
  const api = useMemo(() => createAriesV1Api(options), [options.baseUrl]);
  const state = useRequestState<ReviewItemResponse>();
  const decision = useAsyncAction<ReviewItemResponse>();
  const copyEdit = useAsyncAction<ReviewItemCopyEditResponse>();
  const { setError, setLoading, setSuccess } = state;

  const load = useCallback(async () => {
    if (!reviewId.trim()) {
      setError(new Error('reviewId is required'));
      return null;
    }
    setLoading();
    try {
      const response = await api.getReviewItem(reviewId);
      setSuccess(response);
      return response;
    } catch (error) {
      setError(error, 'Failed to load review item.');
      return null;
    }
  }, [api, reviewId, setError, setLoading, setSuccess]);

  const submitDecision = useCallback(async (body: ReviewDecisionRequest) => {
    const response = await decision.run(() => api.decideReview(reviewId, body), 'Failed to save review decision.');
    if (response) {
      setSuccess(response);
    }
    return response;
  }, [api, decision, reviewId, setSuccess]);

  const updateCopy = useCallback(async (jobId: string, postId: string, body: ReviewItemCopyEditRequest) => {
    const response = await copyEdit.run(
      () => api.updateReviewItemCopy(jobId, postId, body),
      'Failed to save copy edits.',
    );
    if (response) {
      setSuccess({ review: response.review });
    }
    return response;
  }, [api, copyEdit, setSuccess]);

  useEffect(() => {
    if (options.autoLoad === false) return;
    if (options.initialData?.review.id === reviewId) return;
    void load();
  }, [load, options.autoLoad, options.initialData?.review.id, reviewId]);

  return { ...state, load, decision, submitDecision, copyEdit, updateCopy };
}
