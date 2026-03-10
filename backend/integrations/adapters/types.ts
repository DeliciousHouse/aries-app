export interface PublishDispatchEvent {
  tenant_id: string;
  provider: string;
  content: string;
  media_urls?: string[];
  scheduled_for?: string;
}

export interface NormalizedPublishPayload {
  provider: string;
  payload: Record<string, unknown>;
}

export interface ProviderAdapter {
  provider: string;
  normalizePublishEvent(event: PublishDispatchEvent): NormalizedPublishPayload;
}
