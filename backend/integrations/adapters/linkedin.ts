import type { ProviderAdapter, PublishDispatchEvent } from './types';

export const linkedInAdapter: ProviderAdapter = {
  provider: 'linkedin',
  normalizePublishEvent(event: PublishDispatchEvent) {
    return { provider: 'linkedin', payload: { text: event.content, media: event.media_urls || [], scheduledAt: event.scheduled_for || null } };
  }
};
