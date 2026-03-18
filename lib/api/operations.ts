import { requestJson, type ApiClientOptions } from './http';

export interface PublishDispatchRequest {
  provider: string;
  content: string;
  media_urls?: string[];
  scheduled_for?: string;
}

export interface PublishDispatchResponse {
  status: string;
  reason?: string;
  route?: string;
  message?: string;
  workflow_id?: string;
  workflow_status?: string;
  result?: unknown;
}

export interface PublishRetryRequest {
  max_attempts?: number;
}

export interface PublishRetryResponse {
  status: string;
  reason?: string;
  route?: string;
  message?: string;
  workflow_id?: string;
  workflow_status?: string;
  result?: unknown;
}

export interface CalendarSyncRequest {
  window_start?: string;
  window_end?: string;
}

export interface CalendarSyncResponse {
  status: string;
  reason?: string;
  route?: string;
  message?: string;
  workflow_id?: string;
  workflow_status?: string;
  result?: unknown;
}

export interface TenantWorkflow {
  id: string;
  tenant_id: string;
  type: string;
  pipeline: string;
  route: string;
  mode: 'real' | 'stub';
}

export interface TenantWorkflowRunRequest {
  inputs?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface TenantWorkflowRunResponse {
  status: string;
  reason?: string;
  route?: string;
  message?: string;
  workflow_id?: string;
  workflow_status?: string;
  result?: unknown;
}

export interface TenantUserProfile {
  id: string | number;
  tenantId?: string | number;
  email: string;
  fullName?: string | null;
  role: 'tenant_admin' | 'tenant_analyst' | 'tenant_viewer';
}

export interface CreateTenantProfileRequest {
  email: string;
  fullName?: string | null;
  role?: 'tenant_admin' | 'tenant_analyst' | 'tenant_viewer';
}

export interface UpdateTenantProfileRequest {
  fullName?: string | null;
  role?: 'tenant_admin' | 'tenant_analyst' | 'tenant_viewer';
}

export function createOperationsApi(options: ApiClientOptions = {}) {
  return {
    publishDispatch(body: PublishDispatchRequest) {
      return requestJson<PublishDispatchResponse>(
        '/api/publish/dispatch',
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
        options
      );
    },

    publishRetry(body: PublishRetryRequest = {}) {
      return requestJson<PublishRetryResponse>(
        '/api/publish/retry',
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
        options
      );
    },

    calendarSync(body: CalendarSyncRequest = {}) {
      return requestJson<CalendarSyncResponse>(
        '/api/calendar/sync',
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
        options
      );
    },

    tenantWorkflows() {
      return requestJson<{ workflows: TenantWorkflow[] }>(
        '/api/tenant/workflows',
        { method: 'GET' },
        options
      );
    },

    runTenantWorkflow(workflowId: string, body: TenantWorkflowRunRequest = {}) {
      return requestJson<TenantWorkflowRunResponse>(
        `/api/tenant/workflows/${encodeURIComponent(workflowId)}/runs`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
        options
      );
    },

    tenantProfiles() {
      return requestJson<{ profiles: TenantUserProfile[] }>(
        '/api/tenant/profiles',
        { method: 'GET' },
        options
      );
    },

    createTenantProfile(body: CreateTenantProfileRequest) {
      return requestJson<{ profile: TenantUserProfile }>(
        '/api/tenant/profiles',
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
        options
      );
    },

    updateTenantProfile(userId: string | number, body: UpdateTenantProfileRequest) {
      return requestJson<{ profile: TenantUserProfile }>(
        `/api/tenant/profiles/${encodeURIComponent(String(userId))}`,
        {
          method: 'PATCH',
          body: JSON.stringify(body),
        },
        options
      );
    },
  };
}
