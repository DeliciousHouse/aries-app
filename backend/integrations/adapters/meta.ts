import type { ProviderAdapter, PublishDispatchEvent } from './types';

export const metaAdapter: ProviderAdapter = {
  provider: 'meta',
  normalizePublishEvent(event: PublishDispatchEvent) {
    return {
      provider: event.provider,
      payload: {
        message: event.content,
        media: event.media_urls || [],
        publish_at: event.scheduled_for || null
      }
    };
  }
};
