import assert from 'node:assert/strict';
import test from 'node:test';

import { installJsdom } from './helpers/jsdom-env';

// DOM must exist before React / Next / @testing-library load.
installJsdom();
(globalThis as unknown as { self: Window }).self = window;

import React from 'react';

import AriesSettingsScreen from '../frontend/aries-v1/settings-screen';
import type { BusinessProfilePatch, BusinessProfileView } from '../lib/api/aries-v1';

type ProfilePatchCall = BusinessProfilePatch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installSettingsApi() {
  const profile: BusinessProfileView = {
    tenantId: '1',
    businessName: 'Stored Business',
    tenantSlug: 'stored-business',
    websiteUrl: 'https://stored.example',
    businessType: 'Consulting',
    primaryGoal: 'Increase social media presence',
    launchApproverUserId: '10',
    launchApproverName: 'Owner',
    offer: null,
    brandVoice: null,
    styleVibe: null,
    notes: null,
    competitorUrl: null,
    channels: [],
    timezone: 'America/New_York',
    reelAudioMode: 'music',
    brandIdentity: null,
    brandKit: null,
    incomplete: false,
  };
  let primaryGoalSource: 'explicit' | 'inferred' = 'inferred';
  const profilePatches: ProfilePatchCall[] = [];

  // In-flight gate for the PATCH.
  //
  // This used to be `await new Promise(r => setTimeout(r, 25))`, a fixed 25ms
  // sleep meant to hold the request open long enough for the test to observe
  // the disabled "Saving…" button. waitFor polls every 50ms, so on a loaded
  // machine it could step straight over that window and the assertion failed —
  // the test flaked ~3 runs in 5 under the full suite. The gate makes the
  // window explicit: the test releases it when it has finished asserting.
  let releasePatch: (() => void) | null = null;
  let patchGate: Promise<void> | null = null;

  (globalThis as unknown as { fetch: typeof fetch }).fetch = async (
    input: URL | RequestInfo,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url.startsWith('/api/business/profile')) {
      if (method === 'PATCH') {
        const patch = JSON.parse(String(init?.body ?? '{}')) as BusinessProfilePatch;
        profilePatches.push(patch);
        if (Object.prototype.hasOwnProperty.call(patch, 'businessName')) {
          profile.businessName = patch.businessName || profile.businessName;
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'websiteUrl')) {
          profile.websiteUrl = patch.websiteUrl || profile.websiteUrl;
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'businessType')) {
          profile.businessType = patch.businessType || profile.businessType;
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'primaryGoal')) {
          profile.primaryGoal = patch.primaryGoal || profile.primaryGoal;
          primaryGoalSource = 'explicit';
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'launchApproverUserId')) {
          profile.launchApproverUserId = patch.launchApproverUserId || null;
          profile.launchApproverName = patch.launchApproverUserId === '20' ? 'Teammate' : 'Owner';
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'reelAudioMode') && patch.reelAudioMode) {
          profile.reelAudioMode = patch.reelAudioMode;
        }
        if (patchGate) {
          const gate = patchGate;
          patchGate = null;
          releasePatch = null;
          await gate;
        }
      }
      return jsonResponse({ profile: { ...profile } });
    }

    if (url.startsWith('/api/tenant/profiles')) {
      return jsonResponse({
        profiles: [
          {
            userId: '10',
            email: 'owner@example.test',
            fullName: 'Owner',
            role: 'tenant_admin',
            status: 'active',
          },
          {
            userId: '20',
            email: 'teammate@example.test',
            fullName: 'Teammate',
            role: 'tenant_analyst',
            status: 'active',
          },
        ],
        viewer: { userId: '10', role: 'tenant_admin' },
      });
    }

    if (url.startsWith('/api/integrations')) {
      return jsonResponse({
        status: 'ok',
        page_state: 'ready',
        supported_platforms: [],
        cards: [],
        summary: { total: 0, connected: 0, not_connected: 0, attention_required: 0 },
      });
    }

    if (url.startsWith('/api/marketing/schedule')) {
      return jsonResponse({ schedule: null });
    }

    if (url.startsWith('/api/marketing/posting-times')) {
      return jsonResponse({ enabled: false, postingTimes: [] });
    }

    if (url.startsWith('/api/tenant/workspace/memberships')) {
      return jsonResponse({ currentWorkspaceId: '1', workspaces: [], pendingInvites: [] });
    }

    throw new Error(`Unexpected Settings API call: ${method} ${url}`);
  };

  return {
    profile,
    profilePatches,
    getPrimaryGoalSource: () => primaryGoalSource,
    /**
     * Hold the next PATCH open until the returned function is called, so a test
     * can deterministically observe the in-flight UI state.
     */
    holdNextPatch(): () => void {
      // Capture the resolver in this closure rather than reading the shared
      // `releasePatch` binding — the fetch handler clears that binding when it
      // takes the gate, so a late read would find null and never release.
      let resolveGate: (() => void) | null = null;
      patchGate = new Promise<void>((resolve) => {
        resolveGate = resolve;
      });
      releasePatch = () => resolveGate?.();
      return () => resolveGate?.();
    },
  };
}

async function mountSettings() {
  const { render } = await import('@testing-library/react');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const router = {
    push() {},
    replace() {},
    prefetch() {},
    back() {},
    forward() {},
    refresh() {},
  };
  return render(
    React.createElement(
      AppRouterContext.Provider as never,
      { value: router as never },
      React.createElement(AriesSettingsScreen),
    ),
  );
}

test('approval-only save preserves dirty business drafts until a deliberate business-profile save', async () => {
  const { act, fireEvent, waitFor, cleanup } = await import('@testing-library/react');
  const api = installSettingsApi();
  const screen = await mountSettings();

  try {
    const businessName = await screen.findByDisplayValue('Stored Business') as HTMLInputElement;
    const primaryGoal = await screen.findByDisplayValue('Increase social media presence') as HTMLInputElement;
    const launchApprover = screen.getByLabelText('Launch approver') as HTMLSelectElement;

    fireEvent.change(businessName, { target: { value: 'Unsaved Draft Business' } });
    fireEvent.change(primaryGoal, { target: { value: 'Unsaved deliberate goal' } });
    fireEvent.change(launchApprover, { target: { value: '20' } });
    assert.equal(businessName.value, 'Unsaved Draft Business');
    assert.equal(primaryGoal.value, 'Unsaved deliberate goal');
    // Hold the PATCH open so the in-flight state is observable regardless of
    // machine load, instead of racing a fixed 25ms sleep.
    const releasePatch = api.holdNextPatch();
    fireEvent.click(screen.getByRole('button', { name: 'Save approval settings' }));

    await waitFor(() => assert.equal(api.profilePatches.length, 1));
    await waitFor(() => {
      assert.equal(
        (screen.getAllByRole('button', { name: 'Saving…' })[0] as HTMLButtonElement).disabled,
        true,
      );
    });
    await act(async () => {
      releasePatch();
      await Promise.resolve();
    });
    await screen.findByRole('button', { name: 'Save approval settings' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(api.profilePatches[0], { launchApproverUserId: '20' });
    assert.equal(api.profile.businessName, 'Stored Business');
    assert.equal(api.profile.primaryGoal, 'Increase social media presence');
    assert.equal(api.getPrimaryGoalSource(), 'inferred');
    assert.equal(businessName.value, 'Unsaved Draft Business');
    assert.equal(primaryGoal.value, 'Unsaved deliberate goal');

    fireEvent.click(screen.getByRole('button', { name: 'Save business profile' }));

    await waitFor(() => assert.equal(api.profilePatches.length, 2));
    assert.equal(api.profile.businessName, 'Unsaved Draft Business');
    assert.equal(api.profile.primaryGoal, 'Unsaved deliberate goal');
    assert.equal(api.getPrimaryGoalSource(), 'explicit');
    assert.equal(api.profilePatches[1]?.launchApproverUserId, '20');
  } finally {
    cleanup();
  }
});
