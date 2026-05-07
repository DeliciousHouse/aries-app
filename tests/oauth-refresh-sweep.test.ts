import assert from 'node:assert/strict';
import test from 'node:test';

import { runOAuthRefreshSweep } from '../backend/integrations/refresh-sweeper.js';
import type {
  SweeperAuditFn,
  SweeperEmailFn,
  SweeperRefreshFn,
} from '../backend/integrations/refresh-sweeper.js';

type ConnectionRow = {
  id: string;
  tenant_id: string;
  provider: 'facebook' | 'instagram' | 'linkedin' | 'x' | 'youtube' | 'reddit' | 'tiktok' | 'openai';
  status: 'connected' | 'reauthorization_required' | 'pending' | 'disconnected' | 'error';
  token_expires_at: string | null;
  refresh_expires_at: string | null;
};

type UserRow = {
  id: number;
  email: string;
  organization_id: number;
  role: string;
};

type AuditEntry = {
  tenant_id: string | null;
  connection_id: string | null;
  provider: string | null;
  event_type: string;
  event_status: 'ok' | 'error';
  detail: unknown;
  occurred_at: string;
};

type EmailCall = { to: string; daysUntilExpiry: number; reconnectUrl: string };
type RefreshCall = { provider: string; tenantId: string };

type Harness = {
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> };
  audits: AuditEntry[];
  audit: SweeperAuditFn;
  emailCalls: EmailCall[];
  refreshCalls: RefreshCall[];
};

function createHarness(seed: {
  connections: ConnectionRow[];
  users: UserRow[];
  audits?: AuditEntry[];
}): Harness {
  const connections = [...seed.connections];
  const users = [...seed.users];
  const audits: AuditEntry[] = [...(seed.audits ?? [])];
  const emailCalls: EmailCall[] = [];
  const refreshCalls: RefreshCall[] = [];

  async function query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const text = sql;

    if (text.includes('FROM oauth_connections') && text.includes("provider IN ('facebook','instagram')")) {
      const lower = String(params[0]);
      const upper = String(params[1]);
      const matched = connections
        .filter((c) => c.status === 'connected' && (c.provider === 'facebook' || c.provider === 'instagram'))
        .filter((c) => c.token_expires_at != null && c.token_expires_at > lower && c.token_expires_at < upper)
        .sort((a, b) => (a.token_expires_at ?? '').localeCompare(b.token_expires_at ?? ''))
        .map((c) => {
          const candidate = users
            .filter((u) => String(u.organization_id) === c.tenant_id)
            .sort((a, b) => {
              const aRank = a.role === 'tenant_admin' ? 0 : 1;
              const bRank = b.role === 'tenant_admin' ? 0 : 1;
              return aRank !== bRank ? aRank - bRank : a.id - b.id;
            })[0];
          return {
            connection_id: c.id,
            tenant_id: c.tenant_id,
            provider: c.provider,
            token_expires_at: c.token_expires_at,
            operator_email: candidate?.email ?? null,
          };
        });
      return { rows: matched, rowCount: matched.length };
    }

    if (text.includes('FROM oauth_connections') && text.includes("status = 'connected'") && text.includes('token_expires_at <')) {
      const upper = String(params[0]);
      const matched = connections
        .filter((c) => c.status === 'connected' && c.token_expires_at != null && c.token_expires_at < upper)
        .sort((a, b) => (a.token_expires_at ?? '').localeCompare(b.token_expires_at ?? ''))
        .map((c) => ({
          connection_id: c.id,
          tenant_id: c.tenant_id,
          provider: c.provider,
          token_expires_at: c.token_expires_at,
          refresh_expires_at: c.refresh_expires_at,
        }));
      return { rows: matched, rowCount: matched.length };
    }

    if (text.includes('FROM oauth_audit_events') && text.includes('reconnect_warning.sent')) {
      const tenantId = Number(params[0]);
      const cooldownStart = String(params[1]);
      const hit = audits.find(
        (a) =>
          a.event_type === 'oauth.reconnect_warning.sent' &&
          a.tenant_id != null &&
          Number(a.tenant_id) === tenantId &&
          a.occurred_at > cooldownStart,
      );
      return { rows: hit ? [{ hit: 1 }] : [], rowCount: hit ? 1 : 0 };
    }

    throw new Error(`Unhandled SQL in test harness: ${text}`);
  }

  const audit: SweeperAuditFn = async (entry) => {
    audits.push({
      tenant_id: entry.tenantId ?? null,
      connection_id: entry.connectionId ?? null,
      provider: entry.provider ?? null,
      event_type: entry.eventType,
      event_status: entry.eventStatus,
      detail: entry.detail ?? {},
      occurred_at: new Date().toISOString(),
    });
  };

  return {
    client: { query },
    audits,
    audit,
    emailCalls,
    refreshCalls,
  };
}

const FIXED_NOW = new Date('2026-05-06T12:00:00.000Z');
const fixedNow = (): Date => FIXED_NOW;

function expiresInHours(hours: number): string {
  return new Date(FIXED_NOW.getTime() + hours * 3600 * 1000).toISOString();
}

function expiresInDays(days: number): string {
  return new Date(FIXED_NOW.getTime() + days * 24 * 3600 * 1000).toISOString();
}

test('dry-run lists refresh + warning candidates and writes no audit, calls no refresh, sends no email', async () => {
  const harness = createHarness({
    connections: [
      {
        id: '10',
        tenant_id: '1',
        provider: 'facebook',
        status: 'connected',
        token_expires_at: expiresInDays(7),
        refresh_expires_at: null,
      },
      {
        id: '11',
        tenant_id: '1',
        provider: 'linkedin',
        status: 'connected',
        token_expires_at: expiresInHours(6),
        refresh_expires_at: null,
      },
    ],
    users: [
      { id: 100, email: 'op1@example.com', organization_id: 1, role: 'tenant_admin' },
    ],
  });

  let refreshInvoked = 0;
  let emailInvoked = 0;
  const refreshFn: SweeperRefreshFn = async () => {
    refreshInvoked += 1;
    return { broker_status: 'ok', provider: 'linkedin', connection_id: '11', connection_status: 'connected', refreshed_at: '', refreshed: true, token_expires_at: null };
  };
  const emailFn: SweeperEmailFn = async () => {
    emailInvoked += 1;
  };

  const initialAudits = harness.audits.length;
  const report = await runOAuthRefreshSweep({
    dryRun: true,
    now: fixedNow,
    appBaseUrl: 'https://aries.example.com',
    client: harness.client,
    refresh: refreshFn,
    sendWarning: emailFn,
    audit: harness.audit,
  });

  assert.equal(report.dryRun, true);
  assert.equal(report.refreshCandidates.length, 1, 'linkedin within 24h');
  assert.equal(report.refreshCandidates[0].connectionId, '11');
  assert.equal(report.warningCandidates.length, 1, 'facebook within 10 days');
  assert.equal(report.warningCandidates[0].connectionId, '10');
  assert.equal(report.warningCandidates[0].operatorEmail, 'op1@example.com');
  assert.equal(report.refreshResults.length, 0, 'no refresh in dry-run');
  assert.equal(report.warningResults.length, 1);
  assert.equal(report.warningResults[0].outcome.kind, 'skipped_dry_run');
  assert.equal(refreshInvoked, 0, 'no refresh in dry-run');
  assert.equal(emailInvoked, 0, 'no email in dry-run');
  assert.equal(harness.audits.length, initialAudits, 'no audit writes in dry-run');
  assert.equal(report.errors, 0);
});

test('apply: refresh candidate triggers oauth refresh and audit on success', async () => {
  const harness = createHarness({
    connections: [
      {
        id: '20',
        tenant_id: '2',
        provider: 'linkedin',
        status: 'connected',
        token_expires_at: expiresInHours(6),
        refresh_expires_at: null,
      },
    ],
    users: [{ id: 200, email: 'op2@example.com', organization_id: 2, role: 'tenant_admin' }],
  });

  const refreshFn: SweeperRefreshFn = async (provider, tenantId) => {
    assert.equal(provider, 'linkedin');
    assert.equal(tenantId, '2');
    return {
      broker_status: 'ok',
      provider,
      connection_id: '20',
      connection_status: 'connected',
      refreshed_at: new Date().toISOString(),
      refreshed: true,
      token_expires_at: expiresInDays(7),
    };
  };
  const emailFn: SweeperEmailFn = async () => {};

  const report = await runOAuthRefreshSweep({
    dryRun: false,
    now: fixedNow,
    appBaseUrl: 'https://aries.example.com',
    client: harness.client,
    refresh: refreshFn,
    sendWarning: emailFn,
    audit: harness.audit,
  });

  assert.equal(report.refreshResults.length, 1);
  const result = report.refreshResults[0];
  assert.equal(result.outcome.kind, 'refreshed');
  if (result.outcome.kind === 'refreshed') {
    assert.match(result.outcome.tokenExpiresAt ?? '', /Z$/);
  }
  assert.equal(report.errors, 0);
  const refreshAudit = harness.audits.find((a) => a.event_type === 'oauth.refresh_sweep.refreshed');
  assert.ok(refreshAudit, 'expected oauth.refresh_sweep.refreshed audit');
  assert.equal(refreshAudit?.event_status, 'ok');
  assert.equal(refreshAudit?.connection_id, '20');
});

test('apply: refresh broker error (provider_callback_error) records reauth_required outcome and audit', async () => {
  const harness = createHarness({
    connections: [
      {
        id: '30',
        tenant_id: '3',
        provider: 'facebook',
        status: 'connected',
        token_expires_at: expiresInHours(2),
        refresh_expires_at: null,
      },
    ],
    users: [{ id: 300, email: 'op3@example.com', organization_id: 3, role: 'tenant_admin' }],
  });

  const refreshFn: SweeperRefreshFn = async () => ({
    broker_status: 'error',
    reason: 'provider_callback_error',
    provider: 'facebook',
    message: 'meta_token_expired_or_revoked',
  });
  const emailFn: SweeperEmailFn = async () => {};

  const report = await runOAuthRefreshSweep({
    dryRun: false,
    now: fixedNow,
    appBaseUrl: 'https://aries.example.com',
    client: harness.client,
    refresh: refreshFn,
    sendWarning: emailFn,
    audit: harness.audit,
  });

  assert.equal(report.refreshResults.length, 1);
  const outcome = report.refreshResults[0].outcome;
  assert.equal(outcome.kind, 'reauth_required');
  if (outcome.kind === 'reauth_required') {
    assert.match(outcome.errorMessage, /meta_token_expired_or_revoked/);
  }
  assert.equal(report.errors, 1);
  const failAudit = harness.audits.find((a) => a.event_type === 'oauth.refresh_sweep.failed');
  assert.ok(failAudit);
  assert.equal(failAudit?.event_status, 'error');
});

test('apply: day-50 warning sends email with right params and writes audit', async () => {
  const harness = createHarness({
    connections: [
      {
        id: '40',
        tenant_id: '4',
        provider: 'facebook',
        status: 'connected',
        token_expires_at: expiresInDays(5),
        refresh_expires_at: null,
      },
    ],
    users: [{ id: 400, email: 'op4@example.com', organization_id: 4, role: 'tenant_admin' }],
  });

  const emailCalls: EmailCall[] = [];
  const emailFn: SweeperEmailFn = async (params) => {
    emailCalls.push(params);
  };
  const refreshFn: SweeperRefreshFn = async () => {
    throw new Error('refresh should not be called for warning-only candidates');
  };

  const report = await runOAuthRefreshSweep({
    dryRun: false,
    now: fixedNow,
    appBaseUrl: 'https://aries.example.com',
    client: harness.client,
    refresh: refreshFn,
    sendWarning: emailFn,
    audit: harness.audit,
  });

  assert.equal(report.warningResults.length, 1);
  assert.equal(report.warningResults[0].outcome.kind, 'sent');
  assert.equal(emailCalls.length, 1);
  assert.equal(emailCalls[0].to, 'op4@example.com');
  assert.equal(emailCalls[0].reconnectUrl, 'https://aries.example.com/platforms');
  assert.ok(emailCalls[0].daysUntilExpiry >= 5 && emailCalls[0].daysUntilExpiry <= 6);
  const sentAudit = harness.audits.find((a) => a.event_type === 'oauth.reconnect_warning.sent');
  assert.ok(sentAudit, 'expected reconnect_warning.sent audit');
  assert.equal(sentAudit?.event_status, 'ok');
  assert.equal(sentAudit?.tenant_id, '4');
});

test('apply: day-50 warning is deduped per tenant when both facebook and instagram qualify', async () => {
  const harness = createHarness({
    connections: [
      {
        id: '50',
        tenant_id: '5',
        provider: 'facebook',
        status: 'connected',
        token_expires_at: expiresInDays(4),
        refresh_expires_at: null,
      },
      {
        id: '51',
        tenant_id: '5',
        provider: 'instagram',
        status: 'connected',
        token_expires_at: expiresInDays(4),
        refresh_expires_at: null,
      },
    ],
    users: [{ id: 500, email: 'op5@example.com', organization_id: 5, role: 'tenant_admin' }],
  });

  const emailCalls: EmailCall[] = [];
  const emailFn: SweeperEmailFn = async (params) => {
    emailCalls.push(params);
  };

  const report = await runOAuthRefreshSweep({
    dryRun: false,
    now: fixedNow,
    appBaseUrl: 'https://aries.example.com',
    client: harness.client,
    sendWarning: emailFn,
    refresh: async () => ({
      broker_status: 'ok',
      provider: 'facebook',
      connection_id: '50',
      connection_status: 'connected',
      refreshed_at: '',
      refreshed: true,
      token_expires_at: null,
    }),
    audit: harness.audit,
  });

  assert.equal(report.warningCandidates.length, 2);
  assert.equal(report.warningResults.length, 2);
  assert.equal(report.warningResults.filter((r) => r.outcome.kind === 'sent').length, 1);
  assert.equal(report.warningResults.filter((r) => r.outcome.kind === 'skipped_already_warned').length, 1);
  assert.equal(emailCalls.length, 1, 'only one email per tenant');
});

test('apply: warning skipped when prior audit within cooldown exists', async () => {
  const recent = new Date(FIXED_NOW.getTime() - 6 * 3600 * 1000).toISOString();
  const harness = createHarness({
    connections: [
      {
        id: '60',
        tenant_id: '6',
        provider: 'facebook',
        status: 'connected',
        token_expires_at: expiresInDays(3),
        refresh_expires_at: null,
      },
    ],
    users: [{ id: 600, email: 'op6@example.com', organization_id: 6, role: 'tenant_admin' }],
    audits: [
      {
        tenant_id: '6',
        connection_id: '60',
        provider: 'facebook',
        event_type: 'oauth.reconnect_warning.sent',
        event_status: 'ok',
        detail: {},
        occurred_at: recent,
      },
    ],
  });

  let emailInvoked = 0;
  const emailFn: SweeperEmailFn = async () => {
    emailInvoked += 1;
  };

  const report = await runOAuthRefreshSweep({
    dryRun: false,
    now: fixedNow,
    appBaseUrl: 'https://aries.example.com',
    client: harness.client,
    sendWarning: emailFn,
    refresh: async () => ({
      broker_status: 'ok',
      provider: 'facebook',
      connection_id: '60',
      connection_status: 'connected',
      refreshed_at: '',
      refreshed: true,
      token_expires_at: null,
    }),
    audit: harness.audit,
  });

  assert.equal(report.warningResults.length, 1);
  assert.equal(report.warningResults[0].outcome.kind, 'skipped_already_warned');
  assert.equal(emailInvoked, 0);
});

test('apply: warning skipped when tenant has no operator email', async () => {
  const harness = createHarness({
    connections: [
      {
        id: '70',
        tenant_id: '7',
        provider: 'facebook',
        status: 'connected',
        token_expires_at: expiresInDays(2),
        refresh_expires_at: null,
      },
    ],
    users: [],
  });

  let emailInvoked = 0;
  const emailFn: SweeperEmailFn = async () => {
    emailInvoked += 1;
  };

  const report = await runOAuthRefreshSweep({
    dryRun: false,
    now: fixedNow,
    appBaseUrl: 'https://aries.example.com',
    client: harness.client,
    sendWarning: emailFn,
    refresh: async () => ({
      broker_status: 'ok',
      provider: 'facebook',
      connection_id: '70',
      connection_status: 'connected',
      refreshed_at: '',
      refreshed: true,
      token_expires_at: null,
    }),
    audit: harness.audit,
  });

  assert.equal(report.warningResults.length, 1);
  assert.equal(report.warningResults[0].outcome.kind, 'skipped_no_email');
  assert.equal(emailInvoked, 0);
});

test('non-Meta providers do not appear in warning candidates even when within window', async () => {
  const harness = createHarness({
    connections: [
      {
        id: '80',
        tenant_id: '8',
        provider: 'linkedin',
        status: 'connected',
        token_expires_at: expiresInDays(5),
        refresh_expires_at: null,
      },
    ],
    users: [{ id: 800, email: 'op8@example.com', organization_id: 8, role: 'tenant_admin' }],
  });

  const report = await runOAuthRefreshSweep({
    dryRun: true,
    now: fixedNow,
    appBaseUrl: 'https://aries.example.com',
    client: harness.client,
    audit: harness.audit,
  });

  assert.equal(report.warningCandidates.length, 0, 'linkedin must not appear in Meta warning candidates');
});

test('tokens already expired do not appear in warning candidates (must be > now)', async () => {
  const harness = createHarness({
    connections: [
      {
        id: '90',
        tenant_id: '9',
        provider: 'facebook',
        status: 'connected',
        token_expires_at: new Date(FIXED_NOW.getTime() - 60_000).toISOString(),
        refresh_expires_at: null,
      },
    ],
    users: [{ id: 900, email: 'op9@example.com', organization_id: 9, role: 'tenant_admin' }],
  });

  const report = await runOAuthRefreshSweep({
    dryRun: true,
    now: fixedNow,
    appBaseUrl: 'https://aries.example.com',
    client: harness.client,
    audit: harness.audit,
  });

  assert.equal(report.warningCandidates.length, 0);
  assert.equal(report.refreshCandidates.length, 1, 'expired Meta token should be a refresh candidate');
});
