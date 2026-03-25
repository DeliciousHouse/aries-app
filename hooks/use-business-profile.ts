'use client';

import { useCallback, useEffect, useMemo } from 'react';

import { createAriesV1Api, type BusinessProfilePatch, type BusinessProfileResponse, type TenantProfilesResponse } from '@/lib/api/aries-v1';
import { useAsyncAction, useRequestState } from './use-request-state';

export function useBusinessProfile(options: { baseUrl?: string; autoLoad?: boolean } = {}) {
  const api = useMemo(() => createAriesV1Api(options), [options.baseUrl]);
  const profile = useRequestState<BusinessProfileResponse>();
  const team = useRequestState<TenantProfilesResponse>();
  const save = useAsyncAction<BusinessProfileResponse>();

  const load = useCallback(async () => {
    profile.setLoading();
    team.setLoading();
    try {
      const [profileResponse, teamResponse] = await Promise.all([
        api.getBusinessProfile(),
        api.getTenantProfiles(),
      ]);
      profile.setSuccess(profileResponse);
      team.setSuccess(teamResponse);
      return { profileResponse, teamResponse };
    } catch (error) {
      profile.setError(error, 'Failed to load business profile.');
      team.setError(error, 'Failed to load team settings.');
      return null;
    }
  }, [api, profile, team]);

  const updateProfile = useCallback(async (body: BusinessProfilePatch) => {
    const response = await save.run(() => api.updateBusinessProfile(body), 'Failed to save business profile.');
    if (response) {
      profile.setSuccess(response);
    }
    return response;
  }, [api, profile, save]);

  useEffect(() => {
    if (options.autoLoad === false) return;
    void load();
  }, [load, options.autoLoad]);

  return { profile, team, save, load, updateProfile };
}
