import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  acceptAbsorbInvitation,
  declineAbsorbInvitation,
  hashInviteToken,
} from '../../backend/tenant/workspace-invitations';

// ── Adversarial / edge coverage for Phase 0.5 absorb-orphan invite relief ─────
//
// The implementer's tests/tenant/workspace-invitations.test.ts already covers
// the happy repoint, the single-disqualifier re-check (member_count:2), wrong-
// account rejection, expired/used/pending states, idempotent already-member,
// decline-expires, and the accept-context set_password-vs-absorb split.
//
// This file adds the security-invariant edges those tests do NOT pin:
//   - the ROUTE's unauthenticated gate (token possession alone can't absorb);
//   - the in-txn orphan re-check for EACH activity/onboarding disqualifier
//     (posts / connected accounts / creative assets / onboarding progress),
//     not just a second member;
//   - a declined token cannot subsequently absorb (stateful sequence);
//   - a double-POST accept: the second attempt is already_accepted, never a
//     second repoint/move/event (stateful sequence);
//   - absorb NEVER runs an entitlement/paywall query (Decision 13c: replacement
//     not addition);
//   - the source org is left member-less and is NEVER deleted.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type Handler = (params: unknown[]) => QueryResult;

function makeFakeDb(routes: Array<[RegExp, Handler]>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const queryable = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      const lowered = sql.toLowerCase();
      for (const [pattern, handler] of routes) {
        if (pattern.test(lowered)) {
          return handler(params);
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { queryable, calls };
}

const PASSTHROUGH: Array<[RegExp, Handler]> = [
  [/^\s*begin/, () => ({ rows: [] })],
  [/^\s*commit/, () => ({ rows: [] })],
  [/^\s*rollback/, () => ({ rows: [] })],
];

const ORPHAN_PREDICATE_RE = /count\(\*\)::int from users where organization_id/;
const ACTIVE_HASH = '$2a$12$abcdefghijklmnopqrstuv';

function orphanPredicateRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    member_count: 1,
    other_membership_count: 0,
    invitee_onboarding_completed_at: null,
    has_business_profile: false,
    has_posts: false,
    has_connected_accounts: false,
    has_creative_assets: false,
    ...overrides,
  };
}

function liveInvitation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    user_id: 42,
    organization_id: 11,
    email: 'orphan@acme.com',
    role: 'tenant_analyst',
    invited_by_user_id: 3,
    expires_at: new Date(Date.now() + 60_000),
    accepted_at: null,
    ...overrides,
  };
}

function orphanUser(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    email: 'orphan@acme.com',
    organization_id: 58,
    role: 'tenant_admin',
    password_hash: ACTIVE_HASH,
    ...overrides,
  };
}

function absorbRoutes(opts: {
  invitation?: Record<string, unknown> | null;
  user?: Record<string, unknown> | null;
  predicate?: Record<string, unknown>;
} = {}) {
  const invitation = opts.invitation === undefined ? liveInvitation() : opts.invitation;
  const user = opts.user === undefined ? orphanUser() : opts.user;
  return makeFakeDb([
    [
      /from workspace_invitations\s+where token_hash/,
      () => ({ rows: invitation ? [invitation] : [], rowCount: invitation ? 1 : 0 }),
    ],
    [ORPHAN_PREDICATE_RE, () => ({ rows: [orphanPredicateRow(opts.predicate ?? {})] })],
    [/from users\s+where id = \$1\s+limit 1\s+for update/, () => ({ rows: user ? [user] : [], rowCount: user ? 1 : 0 })],
    ...PASSTHROUGH,
  ]);
}

// ── 1. In-txn orphan re-check for EVERY activity/onboarding disqualifier ──────
//
// The implementer's suite only re-checks the member_count:2 disqualifier at
// accept time. The plan (eng finding 3a) requires the FULL predicate re-run in
// the txn: a workspace that gained a post / connected account / creative asset /
// onboarding progress between invite and accept must land on workspace_in_use —
// terminal, NO repoint, NO membership move, invitation EXPIRED (not accepted).

const IN_TXN_DISQUALIFIERS: Array<[string, Record<string, unknown>]> = [
  ['gained a post', { has_posts: true }],
  ['gained a connected account', { has_connected_accounts: true }],
  ['gained a creative asset', { has_creative_assets: true }],
  ['gained a second member', { member_count: 2 }],
  ['gained a second membership row', { other_membership_count: 1 }],
  ['started onboarding (business profile)', { has_business_profile: true }],
  ['completed onboarding', { invitee_onboarding_completed_at: '2026-05-01T00:00:00.000Z' }],
];

for (const [label, predicate] of IN_TXN_DISQUALIFIERS) {
  test(`acceptAbsorbInvitation: source ${label} between invite and accept → workspace_in_use, no mutation`, async () => {
    const { queryable, calls } = absorbRoutes({ predicate });

    const result = await acceptAbsorbInvitation(queryable, {
      rawToken: 'tok',
      sessionUserId: '42',
      sessionEmail: 'orphan@acme.com',
    });
    assert.deepEqual(result, { status: 'workspace_in_use' }, label);

    // Terminal + loud: invitation EXPIRED (never accepted), and committed so a
    // later click reports a dead link rather than re-absorbing.
    const terminate = calls.find((c) => /update workspace_invitations set expires_at = now\(\) where id/i.test(c.sql));
    assert.deepEqual(terminate?.params, [7], `${label}: expected the invitation to be terminated by id`);
    assert.ok(
      !calls.some((c) => /update workspace_invitations set accepted_at/i.test(c.sql)),
      `${label}: the token must NOT be consumed as accepted`,
    );
    assert.ok(calls.some((c) => /^\s*commit/i.test(c.sql)), `${label}: the termination must commit`);

    // Absolutely no account movement: no repoint, no membership delete/upsert,
    // no absorbed event, no password write.
    assert.ok(!calls.some((c) => /update users set organization_id/i.test(c.sql)), `${label}: no repoint`);
    assert.ok(!calls.some((c) => /delete from organization_memberships/i.test(c.sql)), `${label}: no membership delete`);
    assert.ok(!calls.some((c) => /insert into organization_memberships/i.test(c.sql)), `${label}: no membership upsert`);
    assert.ok(!calls.some((c) => /organization_membership_events/i.test(c.sql)), `${label}: no absorbed event`);
    // "no password write" = no UPDATE/SET of password_hash. The users SELECT
    // legitimately READS password_hash to detect the pending sentinel, so match
    // writes only (mirrors the implementer's own /^update...password_hash/ guard).
    assert.ok(!calls.some((c) => /^\s*update[\s\S]*password_hash/i.test(c.sql)), `${label}: no password write`);
  });
}

// ── 2. Absorb NEVER runs an entitlement/paywall query (Decision 13c) ──────────
//
// Absorb REPLACES the old workspace — the account still ends at one workspace —
// so it must not trip the multi-workspace paywall that guards ADDITIVE second
// memberships. A regression that folds an entitlement count into the accept txn
// would strand orphan-relief invitees behind a 402.

test('acceptAbsorbInvitation runs no entitlement/paywall query (replacement, not addition)', async () => {
  const { queryable, calls } = absorbRoutes();

  const result = await acceptAbsorbInvitation(queryable, {
    rawToken: 'tok',
    sessionUserId: '42',
    sessionEmail: 'orphan@acme.com',
  });
  assert.equal(result.status, 'ok');

  // No plan lookup, no active-membership count, no FOR UPDATE count of the kind
  // the entitlement helper uses. The only membership rows the absorb touches are
  // its own delete + upsert.
  assert.ok(!calls.some((c) => /\bplan\b/i.test(c.sql) && /from users/i.test(c.sql)), 'no users.plan read');
  assert.ok(
    !calls.some((c) => /count\([\s\S]*\)\s+from organization_memberships/i.test(c.sql)),
    'no active-membership COUNT (entitlement gate)',
  );
});

// ── 3. Source org is left member-less, NEVER deleted ──────────────────────────

test('acceptAbsorbInvitation never deletes the source organization row', async () => {
  const { queryable, calls } = absorbRoutes();

  await acceptAbsorbInvitation(queryable, {
    rawToken: 'tok',
    sessionUserId: '42',
    sessionEmail: 'orphan@acme.com',
  });

  assert.ok(
    !calls.some((c) => /delete\s+from\s+organizations\b/i.test(c.sql)),
    'the orphan org is left member-less and invisible, never deleted (matches the May manual repoints)',
  );
});

// ── 4. Role invariant: absorbed user NEVER carries their old tenant_admin ─────
//
// The implementer pins the default tenant_analyst case. Pin the general rule:
// whatever role the ADMIN chose on the invite is written to BOTH users.role and
// the moved membership row — the source-workspace tenant_admin is never carried
// over — for a non-default admin choice too.

test('acceptAbsorbInvitation writes the admin-chosen role (not the source tenant_admin) — viewer case', async () => {
  const { queryable, calls } = absorbRoutes({
    invitation: liveInvitation({ role: 'tenant_viewer' }),
    // source workspace role is tenant_admin (orphanUser default)
  });

  const result = await acceptAbsorbInvitation(queryable, {
    rawToken: 'tok',
    sessionUserId: '42',
    sessionEmail: 'orphan@acme.com',
  });
  assert.equal(result.status, 'ok');

  const repoint = calls.find((c) => /update users set organization_id/i.test(c.sql));
  assert.deepEqual(repoint?.params, [11, 'tenant_viewer', 42], 'users.role = admin-chosen role, never tenant_admin');
  const upsert = calls.find((c) => /insert into organization_memberships/i.test(c.sql));
  assert.deepEqual(upsert?.params.slice(0, 4), [42, 11, 'tenant_viewer', 'active'], 'membership role = admin-chosen role');
  // And the audit event records the admin-chosen role, not the carried-over one.
  const event = calls.find((c) => /insert into organization_membership_events/i.test(c.sql));
  const metadata = JSON.parse(String(event?.params[3]));
  assert.equal(metadata.role, 'tenant_viewer');
});

// ── 5. No password write — the account-takeover-class regression, adapted ─────
//
// The absorb path proves control via a signed-in session, NEVER by setting a
// credential. Assert password_hash is untouched AND no bcrypt-shaped value is
// ever passed as a parameter anywhere in the absorb transaction.

test('acceptAbsorbInvitation never touches password_hash (account-takeover-class guard)', async () => {
  const { queryable, calls } = absorbRoutes();

  const result = await acceptAbsorbInvitation(queryable, {
    rawToken: 'tok',
    sessionUserId: '42',
    sessionEmail: 'orphan@acme.com',
  });
  assert.equal(result.status, 'ok');

  assert.ok(
    !calls.some((c) => /^\s*update[\s\S]*password_hash/i.test(c.sql)),
    'no UPDATE statement writes password_hash (the users SELECT reads it — that is fine)',
  );
  // Belt-and-suspenders: no freshly-minted bcrypt hash is ever a bound param.
  // (The one legitimate bcrypt string in the fake is the READ of the existing
  // account hash; it is only ever returned by the SELECT, never a write param.)
  const writeStatements = calls.filter((c) => /^\s*(update|insert)/i.test(c.sql));
  assert.ok(
    !writeStatements.some((c) => c.params.some((p) => typeof p === 'string' && /^\$2[aby]\$/.test(p))),
    'no bcrypt-shaped value is written by the absorb path',
  );
});

// ── 6. A DECLINED token cannot subsequently absorb (stateful sequence) ────────
//
// The implementer pins decline-expires. This pins the security consequence:
// after a decline, the SAME token accepted → dead link (expired), NO repoint.

function statefulInvitationDb(seed: {
  invitation: Record<string, unknown>;
  user: Record<string, unknown>;
  predicate?: Record<string, unknown>;
}) {
  // A single mutable invitation row whose expires_at / accepted_at actually
  // change when the code writes them — so a decline-then-accept (or double
  // accept) sequence observes the real terminal state, not a fresh fixture.
  const inv = { ...seed.invitation };
  const user = { ...seed.user };
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const tokenHash = hashInviteToken('tok');

  const queryable = {
    async query(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      const s = sql.toLowerCase();

      if (/^\s*(begin|commit|rollback)/.test(s)) return { rows: [] };

      if (/from workspace_invitations\s+where token_hash/.test(s)) {
        const matches = String(params[0]) === tokenHash;
        return { rows: matches ? [{ ...inv }] : [], rowCount: matches ? 1 : 0 };
      }
      if (ORPHAN_PREDICATE_RE.test(s)) {
        return { rows: [orphanPredicateRow(seed.predicate ?? {})] };
      }
      if (/from users\s+where id = \$1\s+limit 1\s+for update/.test(s)) {
        return { rows: [{ ...user }], rowCount: 1 };
      }
      // Mutating writes against the invitation row.
      if (/update workspace_invitations set expires_at = now\(\)/.test(s)) {
        // Decline / terminate: only if still live (accepted_at IS NULL).
        if (inv.accepted_at == null) inv.expires_at = new Date(Date.now() - 1000);
        return { rows: [] };
      }
      if (/update workspace_invitations set accepted_at/.test(s)) {
        if (inv.accepted_at == null) inv.accepted_at = new Date();
        return { rows: [] };
      }
      if (/update users set organization_id/.test(s)) {
        user.organization_id = params[0];
        user.role = params[1];
        return { rows: [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { queryable, calls, inv, user };
}

test('a declined absorb token cannot subsequently be accepted (dead link, no repoint)', async () => {
  const { queryable, calls, user } = statefulInvitationDb({
    invitation: liveInvitation(),
    user: orphanUser(),
  });

  const declined = await declineAbsorbInvitation(queryable, {
    rawToken: 'tok',
    sessionUserId: '42',
    sessionEmail: 'orphan@acme.com',
  });
  assert.deepEqual(declined, { status: 'ok' });

  // Now the invitee changes their mind and POSTs accept with the same token.
  const accepted = await acceptAbsorbInvitation(queryable, {
    rawToken: 'tok',
    sessionUserId: '42',
    sessionEmail: 'orphan@acme.com',
  });
  assert.deepEqual(accepted, { status: 'expired' }, 'a declined token is expired — it can never absorb');

  // The account was never repointed (still on the source org 58).
  assert.equal(user.organization_id, 58, 'no repoint happened after decline');
  assert.ok(!calls.some((c) => /update users set organization_id/i.test(c.sql)), 'no repoint SQL after decline');
});

// ── 7. Double-POST accept: the second is already_accepted, never a 2nd move ───
//
// Reloads / double-clicks / reconciler re-delivery must not repoint twice or
// write a second absorbed event. First POST → ok; second POST (same token) →
// already_accepted, with the account movement having happened exactly once.

test('double-POST absorb accept: first ok, second already_accepted, exactly one repoint', async () => {
  const { queryable, calls, user } = statefulInvitationDb({
    invitation: liveInvitation(),
    user: orphanUser(),
  });

  const first = await acceptAbsorbInvitation(queryable, {
    rawToken: 'tok',
    sessionUserId: '42',
    sessionEmail: 'orphan@acme.com',
  });
  assert.deepEqual(first, { status: 'ok', email: 'orphan@acme.com', organizationId: '11' });
  assert.equal(user.organization_id, 11, 'first accept repointed to the inviting org');

  const second = await acceptAbsorbInvitation(queryable, {
    rawToken: 'tok',
    sessionUserId: '42',
    sessionEmail: 'orphan@acme.com',
  });
  assert.deepEqual(second, { status: 'already_accepted' }, 'the consumed token cannot absorb again');

  // Exactly one repoint and one absorbed event across BOTH calls.
  assert.equal(
    calls.filter((c) => /update users set organization_id/i.test(c.sql)).length,
    1,
    'exactly one repoint across a double POST',
  );
  assert.equal(
    calls.filter((c) => /insert into organization_membership_events/i.test(c.sql)).length,
    1,
    'exactly one absorbed event across a double POST',
  );
});

// ── 8. ROUTE-level auth gate: token possession alone can't absorb ─────────────
//
// The absorb route reads the module-scoped auth()/pool at import time, and this
// repo's test runner has NO module-mock flag (see tests/tenant/
// membership-dual-write.test.ts: "grep shows zero mock.module call sites"), so
// the route handler cannot be invoked with injected auth/db. We assert the
// server-side gate STRUCTURALLY, matching that file's established convention:
// the route must require a signed-in session and reject before any pool.connect.

const ABSORB_ROUTE = readFileSync(join(REPO_ROOT, 'app/api/auth/invite/absorb/route.ts'), 'utf8');

test('absorb route requires a signed-in session (401) BEFORE any DB connection', () => {
  // It calls auth() and 401s on a missing session id.
  assert.match(ABSORB_ROUTE, /await auth\(\)/, 'route resolves a session via auth()');
  assert.match(
    ABSORB_ROUTE,
    /if\s*\(!session\?\.\s*user\?\.\s*id\)\s*\{[\s\S]*?401\s*\)/,
    'route 401s when there is no signed-in user id',
  );
  // The 401 return must appear BEFORE the first pool.connect() so an
  // unauthenticated caller never opens a DB client or reaches the domain fn.
  const authGateIdx = ABSORB_ROUTE.search(/if\s*\(!session\?\.\s*user\?\.\s*id\)/);
  const connectIdx = ABSORB_ROUTE.search(/pool\.connect\(\)/);
  assert.ok(authGateIdx > -1 && connectIdx > -1, 'both the auth gate and pool.connect must exist');
  assert.ok(authGateIdx < connectIdx, 'the session gate must run before pool.connect (no DB touch when unauth)');
});

test('absorb route forwards the session identity (never trusts the token alone) to the domain fn', () => {
  // Both accept and decline must pass sessionUserId from the resolved session —
  // never a caller-supplied identity — so the in-txn consent check is on the
  // real signed-in account. A wrong-account result maps to a 403.
  assert.match(
    ABSORB_ROUTE,
    /acceptAbsorbInvitation\(\s*client\s*,\s*\{[\s\S]*?sessionUserId:\s*session\.user\.id/,
    'accept forwards session.user.id as sessionUserId',
  );
  assert.match(
    ABSORB_ROUTE,
    /declineAbsorbInvitation\(\s*client\s*,\s*\{[\s\S]*?sessionUserId:\s*session\.user\.id/,
    'decline forwards session.user.id as sessionUserId',
  );
  assert.match(
    ABSORB_ROUTE,
    /email_mismatch[\s\S]*?403/,
    'a session that is not the invited account maps to 403 (wrong-account rejection)',
  );
});

// ── 9. Wrong-account decline is rejected server-side (403), touches nothing ───
//
// The implementer pins wrong-account for ACCEPT and for DECLINE at the domain
// level. Pin the decline route→domain contract edge the domain suite skips: a
// wrong-account DECLINE must NOT expire the token (a griefer holding a forwarded
// link must not be able to kill someone else's invitation).

test('declineAbsorbInvitation by a wrong account expires nothing', async () => {
  const invitation = liveInvitation();
  const { queryable, calls } = makeFakeDb([
    [/from workspace_invitations\s+where token_hash/, () => ({ rows: [invitation], rowCount: 1 })],
    [/update workspace_invitations set expires_at = now\(\)/, () => ({ rows: [] })],
  ]);

  const byId = await declineAbsorbInvitation(queryable, {
    rawToken: 'tok',
    sessionUserId: '99',
    sessionEmail: 'orphan@acme.com',
  });
  assert.deepEqual(byId, { status: 'email_mismatch' });
  assert.ok(!calls.some((c) => /update/i.test(c.sql)), 'a wrong-account decline must not expire the token');
});
