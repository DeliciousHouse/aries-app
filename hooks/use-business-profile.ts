'use client';

import { useCallback, useEffect, useMemo } from 'react';

import { createAriesV1Api, type BusinessProfilePatch, type BusinessProfileResponse, type TenantProfilesResponse } from '@/lib/api/aries-v1';
import { useAsyncAction, useRequestState } from './use-request-state';

export function useBusinessProfile(options: { baseUrl?: string; autoLoad?: boolean } = {}) {
  const api = useMemo(() => createAriesV1Api(options), [options.baseUrl]);
  const profile = useRequestState<BusinessProfileResponse>();
  const team = useRequestState<TenantProfilesResponse>();
  const save = useAsyncAction<BusinessProfileResponse>();
  const {
    setError: setProfileError,
    setLoading: setProfileLoading,
    setSuccess: setProfileSuccess,
  } = profile;
  const {
    setError: setTeamError,
    setLoading: setTeamLoading,
    setSuccess: setTeamSuccess,
  } = team;
  const { run: runSave } = save;

  const load = useCallback(async () => {
    setProfileLoading();
    setTeamLoading();
    try {
      const [profileResponse, teamResponse] = await Promise.all([
        api.getBusinessProfile(),
        api.getTenantProfiles(),
      ]);
      setProfileSuccess(profileResponse);
      setTeamSuccess(teamResponse);
      return { profileResponse, teamResponse };
    } catch (error) {
      setProfileError(error, 'Failed to load business profile.');
      setTeamError(error, 'Failed to load team settings.');
      return null;
    }
  }, [api, setProfileError, setProfileLoading, setProfileSuccess, setTeamError, setTeamLoading, setTeamSuccess]);

  const updateProfile = useCallback(async (body: BusinessProfilePatch) => {
    const response = await runSave(() => api.updateBusinessProfile(body), 'Failed to save business profile.');
    if (response) {
      setProfileSuccess(response);
    }
    return response;
  }, [api, runSave, setProfileSuccess]);

  useEffect(() => {
    if (options.autoLoad === false) return;
    void load();
  }, [load, options.autoLoad]);

  return { profile, team, save, load, updateProfile };
}
