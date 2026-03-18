'use client';

import { useCallback, useState } from 'react';

import {
  buildApiError,
  normalizeApiError,
  type ApiError,
  type QueryResult,
  type RequestState,
} from '@/lib/api/types';

function initialState<TData>(): QueryResult<TData> {
  return {
    data: null,
    error: null,
    status: 'idle',
  };
}

export function useRequestState<TData>() {
  const [state, setState] = useState<QueryResult<TData>>(initialState);

  const setLoading = useCallback(() => {
    setState((current) => ({
      data: current.data,
      error: null,
      status: 'loading',
    }));
  }, []);

  const setSuccess = useCallback((data: TData) => {
    setState({
      data,
      error: null,
      status: 'success',
    });
  }, []);

  const setError = useCallback((error: unknown, fallbackMessage?: string) => {
    const normalized =
      fallbackMessage && !(error instanceof Error)
        ? buildApiError(fallbackMessage)
        : normalizeApiError(error);

    setState((current) => ({
      data: current.data,
      error: normalized,
      status: 'error',
    }));
  }, []);

  const reset = useCallback(() => {
    setState(initialState());
  }, []);

  return {
    ...state,
    isLoading: state.status === 'loading',
    isSuccess: state.status === 'success',
    isError: state.status === 'error',
    setLoading,
    setSuccess,
    setError,
    reset,
  };
}

export interface AsyncActionState<TData> {
  data: TData | null;
  error: ApiError | null;
  status: RequestState;
  isLoading: boolean;
  isSuccess: boolean;
  isError: boolean;
  run: <TResult extends TData>(action: () => Promise<TResult>, fallbackMessage?: string) => Promise<TResult | null>;
  reset: () => void;
}

export function useAsyncAction<TData>(): AsyncActionState<TData> {
  const requestState = useRequestState<TData>();

  const run = useCallback<AsyncActionState<TData>['run']>(
    async (action, fallbackMessage) => {
      requestState.setLoading();
      try {
        const result = await action();
        requestState.setSuccess(result);
        return result;
      } catch (error) {
        requestState.setError(error, fallbackMessage);
        return null;
      }
    },
    [requestState]
  );

  return {
    ...requestState,
    run,
  };
}
