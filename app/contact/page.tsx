'use client';

import { useState, type FormEvent } from 'react';
import MarketingLayout from '../../frontend/marketing/MarketingLayout';

type FormState = 'idle' | 'submitting' | 'success' | 'error';

export default function ContactPage() {
  const [state, setState] = useState<FormState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitted) return;

    setState('submitting');
    setErrorMsg('');

    const form = e.currentTarget;
    const data = new FormData(form);

    const payload = {
      source: 'aries-ai-website',
      surface: 'marketing-site',
      page: '/contact',
      intent: 'contact',
      timestamp: new Date().toISOString(),
      user: {
        name: data.get('name') as string,
        email: data.get('email') as string,
        company: data.get('company') as string,
      },
      details: {
        message: data.get('message') as string,
        referrer: typeof document !== 'undefined' ? document.referrer : '',
      },
    };

    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message || `Request failed (${res.status})`);
      }

      setState('success');
      setSubmitted(true);
    } catch (err) {
      setState('error');
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    }
  }

  return (
    <MarketingLayout currentPath="/contact">
      <section className="section page-contact">
        <div className="container" style={{ maxWidth: 640 }}>
          <div className="section-header">
            <span className="section-label">Contact</span>
            <h1 className="section-title">Get in Touch</h1>
            <p className="section-desc">
              Questions about Aries? Want a demo? We&apos;d love to hear from you.
            </p>
          </div>

          {state === 'success' ? (
            <div className="alert alert-success" role="status" style={{ justifyContent: 'center' }}>
              ✓ Message received. We&apos;ll get back to you shortly.
            </div>
          ) : (
            <form
              onSubmit={handleSubmit}
              className="glass-card-static"
              style={{ display: 'grid', gap: '1.25rem' }}
            >
              <div className="form-group">
                <label htmlFor="contact-name" className="form-label">Name *</label>
                <input
                  id="contact-name"
                  name="name"
                  type="text"
                  className="form-input"
                  required
                  minLength={2}
                  maxLength={100}
                  placeholder="Your name"
                  autoComplete="name"
                />
              </div>

              <div className="form-group">
                <label htmlFor="contact-email" className="form-label">Email *</label>
                <input
                  id="contact-email"
                  name="email"
                  type="email"
                  className="form-input"
                  required
                  placeholder="you@company.com"
                  autoComplete="email"
                />
              </div>

              <div className="form-group">
                <label htmlFor="contact-company" className="form-label">Company</label>
                <input
                  id="contact-company"
                  name="company"
                  type="text"
                  className="form-input"
                  maxLength={120}
                  placeholder="Your company"
                  autoComplete="organization"
                />
              </div>

              <div className="form-group">
                <label htmlFor="contact-message" className="form-label">Message *</label>
                <textarea
                  id="contact-message"
                  name="message"
                  className="form-textarea"
                  required
                  minLength={10}
                  maxLength={2000}
                  placeholder="Tell us about your use case or ask a question..."
                />
              </div>

              {state === 'error' && (
                <div className="alert alert-error" role="alert">
                  ✕ {errorMsg}
                </div>
              )}

              <button
                type="submit"
                className="btn btn-primary btn-lg"
                disabled={state === 'submitting'}
                style={{ width: '100%' }}
                id="contact-submit"
              >
                {state === 'submitting' ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span className="spinner" /> Sending...
                  </span>
                ) : (
                  'Send Message'
                )}
              </button>
            </form>
          )}
        </div>
      </section>
    </MarketingLayout>
  );
}
