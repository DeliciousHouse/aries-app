"use server";

import { cookies } from 'next/headers';
import bcrypt from 'bcryptjs';

import { enqueuePartnerAttribution } from '@/backend/partners/outbox';
import { ensureUserJourneySchema } from '@/lib/auth-user-journey';
import { normalizeEmail, upsertOrganizationMembership } from '@/lib/auth-tenant-membership';
import pool from '@/lib/db';
import { partnerAttributionEnabled } from '@/lib/partner-attribution-env';
import { PARTNER_REF_COOKIE_NAME, parsePartnerRefCookie } from '@/lib/partner-ref-cookie';

export async function userExists(email: string): Promise<boolean> {
  const client = await pool.connect();

  try {
    await ensureUserJourneySchema(client);
    const result = await client.query(
      'SELECT 1 FROM users WHERE email = $1 LIMIT 1',
      [email]
    );

    return (result.rowCount ?? 0) > 0;
  } finally {
    client.release();
  }
}

export async function registerUserAction(formData: any) {
  const { email: rawEmail, password, fullName, orgName } = formData;

  // Normalize email on write (Eng finding 7): every lookup uses LOWER(email) and
  // the new lowercase-unique index is load-bearing under multi-membership, so
  // signup must persist the normalized form rather than whatever case was typed.
  const email = typeof rawEmail === 'string' ? normalizeEmail(rawEmail) : rawEmail;

  const cookieStore = await cookies();
  const rawRef = cookieStore.get(PARTNER_REF_COOKIE_NAME)?.value;
  const partnerRef = rawRef ? parsePartnerRefCookie(rawRef) : null;

  let client;
  try {
    client = await pool.connect();
    await ensureUserJourneySchema(client);

    const existingUser = await client.query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (existingUser.rowCount && existingUser.rowCount > 0) {
      return { success: false, error: 'User already exists' };
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await client.query('BEGIN');
    try {
      let orgId = null;
      if (orgName) {
        const orgResult = await client.query(
          'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
          [orgName]
        );
        orgId = orgResult.rows[0].id;
      }

      const userResult = await client.query(
        `
        INSERT INTO users (
          email,
          password_hash,
          full_name,
          organization_id,
          onboarding_required,
          onboarding_completed_at
        )
        VALUES ($1, $2, $3, $4, TRUE, NULL)
        RETURNING id
      `,
        [email, hashedPassword, fullName, orgId]
      );

      const userId = String(userResult.rows[0].id);

      // Dual-write the membership row (multi-workspace Phase 0, Eng finding 1a).
      // A credentials signup that creates an org lands as its tenant_admin
      // (users.role DEFAULT 'tenant_admin' — this INSERT never sets role). No org
      // (orgId null) means no membership yet; the sign-in auto-provision path
      // creates one when a workspace is minted. Additive — nothing reads it yet.
      if (orgId !== null) {
        await upsertOrganizationMembership(client, {
          userId,
          organizationId: orgId,
          role: 'tenant_admin',
          status: 'active',
        });
      }

      const emailDomain = typeof email === 'string' && email.includes('@') ? email.split('@')[1] : null;

      if (partnerRef && partnerAttributionEnabled()) {
        await enqueuePartnerAttribution(client, {
          userId,
          refCode: partnerRef,
          name: typeof fullName === 'string' ? fullName : '',
          email,
          company: typeof orgName === 'string' && orgName.trim() ? orgName.trim() : null,
          domain: emailDomain,
        });
      }

      await client.query('COMMIT');

      // Always consume the cookie when a valid ref was parsed and a user
      // was created — independent of whether the outbox row got written.
      // The cookie is single-use intent; persisting it would let a second
      // signup from the same browser silently re-attribute to a stale ref.
      if (partnerRef) {
        cookieStore.delete(PARTNER_REF_COOKIE_NAME);
      }

      return { success: true, userId };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } catch (err: any) {
    console.error('Registration error:', err);
    return { success: false, error: err.message || 'Registration failed' };
  } finally {
    if (client) client.release();
  }
}
