import type { ProviderAdapter, PublishDispatchEvent } from './types';

export const redditAdapter: ProviderAdapter = {
  provider: 'reddit',
  normalizePublishEvent(event: PublishDispatchEvent) {
    return { provider: 'reddit', payload: { title: event.content.slice(0, 200), body: event.content, media_urls: event.media_urls || [], scheduled_for: event.scheduled_for || null } };
  }
};
