/**
 * Give an existing Aries account a usable password so headless QA can sign in
 * through the normal Credentials provider.
 *
 * Context
 * -------
 * socialmedia@sugarandleather.com was created via Google SSO, so auth.ts stored
 * the sentinel string 'oauth_managed' in password_hash. Two consequences:
 *   - the Credentials provider throws GoogleSignInRequiredCredentialsError for
 *     it BEFORE bcrypt.compare ever runs (auth.ts ~line 104), and
 *   - app/api/auth/forgot-password deliberately returns success WITHOUT sending
 *     an email for oauth_managed rows (there is a test asserting this).
 * So there is no in-product way to give this account a password. It has to be
 * done here, against the database, once.
 *
 * This does NOT break Google sign-in. The Google branch of the signIn callback
 * only checks whether the user row exists; it never reads password_hash. After
 * this runs the account has two working doors: Brendan keeps clicking
 * "Continue with Google", the QA bot posts a password headlessly.
 *
 * Safety
 * ------
 *   - Refuses to overwrite a real bcrypt hash ($2...) unless FORCE=1, so it can
 *     never silently clobber a human's password.
 *   - Never prints the password, and never echoes the resulting hash.
 *   - Idempotent: re-running just re-hashes the same secret.
 *
 * Usage (on the host that has the DB_* env, i.e. the deploy host):
 *   ARIES_QA_EMAIL=socialmedia@sugarandleather.com \
 *   ARIES_QA_PASSWORD='<the secret>' \
 *   npx tsx scripts/qa/set-qa-password.ts
 */
import 'dotenv/config';

import bcrypt from 'bcryptjs';
import pg from 'pg';

const OVERWRITABLE_SENTINELS = new Set(['oauth_managed', 'invited_pending']);

async function main(): Promise<void> {
  const email = (process.env.ARIES_QA_EMAIL || '').trim().toLowerCase();
  const password = process.env.ARIES_QA_PASSWORD || '';

  if (!email || !password) {
    throw new Error('ARIES_QA_EMAIL and ARIES_QA_PASSWORD must both be set');
  }
  if (password.length < 16) {
    throw new Error('refusing a password shorter than 16 characters for an automated account');
  }

  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER || 'aries_user',
    password: process.env.DB_PASSWORD || 'aries_pass',
    database: process.env.DB_NAME || 'aries_dev',
    max: 1,
  });

  try {
    const found = await pool.query<{ id: number; password_hash: string | null }>(
      'SELECT id, password_hash FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
      [email],
    );

    if (found.rowCount === 0) {
      throw new Error(
        `no user row for ${email} - this script converts an EXISTING account, it does not create one`,
      );
    }

    const { id, password_hash: current } = found.rows[0];
    const currentKind = !current
      ? 'null'
      : OVERWRITABLE_SENTINELS.has(current)
        ? current
        : current.startsWith('$2')
          ? 'real-bcrypt-hash'
          : 'unrecognized';

    if (currentKind === 'real-bcrypt-hash' && process.env.FORCE !== '1') {
      throw new Error(
        `${email} already has a real password set. Refusing to overwrite it. ` +
          'Re-run with FORCE=1 only if you are certain.',
      );
    }

    const hash = await bcrypt.hash(password, 12);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, id]);

    // Read back and verify against the plaintext we were handed, so a silent
    // write failure or a column-length truncation cannot be reported as success.
    const after = await pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [id],
    );
    const verified = await bcrypt.compare(password, after.rows[0].password_hash);

    console.log(
      JSON.stringify({
        ok: verified,
        email,
        userId: id,
        previous_state: currentKind,
        verified_by_bcrypt_compare: verified,
        google_sign_in_still_works: true,
        note: 'password not logged; Google branch of signIn never reads password_hash',
      }),
    );

    if (!verified) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

void main().catch((error) => {
  console.error('[set-qa-password] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
