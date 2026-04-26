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
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      CREATE TABLE IF NOT EXISTS creative_assets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL CHECK (source_type IN ('owned_instagram','owned_facebook','owned_meta_ad','competitor_meta_ad','manual_upload','generated_by_aries','runtime_artifact','landing_page_screenshot')),
        permission_scope TEXT NOT NULL CHECK (permission_scope IN ('owned','public_ad_library','user_uploaded','generated','licensed')),
        media_type TEXT NOT NULL CHECK (media_type IN ('image','video','carousel','landing_page','script','prompt')),
        source_job_id TEXT,
        source_asset_id TEXT,
        served_asset_ref TEXT,
        storage_kind TEXT NOT NULL DEFAULT 'none' CHECK (storage_kind IN ('runtime_asset','ingested_asset','external_url','none')),
        storage_key TEXT,
        exact_image_text TEXT[] NOT NULL DEFAULT '{}',
        aspect_ratio TEXT,
        checksum TEXT,
        usable_for_generation BOOLEAN NOT NULL DEFAULT FALSE,
        learning_lifecycle TEXT NOT NULL DEFAULT 'observed' CHECK (learning_lifecycle IN ('observed','analyzed','suggested','approved_for_generation','archived')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        CONSTRAINT creative_assets_exact_image_text_generation_check CHECK (media_type <> 'image' OR usable_for_generation = FALSE OR learning_lifecycle <> 'approved_for_generation' OR array_length(exact_image_text, 1) IS NOT NULL),
        CONSTRAINT creative_assets_competitor_not_usable_check CHECK ((source_type <> 'competitor_meta_ad' AND permission_scope <> 'public_ad_library') OR usable_for_generation = FALSE)
      );

      CREATE TABLE IF NOT EXISTS creative_analyses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        creative_asset_id UUID NOT NULL,
        hook_type TEXT,
        visual_style_tags TEXT[] NOT NULL DEFAULT '{}',
        copy_style_tags TEXT[] NOT NULL DEFAULT '{}',
        strengths TEXT[] NOT NULL DEFAULT '{}',
        weaknesses TEXT[] NOT NULL DEFAULT '{}',
        model_used TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, creative_asset_id) REFERENCES creative_assets(tenant_id, id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS style_cards (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        visual_dna TEXT NOT NULL DEFAULT '',
        copy_dna TEXT NOT NULL DEFAULT '',
        prompt_guidance TEXT NOT NULL DEFAULT '',
        negative_guidance TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','archived')),
        confidence_score NUMERIC NOT NULL DEFAULT 0,
        performance_score NUMERIC NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id)
      );

      CREATE TABLE IF NOT EXISTS style_card_examples (
        tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        style_card_id UUID NOT NULL,
        creative_asset_id UUID NOT NULL,
        role TEXT NOT NULL DEFAULT 'example' CHECK (role IN ('example','positive','negative','source')),
        sort_order INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, style_card_id, creative_asset_id),
        FOREIGN KEY (tenant_id, style_card_id) REFERENCES style_cards(tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, creative_asset_id) REFERENCES creative_assets(tenant_id, id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS style_card_source_analyses (
        tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        style_card_id UUID NOT NULL,
        creative_analysis_id UUID NOT NULL,
        PRIMARY KEY (tenant_id, style_card_id, creative_analysis_id),
        FOREIGN KEY (tenant_id, style_card_id) REFERENCES style_cards(tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, creative_analysis_id) REFERENCES creative_analyses(tenant_id, id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS market_pattern_notes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        source_label TEXT NOT NULL,
        pattern TEXT NOT NULL,
        allowed_use TEXT NOT NULL DEFAULT 'abstract_only' CHECK (allowed_use = 'abstract_only'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id)
      );

      CREATE TABLE IF NOT EXISTS prompt_recipes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        marketing_job_id TEXT,
        brief JSONB NOT NULL DEFAULT '{}'::jsonb,
        context_pack JSONB NOT NULL DEFAULT '{}'::jsonb,
        compiled_prompt TEXT NOT NULL,
        negative_prompt TEXT NOT NULL DEFAULT '',
        model_used TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id)
      );

      CREATE TABLE IF NOT EXISTS prompt_recipe_assets (
        tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        prompt_recipe_id UUID NOT NULL,
        creative_asset_id UUID NOT NULL,
        selection_role TEXT NOT NULL DEFAULT 'example',
        selection_reason TEXT NOT NULL DEFAULT '',
        rank INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, prompt_recipe_id, creative_asset_id),
        FOREIGN KEY (tenant_id, prompt_recipe_id) REFERENCES prompt_recipes(tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, creative_asset_id) REFERENCES creative_assets(tenant_id, id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS prompt_recipe_style_cards (
        tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        prompt_recipe_id UUID NOT NULL,
        style_card_id UUID NOT NULL,
        selection_reason TEXT NOT NULL DEFAULT '',
        rank INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, prompt_recipe_id, style_card_id),
        FOREIGN KEY (tenant_id, prompt_recipe_id) REFERENCES prompt_recipes(tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, style_card_id) REFERENCES style_cards(tenant_id, id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS generated_assets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        prompt_recipe_id UUID NOT NULL,
        creative_asset_id UUID,
        variant_kind TEXT NOT NULL DEFAULT 'memory_assisted' CHECK (variant_kind IN ('baseline','memory_assisted')),
        prompt_text TEXT NOT NULL DEFAULT '',
        learning_lifecycle TEXT NOT NULL DEFAULT 'suggested' CHECK (learning_lifecycle IN ('observed','analyzed','suggested','approved_for_generation','archived')),
        review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved','rejected','changes_requested')),
        review_notes JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, id),
        FOREIGN KEY (tenant_id, prompt_recipe_id) REFERENCES prompt_recipes(tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, creative_asset_id) REFERENCES creative_assets(tenant_id, id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS campaign_learning_labels (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        label TEXT NOT NULL CHECK (label IN ('useful','not_useful','winner','loser','used_in_campaign','needs_changes','approved','rejected')),
        prompt_recipe_id UUID,
        generated_asset_id UUID,
        note TEXT,
        source TEXT NOT NULL DEFAULT 'operator',
        confidence_basis TEXT NOT NULL DEFAULT 'manual_label' CHECK (confidence_basis IN ('manual_label','review_decision','performance_result')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (prompt_recipe_id IS NOT NULL OR generated_asset_id IS NOT NULL),
        UNIQUE (tenant_id, id),
        UNIQUE (tenant_id, idempotency_key),
        FOREIGN KEY (tenant_id, prompt_recipe_id) REFERENCES prompt_recipes(tenant_id, id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id, generated_asset_id) REFERENCES generated_assets(tenant_id, id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_creative_assets_tenant_status ON creative_assets (tenant_id, learning_lifecycle, usable_for_generation);
      CREATE INDEX IF NOT EXISTS idx_creative_assets_tenant_source ON creative_assets (tenant_id, source_type, permission_scope);
      CREATE INDEX IF NOT EXISTS idx_creative_assets_tenant_media ON creative_assets (tenant_id, media_type, aspect_ratio);
      CREATE INDEX IF NOT EXISTS idx_creative_assets_tenant_checksum ON creative_assets (tenant_id, checksum);
      CREATE INDEX IF NOT EXISTS idx_style_cards_tenant_status ON style_cards (tenant_id, status);
      CREATE INDEX IF NOT EXISTS idx_prompt_recipes_tenant_job ON prompt_recipes (tenant_id, marketing_job_id);
      CREATE INDEX IF NOT EXISTS idx_generated_assets_tenant_recipe ON generated_assets (tenant_id, prompt_recipe_id);
      CREATE INDEX IF NOT EXISTS idx_campaign_learning_labels_tenant_label_created ON campaign_learning_labels (tenant_id, label, created_at DESC);

      ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS source_job_id TEXT;
      ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS source_asset_id TEXT;
      ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS served_asset_ref TEXT;
      ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS storage_kind TEXT NOT NULL DEFAULT 'none';
      ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS storage_key TEXT;
      ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS exact_image_text TEXT[] NOT NULL DEFAULT '{}';
      ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS usable_for_generation BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS learning_lifecycle TEXT NOT NULL DEFAULT 'observed';
      ALTER TABLE prompt_recipes ADD COLUMN IF NOT EXISTS context_pack JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE generated_assets ADD COLUMN IF NOT EXISTS creative_asset_id UUID;
      ALTER TABLE generated_assets ADD COLUMN IF NOT EXISTS variant_kind TEXT NOT NULL DEFAULT 'memory_assisted';
      ALTER TABLE generated_assets ADD COLUMN IF NOT EXISTS prompt_text TEXT NOT NULL DEFAULT '';
      ALTER TABLE creative_assets DROP CONSTRAINT IF EXISTS creative_assets_source_type_check;
      ALTER TABLE creative_assets ADD CONSTRAINT creative_assets_source_type_check CHECK (source_type IN ('owned_instagram','owned_facebook','owned_meta_ad','competitor_meta_ad','manual_upload','generated_by_aries','runtime_artifact','landing_page_screenshot'));
      ALTER TABLE creative_assets DROP CONSTRAINT IF EXISTS creative_assets_permission_scope_check;
      ALTER TABLE creative_assets ADD CONSTRAINT creative_assets_permission_scope_check CHECK (permission_scope IN ('owned','public_ad_library','user_uploaded','generated','licensed'));
      ALTER TABLE creative_assets DROP CONSTRAINT IF EXISTS creative_assets_exact_image_text_generation_check;
      ALTER TABLE creative_assets ADD CONSTRAINT creative_assets_exact_image_text_generation_check CHECK (media_type <> 'image' OR usable_for_generation = FALSE OR learning_lifecycle <> 'approved_for_generation' OR array_length(exact_image_text, 1) IS NOT NULL);
      ALTER TABLE creative_assets DROP CONSTRAINT IF EXISTS creative_assets_competitor_not_usable_check;
      ALTER TABLE creative_assets ADD CONSTRAINT creative_assets_competitor_not_usable_check CHECK ((source_type <> 'competitor_meta_ad' AND permission_scope <> 'public_ad_library') OR usable_for_generation = FALSE);
      ALTER TABLE campaign_learning_labels DROP CONSTRAINT IF EXISTS campaign_learning_labels_label_check;
      ALTER TABLE campaign_learning_labels ADD CONSTRAINT campaign_learning_labels_label_check CHECK (label IN ('useful','not_useful','winner','loser','used_in_campaign','needs_changes','approved','rejected'));
      CREATE UNIQUE INDEX IF NOT EXISTS idx_creative_assets_tenant_checksum_unique ON creative_assets (tenant_id, checksum) WHERE checksum IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_style_cards_tenant_name_unique ON style_cards (tenant_id, name);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_market_pattern_notes_natural_unique ON market_pattern_notes (tenant_id, source_label, pattern);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        attempts INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Add attempts column to existing deployments that predate brute-force
      -- protection. ADD COLUMN IF NOT EXISTS is a no-op when the column
      -- already exists, so this is safe to re-run.
      ALTER TABLE password_resets
        ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;

      CREATE INDEX IF NOT EXISTS idx_password_resets_email_created
        ON password_resets (email, created_at DESC);
    `);

    console.log('Database initialized successfully.');
  } catch (err) {
    console.error('Error initializing database:', err);
    process.exitCode = 1;
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

initDb();
