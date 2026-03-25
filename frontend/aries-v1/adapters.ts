import type { GetMarketingJobStatusResponse } from '@/lib/api/marketing';

import {
  ARIES_CAMPAIGNS,
  ARIES_CHANNELS,
  ARIES_WORKSPACE,
  getCampaignById,
  type AriesCampaign,
  type AriesChannelConnection,
  type AriesWorkspaceSnapshot,
} from './data';

type RuntimeIntegrationsShape = {
  cards?: Array<{
    platform: string;
    display_name: string;
    connection_state: string;
  }>;
} | null;

export function getHomeWorkspaceSnapshot(): AriesWorkspaceSnapshot {
  return ARIES_WORKSPACE;
}

export function getActiveCampaign(campaignId?: string | null): AriesCampaign {
  return getCampaignById(campaignId || ARIES_WORKSPACE.activeCampaignId);
}

export function hydrateCampaignFromRuntime(
  runtimeData: GetMarketingJobStatusResponse | null | undefined,
  fallbackCampaignId = ARIES_WORKSPACE.activeCampaignId,
): AriesCampaign {
  const fallback = getCampaignById(fallbackCampaignId);
  if (!runtimeData) {
    return fallback;
  }

  const runtimeStatus = String(runtimeData.marketing_job_status || '').toLowerCase();
  const mappedStatus =
    runtimeData.approvalRequired
      ? 'in_review'
      : runtimeStatus.includes('complete')
        ? 'scheduled'
        : runtimeStatus.includes('publish')
          ? 'scheduled'
          : runtimeStatus.includes('prod')
            ? 'in_review'
            : fallback.status;

  return {
    ...fallback,
    id: runtimeData.jobId || fallback.id,
    name: runtimeData.tenantName ? `${runtimeData.tenantName} Campaign` : fallback.name,
    status: mappedStatus,
    stageLabel: runtimeData.marketing_stage ? toTitle(runtimeData.marketing_stage) : fallback.stageLabel,
    summary: runtimeData.summary?.subheadline || fallback.summary,
    dateRange:
      runtimeData.campaignWindow?.start && runtimeData.campaignWindow?.end
        ? `${runtimeData.campaignWindow.start} - ${runtimeData.campaignWindow.end}`
        : fallback.dateRange,
    pendingApprovals: runtimeData.approvalRequired ? Math.max(1, fallback.pendingApprovals) : 0,
    nextScheduled: runtimeData.nextStep ? humanizeNextStep(runtimeData.nextStep) : fallback.nextScheduled,
  };
}

export function hydrateChannelsFromRuntime(runtimeData: RuntimeIntegrationsShape): AriesChannelConnection[] {
  if (!runtimeData?.cards?.length) {
    return ARIES_CHANNELS;
  }

  return runtimeData.cards.map((card) => ({
    id: card.platform,
    name: card.display_name,
    handle: card.platform,
    health:
      card.connection_state === 'connected'
        ? 'connected'
        : card.connection_state === 'reauth_required'
          ? 'attention'
          : 'not_connected',
    detail:
      card.connection_state === 'connected'
        ? 'Connected and ready for scheduling.'
        : card.connection_state === 'reauth_required'
          ? 'Needs reconnection before the next launch.'
          : 'Not connected yet. Safe to connect later.',
  }));
}

export function getCampaignCollection(): AriesCampaign[] {
  return ARIES_CAMPAIGNS;
}

function humanizeNextStep(value: string) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function toTitle(value: string) {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}
