'use client';

import { useCallback, useMemo, useState } from 'react';

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

  return useMemo(
    () => ({
      ...state,
      isLoading: state.status === 'loading',
      isSuccess: state.status === 'success',
      isError: state.status === 'error',
      setLoading,
      setSuccess,
      setError,
      reset,
    }),
    [reset, setError, setLoading, setSuccess, state]
  );
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
  const { setLoading, setSuccess, setError } = requestState;

  const run = useCallback<AsyncActionState<TData>['run']>(
    async (action, fallbackMessage) => {
      setLoading();
      try {
        const result = await action();
        setSuccess(result);
        return result;
      } catch (error) {
        setError(error, fallbackMessage);
        return null;
      }
    },
    [setError, setLoading, setSuccess]
  );

  return {
    ...requestState,
    run,
  };
}
