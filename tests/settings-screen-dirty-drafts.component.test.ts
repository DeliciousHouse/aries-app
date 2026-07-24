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
        await new Promise((resolve) => setTimeout(resolve, 25));
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
    // Mounting this screen is expensive: jsdom + React + the Next router context,
    // then `useBusinessProfile`'s autoLoad round-trip and the effect that syncs the
    // loaded profile into input state. That costs ~200ms on an idle box but 0.6-1.4s
    // when the machine is oversubscribed, which straddles @testing-library's 1000ms
    // default and makes these two queries flake under parallel suite load.
    // Both conditions are monotonic — once an input holds its value it keeps it —
    // so there is no earlier signal to await and a longer budget cannot mask a bug:
    // it can only fail if the profile genuinely never reaches the inputs. Note this
    // is deliberately scoped to the mount queries; the in-flight "Saving…" assertion
    // below is a real transient and must keep the short default.
    const mountWait = { timeout: 15_000 };
    const businessName = await screen.findByDisplayValue('Stored Business', undefined, mountWait) as HTMLInputElement;
    const primaryGoal = await screen.findByDisplayValue('Increase social media presence', undefined, mountWait) as HTMLInputElement;
    const launchApprover = screen.getByLabelText('Launch approver') as HTMLSelectElement;

    fireEvent.change(businessName, { target: { value: 'Unsaved Draft Business' } });
    fireEvent.change(primaryGoal, { target: { value: 'Unsaved deliberate goal' } });
    fireEvent.change(launchApprover, { target: { value: '20' } });
    assert.equal(businessName.value, 'Unsaved Draft Business');
    assert.equal(primaryGoal.value, 'Unsaved deliberate goal');
    fireEvent.click(screen.getByRole('button', { name: 'Save approval settings' }));

    await waitFor(() => assert.equal(api.profilePatches.length, 1));
    await waitFor(() => {
      assert.equal(
        (screen.getAllByRole('button', { name: 'Saving…' })[0] as HTMLButtonElement).disabled,
        true,
      );
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
