import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  sendPlanReadyEmail,
  sendApprovalNeededEmail,
  sendPublishFailedEmail,
  sendMetaReconnectWarningEmail,
  type NotificationEmailPayload,
} from '../lib/email.js';

const HOOK_KEY = '__ARIES_NOTIFICATION_EMAIL_TEST_HOOK__';

function withHook(calls: NotificationEmailPayload[]): () => void {
  (globalThis as Record<string, unknown>)[HOOK_KEY] = (payload: NotificationEmailPayload) => {
    calls.push(payload);
  };
  return () => {
    delete (globalThis as Record<string, unknown>)[HOOK_KEY];
  };
}

describe('email-notifications', () => {
  describe('sendPlanReadyEmail', () => {
    it('sends to correct recipient with week label in subject', async () => {
      const calls: NotificationEmailPayload[] = [];
      const restore = withHook(calls);
      try {
        await sendPlanReadyEmail({
          to: 'operator@example.com',
          weekLabel: 'May 6–12, 2026',
          postCount: 3,
          reviewUrl: 'https://app.example.com/posts/review',
        });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].to, 'operator@example.com');
        assert.match(calls[0].subject, /May 6–12, 2026/);
        assert.match(calls[0].subject, /posts/i);
      } finally {
        restore();
      }
    });

    it('includes review URL in html and text', async () => {
      const calls: NotificationEmailPayload[] = [];
      const restore = withHook(calls);
      try {
        await sendPlanReadyEmail({
          to: 'operator@example.com',
          weekLabel: 'May 6–12, 2026',
          postCount: 3,
          reviewUrl: 'https://app.example.com/posts/review',
        });
        assert.match(calls[0].html, /https:\/\/app\.example\.com\/posts\/review/);
        assert.match(calls[0].text, /https:\/\/app\.example\.com\/posts\/review/);
      } finally {
        restore();
      }
    });

    it('uses "post" singular when postCount is 1', async () => {
      const calls: NotificationEmailPayload[] = [];
      const restore = withHook(calls);
      try {
        await sendPlanReadyEmail({
          to: 'operator@example.com',
          weekLabel: 'May 6–12, 2026',
          postCount: 1,
          reviewUrl: 'https://app.example.com/posts/review',
        });
        assert.match(calls[0].text, /1 post /);
      } finally {
        restore();
      }
    });

    it('does not mention "campaign" in subject, html, or text', async () => {
      const calls: NotificationEmailPayload[] = [];
      const restore = withHook(calls);
      try {
        await sendPlanReadyEmail({
          to: 'operator@example.com',
          weekLabel: 'May 6–12, 2026',
          postCount: 3,
          reviewUrl: 'https://app.example.com/posts/review',
        });
        assert.doesNotMatch(calls[0].subject, /campaign/i);
        assert.doesNotMatch(calls[0].html, /campaign/i);
        assert.doesNotMatch(calls[0].text, /campaign/i);
      } finally {
        restore();
      }
    });

    it('skips send when RESEND_API_KEY is missing and no hook is set', async () => {
      const saved = process.env.RESEND_API_KEY;
      delete process.env.RESEND_API_KEY;
      try {
        await assert.doesNotReject(
          sendPlanReadyEmail({
            to: 'operator@example.com',
            weekLabel: 'May 6–12, 2026',
            postCount: 3,
            reviewUrl: 'https://app.example.com/posts/review',
          }),
        );
      } finally {
        if (saved !== undefined) process.env.RESEND_API_KEY = saved;
      }
    });
  });

  describe('sendApprovalNeededEmail', () => {
    it('sends to correct recipient with approval in subject', async () => {
      const calls: NotificationEmailPayload[] = [];
      const restore = withHook(calls);
      try {
        await sendApprovalNeededEmail({
          to: 'operator@example.com',
          weekLabel: 'May 6–12, 2026',
          postCount: 2,
          approvalUrl: 'https://app.example.com/posts/approve',
        });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].to, 'operator@example.com');
        assert.match(calls[0].subject, /approval/i);
        assert.match(calls[0].subject, /May 6–12, 2026/);
      } finally {
        restore();
      }
    });

    it('includes approval URL in html and text', async () => {
      const calls: NotificationEmailPayload[] = [];
      const restore = withHook(calls);
      try {
        await sendApprovalNeededEmail({
          to: 'operator@example.com',
          weekLabel: 'May 6–12, 2026',
          postCount: 2,
          approvalUrl: 'https://app.example.com/posts/approve',
        });
        assert.match(calls[0].html, /https:\/\/app\.example\.com\/posts\/approve/);
        assert.match(calls[0].text, /https:\/\/app\.example\.com\/posts\/approve/);
      } finally {
        restore();
      }
    });

    it('does not mention "campaign" in any field', async () => {
      const calls: NotificationEmailPayload[] = [];
      const restore = withHook(calls);
      try {
        await sendApprovalNeededEmail({
          to: 'operator@example.com',
          weekLabel: 'May 6–12, 2026',
          postCount: 2,
          approvalUrl: 'https://app.example.com/posts/approve',
        });
        assert.doesNotMatch(calls[0].subject, /campaign/i);
        assert.doesNotMatch(calls[0].html, /campaign/i);
        assert.doesNotMatch(calls[0].text, /campaign/i);
      } finally {
        restore();
      }
    });
  });

  describe('sendPublishFailedEmail', () => {
    it('sends to correct recipient with platform in subject', async () => {
      const calls: NotificationEmailPayload[] = [];
      const restore = withHook(calls);
      try {
        await sendPublishFailedEmail({
          to: 'operator@example.com',
          platform: 'Instagram',
          failedDescription: '2 posts',
          retryUrl: 'https://app.example.com/posts/retry',
        });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].to, 'operator@example.com');
        assert.match(calls[0].subject, /Instagram/);
      } finally {
        restore();
      }
    });

    it('includes retry URL and platform in html and text', async () => {
      const calls: NotificationEmailPayload[] = [];
      const restore = withHook(calls);
      try {
        await sendPublishFailedEmail({
          to: 'operator@example.com',
          platform: 'Instagram',
          failedDescription: '2 posts',
          retryUrl: 'https://app.example.com/posts/retry',
        });
        assert.match(calls[0].html, /Instagram/);
        assert.match(calls[0].html, /https:\/\/app\.example\.com\/posts\/retry/);
        assert.match(calls[0].text, /Instagram/);
        assert.match(calls[0].text, /https:\/\/app\.example\.com\/posts\/retry/);
      } finally {
        restore();
      }
    });

    it('does not mention "campaign" in any field', async () => {
      const calls: NotificationEmailPayload[] = [];
      const restore = withHook(calls);
      try {
        await sendPublishFailedEmail({
          to: 'operator@example.com',
          platform: 'Instagram',
          failedDescription: '2 posts',
          retryUrl: 'https://app.example.com/posts/retry',
        });
        assert.doesNotMatch(calls[0].subject, /campaign/i);
        assert.doesNotMatch(calls[0].html, /campaign/i);
        assert.doesNotMatch(calls[0].text, /campaign/i);
      } finally {
        restore();
      }
    });
  });

  describe('sendMetaReconnectWarningEmail', () => {
    it('sends to correct recipient with Meta and expiry in subject', async () => {
      const calls: NotificationEmailPayload[] = [];
      const restore = withHook(calls);
      try {
        await sendMetaReconnectWarningEmail({
          to: 'operator@example.com',
          daysUntilExpiry: 7,
          reconnectUrl: 'https://app.example.com/platforms/reconnect',
        });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].to, 'operator@example.com');
        assert.match(calls[0].subject, /Meta/);
        assert.match(calls[0].subject, /expir/i);
      } finally {
        restore();
      }
    });

    it('includes reconnect URL in html and text', async () => {
      const calls: NotificationEmailPayload[] = [];
      const restore = withHook(calls);
      try {
        await sendMetaReconnectWarningEmail({
          to: 'operator@example.com',
          daysUntilExpiry: 7,
          reconnectUrl: 'https://app.example.com/platforms/reconnect',
        });
        assert.match(calls[0].html, /https:\/\/app\.example\.com\/platforms\/reconnect/);
        assert.match(calls[0].text, /https:\/\/app\.example\.com\/platforms\/reconnect/);
      } finally {
        restore();
      }
    });

    it('says "tomorrow" when daysUntilExpiry is 1', async () => {
      const calls: NotificationEmailPayload[] = [];
      const restore = withHook(calls);
      try {
        await sendMetaReconnectWarningEmail({
          to: 'operator@example.com',
          daysUntilExpiry: 1,
          reconnectUrl: 'https://app.example.com/platforms/reconnect',
        });
        assert.match(calls[0].text, /tomorrow/);
        assert.match(calls[0].html, /tomorrow/);
      } finally {
        restore();
      }
    });

    it('says "in N days" when daysUntilExpiry > 1', async () => {
      const calls: NotificationEmailPayload[] = [];
      const restore = withHook(calls);
      try {
        await sendMetaReconnectWarningEmail({
          to: 'operator@example.com',
          daysUntilExpiry: 5,
          reconnectUrl: 'https://app.example.com/platforms/reconnect',
        });
        assert.match(calls[0].text, /in 5 days/);
        assert.match(calls[0].html, /in 5 days/);
      } finally {
        restore();
      }
    });

    it('does not mention "campaign" in any field', async () => {
      const calls: NotificationEmailPayload[] = [];
      const restore = withHook(calls);
      try {
        await sendMetaReconnectWarningEmail({
          to: 'operator@example.com',
          daysUntilExpiry: 7,
          reconnectUrl: 'https://app.example.com/platforms/reconnect',
        });
        assert.doesNotMatch(calls[0].subject, /campaign/i);
        assert.doesNotMatch(calls[0].html, /campaign/i);
        assert.doesNotMatch(calls[0].text, /campaign/i);
      } finally {
        restore();
      }
    });

    it('skips send when RESEND_API_KEY is missing and no hook is set', async () => {
      const saved = process.env.RESEND_API_KEY;
      delete process.env.RESEND_API_KEY;
      try {
        await assert.doesNotReject(
          sendMetaReconnectWarningEmail({
            to: 'operator@example.com',
            daysUntilExpiry: 7,
            reconnectUrl: 'https://app.example.com/platforms/reconnect',
          }),
        );
      } finally {
        if (saved !== undefined) process.env.RESEND_API_KEY = saved;
      }
    });
  });
});
