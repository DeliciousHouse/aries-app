'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  createIntegrationsApi,
  isOauthErrorResult,
  type GetIntegrationsPageQuery,
  type GetIntegrationsPageResponse,
  type IntegrationCard,
  type IntegrationCardAction,
  type IntegrationPlatform,
} from '@/lib/api/integrations';
import { useRequestState } from './use-request-state';

export interface UseIntegrationsOptions {
  baseUrl?: string;
  initialQuery?: GetIntegrationsPageQuery;
  autoLoad?: boolean;
}

function createActionError(message: string, code: string, details: unknown) {
  return Object.assign(new Error(message), {
    status: 400,
    code,
    details,
  });
}

function callbackUrlFor(provider: string): string {
  if (typeof window === 'undefined') {
    return `http://localhost:8100/api/auth/oauth/${provider}/callback`;
  }

  return `${window.location.origin}/api/auth/oauth/${provider}/callback`;
}

export function useIntegrations(options: UseIntegrationsOptions = {}) {
  const api = useMemo(() => createIntegrationsApi(options), [options.baseUrl]);
  const state = useRequestState<GetIntegrationsPageResponse>();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const { setError, setLoading, setSuccess } = state;

  const refresh = useCallback(
    async (query: GetIntegrationsPageQuery = options.initialQuery ?? {}) => {
      setLoading();
      try {
        const response = await api.getPage(query);
        setSuccess(response);
        return response;
      } catch (error) {
        setError(error, 'Unable to load integrations page data.');
        return null;
      }
    },
    [api, options.initialQuery, setError, setLoading, setSuccess]
  );

  useEffect(() => {
    if (options.autoLoad === false) {
      return;
    }

    void refresh();
  }, [options.autoLoad, refresh]);

  const runAction = useCallback(
    async (action: IntegrationCardAction, card: Pick<IntegrationCard, 'platform'>) => {
      const actionKey = `${card.platform}:${action}`;
      setBusyAction(actionKey);
      try {
        if (action === 'connect') {
          const result = await api.oauthConnect(card.platform, {
            tenant_id: 'current',
            redirect_uri: callbackUrlFor(card.platform),
          });
          if (isOauthErrorResult(result)) {
            throw createActionError(
              result.message || 'Unable to start platform connection.',
              result.reason,
              result
            );
          }
          window.location.assign(result.authorization_url);
          return result;
        }

        if (action === 'reconnect') {
          const result = await api.oauthReconnect(card.platform, {
            connection_id: `current_${card.platform}`,
            redirect_uri: callbackUrlFor(card.platform),
          });
          if (isOauthErrorResult(result)) {
            throw createActionError(
              result.message || 'Unable to resume platform connection.',
              result.reason,
              result
            );
          }
          window.location.assign(result.authorization_url);
          return result;
        }

        if (action === 'disconnect') {
          const result = await api.oauthDisconnect(card.platform, {
            connection_id: `current_${card.platform}`,
          });
          if (isOauthErrorResult(result)) {
            throw createActionError(
              result.message || 'Unable to disconnect platform.',
              result.reason,
              result
            );
          }
          await refresh();
          return result;
        }

        if (action === 'sync_now') {
          await api.sync(card.platform as IntegrationPlatform);
          await refresh();
          return null;
        }

        return null;
      } catch (error) {
        setError(error, 'Unable to complete platform action.');
        return null;
      } finally {
        setBusyAction(null);
      }
    },
    [api, refresh, setError]
  );

  return {
    ...state,
    busyAction,
    refresh,
    runAction,
  };
}
