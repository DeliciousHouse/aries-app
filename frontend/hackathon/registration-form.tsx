'use client';

import { useState, type FormEvent } from 'react';

interface HackathonRegistrationFormProps {
  deadlineLabel: string;
}

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export default function HackathonRegistrationForm({ deadlineLabel }: HackathonRegistrationFormProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [motivation, setMotivation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorText(null);
    setFieldErrors({});

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const localErrors: Record<string, string> = {};
    if (!trimmedName) localErrors.name = 'Name is required.';
    if (!trimmedEmail) localErrors.email = 'Email is required.';
    else if (!EMAIL_RE.test(trimmedEmail)) localErrors.email = 'Enter a valid email address.';
    if (Object.keys(localErrors).length > 0) {
      setFieldErrors(localErrors);
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/hackathon/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: trimmedName,
          email: trimmedEmail,
          motivation: motivation.trim(),
        }),
      });

      if (response.ok) {
        setDone(true);
        return;
      }

      let payload: { error?: string; fieldErrors?: Record<string, string> } = {};
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        payload = {};
      }
      if (response.status === 422 && payload.fieldErrors) {
        setFieldErrors(payload.fieldErrors);
      } else {
        setErrorText(
          payload.error === 'persist_failed'
            ? 'Something went wrong saving your registration. Try again in a moment.'
            : 'Submission failed. Try again or email support@sugarandleather.com.',
        );
      }
    } catch {
      setErrorText('Network error. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-2xl border border-primary/30 bg-primary/10 p-6">
        <p className="text-primary uppercase tracking-[0.2em] text-xs font-semibold mb-2">
          You&apos;re in
        </p>
        <p className="text-white/90 text-lg mb-2">
          Thanks, {name.trim() || 'builder'}. We&apos;ll send event details and the kickoff link to{' '}
          <span className="text-white">{email.trim()}</span> before {deadlineLabel}.
        </p>
        <p className="text-white/55 text-sm">
          Want to add a teammate? Send them this URL.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <h2 className="text-2xl font-semibold">Register</h2>
      <Field label="Name" required error={fieldErrors.name}>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="name"
          aria-invalid={fieldErrors.name ? true : undefined}
          className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
          placeholder="Your full name"
        />
      </Field>

      <Field label="Email" required error={fieldErrors.email}>
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          aria-invalid={fieldErrors.email ? true : undefined}
          className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
          placeholder="you@example.com"
        />
      </Field>

      <Field label="What brings you here?" error={fieldErrors.motivation}>
        <textarea
          value={motivation}
          onChange={(event) => setMotivation(event.target.value)}
          rows={3}
          className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-primary/50"
          placeholder="Optional. The problem you want to solve, the tools you'll bring, or just hello."
        />
      </Field>

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-full bg-gradient-to-r from-primary to-secondary px-6 py-4 text-white font-semibold shadow-xl shadow-primary/20 disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {submitting ? 'Registering…' : 'Lock in my spot'}
      </button>

      {errorText ? (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-2xl border border-red-500/20 bg-red-500/10 p-4 text-red-100"
        >
          {errorText}
        </div>
      ) : null}

      <p className="text-xs text-white/70">
        We&apos;ll only email you about this hackathon. Your address is not shared.
      </p>
    </form>
  );
}

function Field({
  label,
  required,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-sm font-medium text-white/80 mb-2">
        {label}
        {required ? <span className="text-primary"> *</span> : null}
      </span>
      {children}
      {error ? <p className="mt-2 text-sm text-red-300">{error}</p> : null}
    </label>
  );
}
