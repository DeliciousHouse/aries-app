// lib/email.ts
//
// Outbound transactional email helpers backed by Resend (https://resend.com).
//
// Environment variables (names match Resend's official SDK conventions):
//   RESEND_API_KEY   Required in production. API key from
//                    https://resend.com/api-keys. The Resend Node SDK reads
//                    this directly as `new Resend(process.env.RESEND_API_KEY)`.
//                    When missing in production we log at ERROR level and
//                    skip the send; the caller still resolves successfully so
//                    routes don't leak "email not configured" as an oracle.
//   EMAIL_FROM       Fully-qualified "From" header, e.g.
//                    `Aries AI <noreply@sugarandleather.com>`. The
//                    domain portion MUST be verified at
//                    https://resend.com/domains before Resend will accept the
//                    send — otherwise Resend returns a 4xx that we only log.
//                    Falls back to the DEFAULT_FROM below when unset.
//                    For local/sandbox testing use `onboarding@resend.dev`
//                    (Resend's shared verified sender).

import { Resend } from 'resend';

const DEFAULT_FROM = 'Aries AI <noreply@sugarandleather.com>';

function renderHtml(code: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#0b0b0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;color:#f5f5f7;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0b0f;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#15151b;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:40px 32px;">
            <tr>
              <td style="text-align:center;">
                <div style="font-size:13px;letter-spacing:0.25em;text-transform:uppercase;color:rgba(255,255,255,0.55);margin-bottom:8px;">Aries AI</div>
                <h1 style="font-size:22px;font-weight:600;color:#ffffff;margin:0 0 16px;">Reset your password</h1>
                <p style="font-size:15px;line-height:1.5;color:rgba(255,255,255,0.7);margin:0 0 28px;">Use the verification code below to finish resetting your Aries AI password.</p>
                <div style="display:inline-block;padding:18px 28px;background:linear-gradient(135deg,rgba(124,58,237,0.25),rgba(236,72,153,0.2));border:1px solid rgba(124,58,237,0.45);border-radius:12px;font-size:32px;font-weight:700;letter-spacing:0.4em;color:#ffffff;">${code}</div>
                <p style="font-size:13px;color:rgba(255,255,255,0.5);margin:28px 0 0;">This code expires in 15 minutes.</p>
                <p style="font-size:13px;color:rgba(255,255,255,0.4);margin:16px 0 0;">If you didn't request this, you can safely ignore this email.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function renderText(code: string): string {
  return [
    'Aries AI password reset',
    '',
    `Your verification code: ${code}`,
    '',
    'This code expires in 15 minutes.',
    "If you didn't request this, you can safely ignore this email.",
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Notification email parameter types
// ---------------------------------------------------------------------------

export interface PlanReadyEmailParams {
  /** Operator email address */
  to: string;
  /** Human-readable week label, e.g. "May 6–12, 2026" */
  weekLabel: string;
  /** Number of posts in the plan */
  postCount: number;
  /** URL to the review page */
  reviewUrl: string;
}

export interface ApprovalNeededEmailParams {
  /** Operator email address */
  to: string;
  /** Human-readable week label */
  weekLabel: string;
  /** Number of posts awaiting approval */
  postCount: number;
  /** URL to the approval/review page */
  approvalUrl: string;
}

export interface PublishFailedEmailParams {
  /** Operator email address */
  to: string;
  /** Platform that failed, e.g. "Instagram" */
  platform: string;
  /** Short description of what failed, e.g. "3 posts" */
  failedDescription: string;
  /** URL to retry or investigate */
  retryUrl: string;
}

export interface MetaReconnectWarningEmailParams {
  /** Operator email address */
  to: string;
  /** Days until the token expires */
  daysUntilExpiry: number;
  /** URL to the reconnect flow */
  reconnectUrl: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type TestHook = (email: string, code: string) => void | Promise<void>;

function readTestHook(): TestHook | null {
  const hook = (globalThis as Record<string, unknown>).__ARIES_EMAIL_TEST_HOOK__;
  return typeof hook === 'function' ? (hook as TestHook) : null;
}

export interface NotificationEmailPayload {
  to: string;
  subject: string;
  html: string;
  text: string;
  context: string;
}

type NotificationTestHook = (payload: NotificationEmailPayload) => void | Promise<void>;

function readNotificationTestHook(): NotificationTestHook | null {
  const hook = (globalThis as Record<string, unknown>).__ARIES_NOTIFICATION_EMAIL_TEST_HOOK__;
  return typeof hook === 'function' ? (hook as NotificationTestHook) : null;
}

function getResendConfig(): { apiKey: string | null; from: string } {
  return {
    apiKey: process.env.RESEND_API_KEY?.trim() || null,
    from: process.env.EMAIL_FROM?.trim() || DEFAULT_FROM,
  };
}

async function sendEmail(opts: NotificationEmailPayload): Promise<void> {
  const hook = readNotificationTestHook();
  if (hook) {
    await hook(opts);
    return;
  }

  const { apiKey, from } = getResendConfig();

  if (!apiKey) {
    const level = process.env.NODE_ENV === 'production' ? 'error' : 'warn';
    console[level](
      `[email] RESEND_API_KEY is not set — ${opts.context} email WILL NOT be delivered. ` +
        'Set RESEND_API_KEY in the production environment (see https://resend.com/api-keys) ' +
        'and verify EMAIL_FROM domain at https://resend.com/domains.',
      { to: opts.to },
    );
    return;
  }

  try {
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({
      from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    });

    if ((result as { error?: unknown } | null)?.error) {
      console.error(`[email] Resend returned an error for ${opts.context} email.`, {
        to: opts.to,
        from,
        error: (result as { error: unknown }).error,
      });
    }
  } catch (error) {
    console.error(`[email] Failed to send ${opts.context} email.`, {
      to: opts.to,
      from,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// ---------------------------------------------------------------------------
// Shared HTML shell
// ---------------------------------------------------------------------------

function renderEmailHtml(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#0b0b0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;color:#f5f5f7;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0b0f;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#15151b;border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:40px 32px;">
            <tr>
              <td style="text-align:center;">
                <div style="font-size:13px;letter-spacing:0.25em;text-transform:uppercase;color:rgba(255,255,255,0.55);margin-bottom:8px;">Aries AI</div>
                <h1 style="font-size:22px;font-weight:600;color:#ffffff;margin:0 0 16px;">${title}</h1>
                ${bodyHtml}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function renderCtaButton(label: string, url: string): string {
  return `<a href="${url}" style="display:inline-block;margin-top:24px;padding:14px 28px;background:linear-gradient(135deg,rgba(124,58,237,0.85),rgba(236,72,153,0.7));border-radius:10px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${label}</a>`;
}

// ---------------------------------------------------------------------------
// Plan-ready email
// ---------------------------------------------------------------------------

function renderPlanReadyHtml(p: PlanReadyEmailParams): string {
  const body = `
    <p style="font-size:15px;line-height:1.5;color:rgba(255,255,255,0.7);margin:0 0 8px;">
      Your weekly posts for <strong style="color:#ffffff;">${p.weekLabel}</strong> are ready to review.
    </p>
    <p style="font-size:15px;line-height:1.5;color:rgba(255,255,255,0.7);margin:0 0 24px;">
      ${p.postCount} ${p.postCount === 1 ? 'post' : 'posts'} are waiting for your approval.
    </p>
    ${renderCtaButton('Review posts', p.reviewUrl)}
    <p style="font-size:13px;color:rgba(255,255,255,0.4);margin:24px 0 0;">
      Or copy this link: ${p.reviewUrl}
    </p>`;
  return renderEmailHtml('Your weekly posts are ready', body);
}

function renderPlanReadyText(p: PlanReadyEmailParams): string {
  return [
    'Aries AI — weekly posts ready',
    '',
    `Your weekly posts for ${p.weekLabel} are ready to review.`,
    `${p.postCount} ${p.postCount === 1 ? 'post' : 'posts'} are waiting for your approval.`,
    '',
    `Review posts: ${p.reviewUrl}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Approval-needed email
// ---------------------------------------------------------------------------

function renderApprovalNeededHtml(p: ApprovalNeededEmailParams): string {
  const body = `
    <p style="font-size:15px;line-height:1.5;color:rgba(255,255,255,0.7);margin:0 0 8px;">
      ${p.postCount} ${p.postCount === 1 ? 'post' : 'posts'} for <strong style="color:#ffffff;">${p.weekLabel}</strong>
      ${p.postCount === 1 ? 'needs' : 'need'} your approval before publishing.
    </p>
    ${renderCtaButton('Approve posts', p.approvalUrl)}
    <p style="font-size:13px;color:rgba(255,255,255,0.4);margin:24px 0 0;">
      Or copy this link: ${p.approvalUrl}
    </p>`;
  return renderEmailHtml('Approval needed', body);
}

function renderApprovalNeededText(p: ApprovalNeededEmailParams): string {
  return [
    'Aries AI — approval needed',
    '',
    `${p.postCount} ${p.postCount === 1 ? 'post' : 'posts'} for ${p.weekLabel} ${p.postCount === 1 ? 'needs' : 'need'} your approval before publishing.`,
    '',
    `Approve posts: ${p.approvalUrl}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Publish-failed email
// ---------------------------------------------------------------------------

function renderPublishFailedHtml(p: PublishFailedEmailParams): string {
  const body = `
    <p style="font-size:15px;line-height:1.5;color:rgba(255,255,255,0.7);margin:0 0 8px;">
      Publishing failed for <strong style="color:#ffffff;">${p.failedDescription}</strong> on ${p.platform}.
    </p>
    <p style="font-size:15px;line-height:1.5;color:rgba(255,255,255,0.7);margin:0 0 24px;">
      You can retry from the posts page.
    </p>
    ${renderCtaButton('Retry publishing', p.retryUrl)}
    <p style="font-size:13px;color:rgba(255,255,255,0.4);margin:24px 0 0;">
      Or copy this link: ${p.retryUrl}
    </p>`;
  return renderEmailHtml('Publishing failed', body);
}

function renderPublishFailedText(p: PublishFailedEmailParams): string {
  return [
    'Aries AI — publishing failed',
    '',
    `Publishing failed for ${p.failedDescription} on ${p.platform}.`,
    'You can retry from the posts page.',
    '',
    `Retry publishing: ${p.retryUrl}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Meta reconnect warning email
// ---------------------------------------------------------------------------

function renderMetaReconnectWarningHtml(p: MetaReconnectWarningEmailParams): string {
  const daysText =
    p.daysUntilExpiry === 1 ? 'tomorrow' : `in ${p.daysUntilExpiry} days`;
  const body = `
    <p style="font-size:15px;line-height:1.5;color:rgba(255,255,255,0.7);margin:0 0 8px;">
      Your Meta connection expires <strong style="color:#ffffff;">${daysText}</strong>.
    </p>
    <p style="font-size:15px;line-height:1.5;color:rgba(255,255,255,0.7);margin:0 0 24px;">
      Reconnect now to keep your posts publishing without interruption.
    </p>
    ${renderCtaButton('Reconnect Meta', p.reconnectUrl)}
    <p style="font-size:13px;color:rgba(255,255,255,0.4);margin:24px 0 0;">
      Or copy this link: ${p.reconnectUrl}
    </p>`;
  return renderEmailHtml('Reconnect your Meta account', body);
}

function renderMetaReconnectWarningText(p: MetaReconnectWarningEmailParams): string {
  const daysText =
    p.daysUntilExpiry === 1 ? 'tomorrow' : `in ${p.daysUntilExpiry} days`;
  return [
    'Aries AI — Meta reconnect needed',
    '',
    `Your Meta connection expires ${daysText}.`,
    'Reconnect now to keep your posts publishing without interruption.',
    '',
    `Reconnect Meta: ${p.reconnectUrl}`,
  ].join('\n');
}

export async function sendPasswordResetEmail(email: string, code: string): Promise<void> {
  const testHook = readTestHook();
  if (testHook) {
    await testHook(email, code);
    return;
  }

  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim() || DEFAULT_FROM;

  if (!apiKey) {
    // In production an unset RESEND_API_KEY silently breaks password reset,
    // so log at ERROR (not WARN) to make deployment misconfig obvious in logs
    // and alerting. In dev/test we still surface it but don't throw, so the
    // routes keep their no-enumeration 200 contract.
    const level = process.env.NODE_ENV === 'production' ? 'error' : 'warn';
    console[level](
      '[email] RESEND_API_KEY is not set — password reset email WILL NOT be delivered. ' +
        'Set RESEND_API_KEY in the production environment (see https://resend.com/api-keys) ' +
        'and verify EMAIL_FROM domain at https://resend.com/domains.',
      { to: email },
    );
    return;
  }

  try {
    const resend = new Resend(apiKey);
    const result = await resend.emails.send({
      from,
      to: email,
      subject: 'Reset your Aries AI password',
      html: renderHtml(code),
      text: renderText(code),
    });

    if ((result as { error?: unknown } | null)?.error) {
      // Typical causes: unverified EMAIL_FROM domain, invalid API key,
      // Resend rate limit (5 req/sec default). The error surfaces in
      // `result.error` rather than throwing.
      console.error('[email] Resend returned an error for password reset email.', {
        to: email,
        from,
        error: (result as { error: unknown }).error,
      });
    }
  } catch (error) {
    console.error('[email] Failed to send password reset email.', {
      to: email,
      from,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function sendPlanReadyEmail(params: PlanReadyEmailParams): Promise<void> {
  await sendEmail({
    to: params.to,
    subject: `Your weekly posts for ${params.weekLabel} are ready`,
    html: renderPlanReadyHtml(params),
    text: renderPlanReadyText(params),
    context: 'plan-ready',
  });
}

export async function sendApprovalNeededEmail(params: ApprovalNeededEmailParams): Promise<void> {
  await sendEmail({
    to: params.to,
    subject: `Approval needed — ${params.weekLabel} posts`,
    html: renderApprovalNeededHtml(params),
    text: renderApprovalNeededText(params),
    context: 'approval-needed',
  });
}

export async function sendPublishFailedEmail(params: PublishFailedEmailParams): Promise<void> {
  await sendEmail({
    to: params.to,
    subject: `Publishing failed on ${params.platform}`,
    html: renderPublishFailedHtml(params),
    text: renderPublishFailedText(params),
    context: 'publish-failed',
  });
}

export async function sendMetaReconnectWarningEmail(
  params: MetaReconnectWarningEmailParams,
): Promise<void> {
  await sendEmail({
    to: params.to,
    subject: 'Your Meta connection is expiring soon',
    html: renderMetaReconnectWarningHtml(params),
    text: renderMetaReconnectWarningText(params),
    context: 'meta-reconnect-warning',
  });
}
