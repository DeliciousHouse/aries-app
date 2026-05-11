export interface PublishDispatchEvent {
  tenant_id: string;
  provider: string;
  content: string;
  media_urls?: string[];
  scheduled_for?: string;
  /** When set, verified publish-dispatch outcomes mirror to Honcho `session-curated-<id>`. */
  marketing_job_id?: string;
}

export interface NormalizedPublishPayload {
  provider: string;
  payload: Record<string, unknown>;
}

export interface ProviderAdapter {
  provider: string;
  normalizePublishEvent(event: PublishDispatchEvent): NormalizedPublishPayload;
}
