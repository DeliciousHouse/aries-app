import type { ProviderAdapter, PublishDispatchEvent } from './types';

export const tikTokAdapter: ProviderAdapter = {
  provider: 'tiktok',
  normalizePublishEvent(event: PublishDispatchEvent) {
    return { provider: 'tiktok', payload: { caption: event.content, video_urls: event.media_urls || [], publish_time: event.scheduled_for || null } };
  }
};
