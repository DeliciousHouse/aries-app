const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

async function initDb() {
  const client = await pool.connect();
  try {
    console.log('Initializing database schema...');
    
    await client.query(`
      CREATE TABLE IF NOT EXISTS organizations (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        full_name TEXT,
        organization_id INTEGER REFERENCES organizations(id),
        role TEXT NOT NULL DEFAULT 'tenant_admin',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE organizations
        ADD COLUMN IF NOT EXISTS slug TEXT;

      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'tenant_admin';

      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS onboarding_required BOOLEAN NOT NULL DEFAULT FALSE;

      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

      CREATE TABLE IF NOT EXISTS early_access_signups (
        id BIGSERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        source TEXT NOT NULL DEFAULT 'website',
        user_agent TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS oauth_connections (
        id BIGSERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK (provider IN ('facebook','instagram','linkedin','x','youtube','tiktok','reddit')),
        external_account_id TEXT,
        external_account_name TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending','connected','reauthorization_required','disconnected','error')),
        granted_scopes TEXT[] NOT NULL DEFAULT '{}',
        token_expires_at TIMESTAMPTZ,
        refresh_expires_at TIMESTAMPTZ,
        connected_at TIMESTAMPTZ,
        disconnected_at TIMESTAMPTZ,
        last_error_code TEXT,
        last_error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, provider)
      );

      CREATE TABLE IF NOT EXISTS oauth_tokens (
        id BIGSERIAL PRIMARY KEY,
        connection_id BIGINT NOT NULL REFERENCES oauth_connections(id) ON DELETE CASCADE,
        access_token_enc TEXT,
        refresh_token_enc TEXT,
        token_type TEXT,
        scope TEXT,
        expires_at TIMESTAMPTZ,
        refresh_expires_at TIMESTAMPTZ,
        issued_at TIMESTAMPTZ,
        rotated_from_token_id BIGINT REFERENCES oauth_tokens(id),
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS oauth_pending_states (
        state TEXT PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        redirect_uri TEXT NOT NULL,
        scopes TEXT[] NOT NULL DEFAULT '{}',
        connection_id BIGINT REFERENCES oauth_connections(id) ON DELETE SET NULL,
        code_verifier TEXT,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      ALTER TABLE oauth_pending_states
        ADD COLUMN IF NOT EXISTS code_verifier TEXT;
      CREATE TABLE IF NOT EXISTS oauth_audit_events (
        id BIGSERIAL PRIMARY KEY,
        tenant_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
        connection_id BIGINT REFERENCES oauth_connections(id) ON DELETE SET NULL,
        provider TEXT,
        event_type TEXT NOT NULL,
        event_status TEXT NOT NULL CHECK (event_status IN ('ok','error')),
        detail JSONB NOT NULL DEFAULT '{}'::jsonb,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_oauth_connections_tenant_provider ON oauth_connections (tenant_id, provider);
      CREATE INDEX IF NOT EXISTS idx_oauth_tokens_connection_created ON oauth_tokens (connection_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_oauth_pending_states_expires ON oauth_pending_states (expires_at);
      CREATE INDEX IF NOT EXISTS idx_oauth_audit_tenant_time ON oauth_audit_events (tenant_id, occurred_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS onboarding_drafts (
        draft_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','ready_for_auth','materializing','materialized')),
        website_url TEXT NOT NULL DEFAULT '',
        business_name TEXT NOT NULL DEFAULT '',
        business_type TEXT NOT NULL DEFAULT '',
        approver_name TEXT NOT NULL DEFAULT '',
        channels TEXT[] NOT NULL DEFAULT '{}',
        goal TEXT NOT NULL DEFAULT '',
        offer TEXT NOT NULL DEFAULT '',
        competitor_url TEXT NOT NULL DEFAULT '',
        preview JSONB,
        provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
        materialized_tenant_id TEXT,
        materialized_job_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS business_profiles (
        tenant_id INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        business_name TEXT,
        tenant_slug TEXT,
        website_url TEXT,
        business_type TEXT,
        primary_goal TEXT,
        launch_approver_user_id TEXT,
        launch_approver_name TEXT,
        offer TEXT,
        brand_voice TEXT,
        style_vibe TEXT,
        notes TEXT,
        competitor_url TEXT,
        channels TEXT[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      CREATE INDEX IF NOT EXISTS idx_password_resets_email_created
        ON password_resets (email, created_at DESC);
    `);

    console.log('Database initialized successfully.');
  } catch (err) {
    console.error('Error initializing database:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

initDb();
