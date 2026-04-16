import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test, { type TestContext } from 'node:test';

import bcrypt from 'bcryptjs';

import pool from '../lib/db';

type QueryResult<T = Record<string, unknown>> = { rows: T[]; rowCount: number };
type QueryHandler = (sql: string, params?: unknown[]) => Promise<QueryResult> | QueryResult;

function installDbMock(t: TestContext, handler: QueryHandler): void {
  const fakeClient = {
    query: async (sql: string, params?: unknown[]) => handler(String(sql), params ?? []),
    release: () => {},
  };
  t.mock.method(pool, 'connect', async () => fakeClient as unknown as Awaited<ReturnType<typeof pool.connect>>);
  t.mock.method(pool, 'query', (async (sql: string, params?: unknown[]) =>
    handler(String(sql), params ?? [])) as typeof pool.query);
}

function installEmailHook(t: TestContext): Array<{ email: string; code: string }> {
  const calls: Array<{ email: string; code: string }> = [];
  (globalThis as Record<string, unknown>).__ARIES_EMAIL_TEST_HOOK__ = (email: string, code: string) => {
    calls.push({ email, code });
  };
  t.after(() => {
    delete (globalThis as Record<string, unknown>).__ARIES_EMAIL_TEST_HOOK__;
  });
  return calls;
}

type PasswordResetRow = {
  id: number;
  user_id: number;
  email: string;
  code_hash: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
};

type UserRow = {
  id: number;
  email: string;
  password_hash: string;
};

function createState(options: {
  users?: UserRow[];
  resets?: PasswordResetRow[];
} = {}) {
  const users: UserRow[] = options.users ?? [];
  const resets: PasswordResetRow[] = options.resets ?? [];
  let nextResetId = resets.reduce((max, row) => Math.max(max, row.id), 0) + 1;
  let transactionDepth = 0;

  const handler: QueryHandler = async (sql, params = []) => {
    const text = sql.trim();

    if (text === 'BEGIN') {
      transactionDepth += 1;
      return { rows: [], rowCount: 0 };
    }
    if (text === 'COMMIT' || text === 'ROLLBACK') {
      transactionDepth = Math.max(0, transactionDepth - 1);
      return { rows: [], rowCount: 0 };
    }

    if (text.includes('FROM users') && text.includes('LOWER(email)')) {
      const email = String(params[0] ?? '').toLowerCase();
      const user = users.find((row) => row.email.toLowerCase() === email);
      return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
    }

    if (text.includes('COUNT(*)') && text.includes('password_resets')) {
      const email = String(params[0] ?? '');
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;
      const count = resets.filter(
        (row) => row.email === email && row.created_at.getTime() > oneHourAgo,
      ).length;
      return { rows: [{ count }], rowCount: 1 };
    }

    if (text.startsWith('INSERT INTO password_resets')) {
      const [userId, email, codeHash] = params as [number, string, string];
      const row: PasswordResetRow = {
        id: nextResetId++,
        user_id: userId,
        email,
        code_hash: codeHash,
        expires_at: new Date(Date.now() + 15 * 60 * 1000),
        used_at: null,
        created_at: new Date(),
      };
      resets.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (text.startsWith('SELECT id, user_id, code_hash')) {
      const email = String(params[0] ?? '');
      const now = Date.now();
      const rows = resets
        .filter((row) => row.email === email && row.used_at === null && row.expires_at.getTime() > now)
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
        .slice(0, 5)
        .map((row) => ({ id: row.id, user_id: row.user_id, code_hash: row.code_hash }));
      return { rows, rowCount: rows.length };
    }

    if (text.startsWith('UPDATE users SET password_hash')) {
      const [passwordHash, userId] = params as [string, number];
      const user = users.find((row) => row.id === userId);
      if (user) user.password_hash = passwordHash;
      return { rows: [], rowCount: user ? 1 : 0 };
    }

    if (text.startsWith('UPDATE password_resets SET used_at = now() WHERE id =')) {
      const id = Number(params[0]);
      const row = resets.find((r) => r.id === id);
      if (row) row.used_at = new Date();
      return { rows: [], rowCount: row ? 1 : 0 };
    }

    if (text.startsWith('UPDATE password_resets SET used_at = now() WHERE email')) {
      const email = String(params[0] ?? '');
      let count = 0;
      for (const row of resets) {
        if (row.email === email && row.used_at === null) {
          row.used_at = new Date();
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    throw new Error(`Unhandled SQL in password-reset test harness: ${text}`);
  };

  return { users, resets, handler };
}

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('forgot-password: valid email sends a 6-digit code and returns success', async (t) => {
  const state = createState({
    users: [{ id: 42, email: 'user@example.com', password_hash: '$2a$12$abcdef' }],
  });
  installDbMock(t, state.handler);
  const emailCalls = installEmailHook(t);

  const route = await import('../app/api/auth/forgot-password/route');
  const response = await route.POST(
    jsonRequest('http://localhost/api/auth/forgot-password', { email: 'User@Example.com' }),
  );
  const body = (await response.json()) as { success: boolean };

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(emailCalls.length, 1);
  assert.equal(emailCalls[0].email, 'user@example.com');
  assert.match(emailCalls[0].code, /^\d{6}$/);
  assert.equal(state.resets.length, 1);
  assert.equal(state.resets[0].code_hash, hashCode(emailCalls[0].code));
});

test('forgot-password: unknown email returns success without sending email', async (t) => {
  const state = createState({ users: [] });
  installDbMock(t, state.handler);
  const emailCalls = installEmailHook(t);

  const route = await import('../app/api/auth/forgot-password/route');
  const response = await route.POST(
    jsonRequest('http://localhost/api/auth/forgot-password', { email: 'missing@example.com' }),
  );
  const body = (await response.json()) as { success: boolean };

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(emailCalls.length, 0);
  assert.equal(state.resets.length, 0);
});

test('forgot-password: OAuth-managed account returns success without sending email', async (t) => {
  const state = createState({
    users: [{ id: 9, email: 'oauth@example.com', password_hash: 'oauth_managed' }],
  });
  installDbMock(t, state.handler);
  const emailCalls = installEmailHook(t);

  const route = await import('../app/api/auth/forgot-password/route');
  const response = await route.POST(
    jsonRequest('http://localhost/api/auth/forgot-password', { email: 'oauth@example.com' }),
  );
  const body = (await response.json()) as { success: boolean };

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(emailCalls.length, 0);
});

test('forgot-password: 4th request within an hour is rate-limited silently', async (t) => {
  const now = Date.now();
  const email = 'rate@example.com';
  const state = createState({
    users: [{ id: 7, email, password_hash: '$2a$12$abcdef' }],
    resets: [1, 2, 3].map((i) => ({
      id: i,
      user_id: 7,
      email,
      code_hash: hashCode(String(100000 + i)),
      expires_at: new Date(now + 15 * 60 * 1000),
      used_at: null,
      created_at: new Date(now - i * 60 * 1000),
    })),
  });
  installDbMock(t, state.handler);
  const emailCalls = installEmailHook(t);

  const route = await import('../app/api/auth/forgot-password/route');
  const response = await route.POST(
    jsonRequest('http://localhost/api/auth/forgot-password', { email }),
  );
  const body = (await response.json()) as { success: boolean };

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(emailCalls.length, 0, 'rate-limited requests must not trigger email send');
  assert.equal(state.resets.length, 3, 'no new password_resets row should be inserted');
});

test('reset-password: correct code updates password, marks code used, and invalidates siblings', async (t) => {
  const code = '654321';
  const email = 'reset@example.com';
  const originalHash = '$2a$12$OLDHASHVALUEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
  const state = createState({
    users: [{ id: 55, email, password_hash: originalHash }],
    resets: [
      {
        id: 1,
        user_id: 55,
        email,
        code_hash: hashCode(code),
        expires_at: new Date(Date.now() + 10 * 60 * 1000),
        used_at: null,
        created_at: new Date(),
      },
      {
        id: 2,
        user_id: 55,
        email,
        code_hash: hashCode('111111'),
        expires_at: new Date(Date.now() + 10 * 60 * 1000),
        used_at: null,
        created_at: new Date(Date.now() - 1000),
      },
    ],
  });
  installDbMock(t, state.handler);

  const route = await import('../app/api/auth/reset-password/route');
  const response = await route.POST(
    jsonRequest('http://localhost/api/auth/reset-password', {
      email,
      code,
      password: 'NewPass!1',
    }),
  );
  const body = (await response.json()) as { success?: boolean; error?: string };

  assert.equal(response.status, 200, `expected 200 got ${response.status} (${body.error})`);
  assert.equal(body.success, true);
  const user = state.users.find((row) => row.id === 55)!;
  assert.notEqual(user.password_hash, originalHash, 'password_hash should be updated');
  assert.ok(await bcrypt.compare('NewPass!1', user.password_hash), 'new password should verify');
  for (const row of state.resets) {
    assert.ok(row.used_at instanceof Date, `reset row ${row.id} should be marked used`);
  }
});

test('reset-password: wrong code returns 400 and leaves password untouched', async (t) => {
  const email = 'wrong@example.com';
  const originalHash = '$2a$12$ORIGINALHASHVALUEYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY';
  const state = createState({
    users: [{ id: 77, email, password_hash: originalHash }],
    resets: [
      {
        id: 1,
        user_id: 77,
        email,
        code_hash: hashCode('222222'),
        expires_at: new Date(Date.now() + 10 * 60 * 1000),
        used_at: null,
        created_at: new Date(),
      },
    ],
  });
  installDbMock(t, state.handler);

  const route = await import('../app/api/auth/reset-password/route');
  const response = await route.POST(
    jsonRequest('http://localhost/api/auth/reset-password', {
      email,
      code: '999999',
      password: 'NewPass!1',
    }),
  );
  const body = (await response.json()) as { error?: string };

  assert.equal(response.status, 400);
  assert.match(body.error ?? '', /invalid or expired/i);
  const user = state.users.find((row) => row.id === 77)!;
  assert.equal(user.password_hash, originalHash, 'password_hash must not change on bad code');
  assert.equal(state.resets[0].used_at, null, 'code must not be marked used on mismatch');
});

test('reset-password: expired code returns 400', async (t) => {
  const code = '333333';
  const email = 'expired@example.com';
  const state = createState({
    users: [{ id: 81, email, password_hash: '$2a$12$SOMETHING' }],
    resets: [
      {
        id: 1,
        user_id: 81,
        email,
        code_hash: hashCode(code),
        expires_at: new Date(Date.now() - 60 * 1000),
        used_at: null,
        created_at: new Date(Date.now() - 20 * 60 * 1000),
      },
    ],
  });
  installDbMock(t, state.handler);

  const route = await import('../app/api/auth/reset-password/route');
  const response = await route.POST(
    jsonRequest('http://localhost/api/auth/reset-password', {
      email,
      code,
      password: 'NewPass!1',
    }),
  );
  const body = (await response.json()) as { error?: string };

  assert.equal(response.status, 400);
  assert.match(body.error ?? '', /invalid or expired/i);
});

test('reset-password: already-used code returns 400', async (t) => {
  const code = '444444';
  const email = 'used@example.com';
  const state = createState({
    users: [{ id: 91, email, password_hash: '$2a$12$SOMETHING' }],
    resets: [
      {
        id: 1,
        user_id: 91,
        email,
        code_hash: hashCode(code),
        expires_at: new Date(Date.now() + 10 * 60 * 1000),
        used_at: new Date(),
        created_at: new Date(),
      },
    ],
  });
  installDbMock(t, state.handler);

  const route = await import('../app/api/auth/reset-password/route');
  const response = await route.POST(
    jsonRequest('http://localhost/api/auth/reset-password', {
      email,
      code,
      password: 'NewPass!1',
    }),
  );
  const body = (await response.json()) as { error?: string };

  assert.equal(response.status, 400);
  assert.match(body.error ?? '', /invalid or expired/i);
});
