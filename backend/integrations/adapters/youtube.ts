import type { ProviderAdapter, PublishDispatchEvent } from './types';

export const youTubeAdapter: ProviderAdapter = {
  provider: 'youtube',
  normalizePublishEvent(event: PublishDispatchEvent) {
    return { provider: 'youtube', payload: { title: event.content.slice(0, 100), description: event.content, media_urls: event.media_urls || [], schedule_time: event.scheduled_for || null } };
  }
};
