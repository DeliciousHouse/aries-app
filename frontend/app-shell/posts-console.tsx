'use client';

import { useState, type FormEvent } from 'react';

import { Button } from '@/components/redesign/primitives/button';
import { Card } from '@/components/redesign/primitives/card';
import { TextInput } from '@/components/redesign/primitives/input';
import { SelectInput } from '@/components/redesign/primitives/select';
import { usePublishDispatch } from '@/hooks/use-publish-dispatch';
import { usePublishRetry } from '@/hooks/use-publish-retry';

export default function PostsConsole(): JSX.Element {
  const publishDispatch = usePublishDispatch();
  const publishRetry = usePublishRetry();

  const [provider, setProvider] = useState('facebook');
  const [content, setContent] = useState('');
  const [scheduledFor, setScheduledFor] = useState('');
  const [retryAttempts, setRetryAttempts] = useState('3');

  async function handleDispatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await publishDispatch.dispatch({
      provider,
      content: content.trim(),
      scheduled_for: scheduledFor.trim() || undefined,
    });
  }

  async function handleRetry(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await publishRetry.retry({
      max_attempts: Number(retryAttempts) || 3,
    });
  }

  return (
    <div className="rd-workflow-grid rd-workflow-grid--2">
      <Card>
        <form onSubmit={handleDispatch} style={{ display: 'grid', gap: '1rem' }}>
          <div>
            <p className="rd-section-label">Publish dispatch</p>
            <h2 style={{ margin: '0.8rem 0 0.5rem', fontFamily: 'var(--rd-font-display)', fontSize: '1.5rem' }}>
              Send a publish request through Aries
            </h2>
            <p className="rd-section-description">
              This route stays browser-safe by posting only to Aries internal APIs. Gateway and Lobster details remain server-side.
            </p>
          </div>

          <label className="rd-field">
            <span className="rd-label">Provider</span>
            <SelectInput value={provider} onChange={(event) => setProvider(event.target.value)}>
              {['facebook', 'instagram', 'linkedin', 'x', 'youtube', 'reddit', 'tiktok'].map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </SelectInput>
          </label>

          <label className="rd-field">
            <span className="rd-label">Content</span>
            <TextInput value={content} onChange={(event) => setContent(event.target.value)} placeholder="Ship a platform-safe post from Aries." />
          </label>

          <label className="rd-field">
            <span className="rd-label">Schedule (optional)</span>
            <TextInput value={scheduledFor} onChange={(event) => setScheduledFor(event.target.value)} placeholder="2026-03-21T16:00:00Z" />
          </label>

          <Button type="submit" disabled={publishDispatch.isLoading || !content.trim()}>
            {publishDispatch.isLoading ? 'Dispatching…' : 'Dispatch publish event'}
          </Button>

          {publishDispatch.error ? (
            <div className="rd-alert rd-alert--danger">{publishDispatch.error.message}</div>
          ) : null}
          {publishDispatch.data ? (
            <div className="rd-json-panel"><code>{JSON.stringify(publishDispatch.data, null, 2)}</code></div>
          ) : null}
        </form>
      </Card>

      <Card>
        <form onSubmit={handleRetry} style={{ display: 'grid', gap: '1rem' }}>
          <div>
            <p className="rd-section-label">Repair controls</p>
            <h2 style={{ margin: '0.8rem 0 0.5rem', fontFamily: 'var(--rd-font-display)', fontSize: '1.5rem' }}>
              Request publish retry handling
            </h2>
            <p className="rd-section-description">
              Use bounded retry attempts through the internal route rather than exposing any workflow runner details to the browser.
            </p>
          </div>

          <label className="rd-field">
            <span className="rd-label">Max attempts</span>
            <TextInput value={retryAttempts} onChange={(event) => setRetryAttempts(event.target.value)} inputMode="numeric" />
          </label>

          <Button type="submit" variant="secondary" disabled={publishRetry.isLoading}>
            {publishRetry.isLoading ? 'Submitting…' : 'Request publish retry'}
          </Button>

          {publishRetry.error ? (
            <div className="rd-alert rd-alert--danger">{publishRetry.error.message}</div>
          ) : null}
          {publishRetry.data ? (
            <div className="rd-json-panel"><code>{JSON.stringify(publishRetry.data, null, 2)}</code></div>
          ) : null}
        </form>
      </Card>
    </div>
  );
}
