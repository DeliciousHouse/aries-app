import type { ProviderAdapter, PublishDispatchEvent } from './types';

export const xAdapter: ProviderAdapter = {
  provider: 'x',
  normalizePublishEvent(event: PublishDispatchEvent) {
    return { provider: 'x', payload: { text: event.content, media_urls: event.media_urls || [], post_at: event.scheduled_for || null } };
  }
};
