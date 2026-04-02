import type { IntegrationCard, IntegrationCardAction } from '@/lib/api/integrations';
import type { BusinessProfileView, TenantProfilesResponse } from '@/lib/api/aries-v1';
import type { DashboardHeroMetric } from '@/frontend/aries-v1/components';

type TeamProfile = TenantProfilesResponse['profiles'][number];

export type SettingsIntegrationAction = Exclude<IntegrationCardAction, 'view_permissions'>;

export interface SettingsViewModel {
  hero: {
    eyebrow: string;
    title: string;
    description: string;
    metrics: DashboardHeroMetric[];
  };
  profileAvailable: boolean;
  profileSummary: {
    businessName: string;
    incomplete: boolean;
    launchApproverLabel: string;
  };
  brandKit: {
    brandName: string;
    sourceUrl: string;
    palette: string[];
    fonts: string[];
    hasBrandKit: boolean;
  };
  integrations: {
    cards: Array<{
      platform: IntegrationCard['platform'];
      displayName: string;
      handle: string;
      description: string;
      stateLabel: string;
      statusTone: 'default' | 'good' | 'watch';
      availableActions: SettingsIntegrationAction[];
      permissionSummary: string;
      syncLabel: string;
      errorMessage: string | null;
    }>;
  };
  team: {
    members: Array<{
      userId: string;
      name: string;
      email: string;
      role: string;
      isApprover: boolean;
    }>;
    approverOptions: Array<{
      value: string;
      label: string;
    }>;
  };
}

function actionIsSupported(action: IntegrationCardAction): action is SettingsIntegrationAction {
  return action !== 'view_permissions';
}

function actionStateLabel(card: IntegrationCard): string {
  if (card.connection_state === 'connected') {
    return 'Connected';
  }
  if (card.connection_state === 'reauth_required') {
    return 'Needs attention';
  }
  if (card.connection_state === 'connection_error') {
    return 'Connection error';
  }
  if (card.connection_state === 'connection_pending') {
    return 'Connection pending';
  }
  if (card.connection_state === 'disabled') {
    return 'Disabled';
  }
  return 'Not connected';
}

function actionTone(card: IntegrationCard): 'default' | 'good' | 'watch' {
  if (card.connection_state === 'connected') {
    return 'good';
  }
  if (card.connection_state === 'reauth_required' || card.connection_state === 'connection_error') {
    return 'watch';
  }
  return 'default';
}

function syncLabel(lastSyncedAt: string | null): string {
  if (!lastSyncedAt) {
    return 'Never synced';
  }

  const timestamp = Date.parse(lastSyncedAt);
  if (!Number.isFinite(timestamp)) {
    return 'Sync time unavailable';
  }

  return `Last synced ${new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(timestamp))}`;
}

function collectPalette(profile: BusinessProfileView | null): string[] {
  const colors = profile?.brandKit?.colors;
  if (!colors) {
    return [];
  }

  const palette = [
    colors.primary,
    colors.secondary,
    colors.accent,
    ...colors.palette,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);

  return [...new Set(palette)].slice(0, 6);
}

export function createSettingsViewModel(args: {
  profile: BusinessProfileView | null;
  teamProfiles: TeamProfile[];
  integrationCards: IntegrationCard[];
  integrationsPending?: boolean;
}): SettingsViewModel {
  const connectedCount = args.integrationCards.filter((card) => card.connection_state === 'connected').length;
  const attentionCount = args.integrationCards.filter(
    (card) => card.connection_state === 'reauth_required' || card.connection_state === 'connection_error',
  ).length;
  const palette = collectPalette(args.profile);
  const launchApproverLabel = args.profile?.launchApproverName || 'Owner default';

  return {
    hero: {
      eyebrow: 'Settings',
      title: 'Business profile, channels, and approvals',
      description:
        'This is the operational configuration layer for Aries: the business context, the publishing surfaces, and the people who need to approve launches.',
      metrics: [
        {
          label: 'Connected channels',
          value: args.integrationsPending ? '...' : String(connectedCount),
          detail: args.integrationsPending
            ? 'Loading integration status.'
            : args.integrationCards.length > 0
              ? `${args.integrationCards.length} total platform cards are available.`
              : 'No channels connected yet.',
          tone: args.integrationsPending || connectedCount > 0 ? 'good' : 'watch',
        },
        {
          label: 'Needs attention',
          value: args.integrationsPending ? '...' : String(attentionCount),
          detail: args.integrationsPending
            ? 'Checking platform health.'
            : attentionCount > 0
              ? 'Reconnect or sync these integrations before the next launch.'
              : 'No integrations currently need attention.',
          tone: attentionCount > 0 ? 'watch' : 'good',
        },
        {
          label: 'Team members',
          value: String(args.teamProfiles.length),
          detail:
            args.teamProfiles.length > 0
              ? 'Approver selection is driven by the real tenant profile list.'
              : 'No tenant profiles were loaded yet.',
        },
        {
          label: 'Profile status',
          value: args.profile?.incomplete ? 'Needs setup' : 'Ready',
          detail: args.profile?.incomplete
            ? 'Add missing business details to ground future campaigns.'
            : 'Business context is ready for runtime-backed campaigns.',
          tone: args.profile?.incomplete ? 'watch' : 'good',
        },
      ],
    },
    profileAvailable: args.profile !== null,
    profileSummary: {
      businessName: args.profile?.businessName || 'Your business',
      incomplete: args.profile?.incomplete ?? true,
      launchApproverLabel,
    },
    brandKit: {
      brandName: args.profile?.brandKit?.brand_name || args.profile?.businessName || 'Brand kit',
      sourceUrl: args.profile?.brandKit?.source_url || args.profile?.websiteUrl || 'No brand source saved yet',
      palette,
      fonts: args.profile?.brandKit?.font_families ?? [],
      hasBrandKit: args.profile?.brandKit !== null && args.profile?.brandKit !== undefined,
    },
    integrations: {
      cards: args.integrationCards.map((card) => ({
        platform: card.platform,
        displayName: card.display_name,
        handle: card.connected_account?.account_label || card.platform,
        description: card.description,
        stateLabel: actionStateLabel(card),
        statusTone: actionTone(card),
        availableActions: card.available_actions.filter(actionIsSupported),
        permissionSummary:
          card.permissions.length > 0
            ? `${card.permissions.filter((permission) => permission.granted).length}/${card.permissions.length} permissions granted`
            : 'No permissions reported yet',
        syncLabel: syncLabel(card.last_synced_at),
        errorMessage: card.error?.message || null,
      })),
    },
    team: {
      members: args.teamProfiles.map((profile) => ({
        userId: profile.userId,
        name: profile.fullName || profile.email,
        email: profile.email,
        role: profile.role,
        isApprover:
          args.profile?.launchApproverUserId === profile.userId ||
          (!args.profile?.launchApproverUserId && args.profile?.launchApproverName === profile.fullName),
      })),
      approverOptions: [
        {
          value: '',
          label: 'Owner default',
        },
        ...args.teamProfiles.map((profile) => ({
          value: profile.userId,
          label: `${profile.fullName || profile.email} · ${profile.role}`,
        })),
      ],
    },
  };
}
