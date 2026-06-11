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

      ALTER TABLE organizations
        ADD COLUMN IF NOT EXISTS onboarding_memory_seeded_at TIMESTAMPTZ;

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
        provider TEXT NOT NULL CHECK (provider IN ('facebook','instagram','linkedin','x','youtube','tiktok','reddit','slack')),
        external_account_id TEXT,
        external_account_name TEXT,
        -- Per-tenant Slack notification target (Phase 4 Option A): the channel the
        -- bot posts approval notifications to for this tenant. NULL for non-Slack
        -- providers and for a Slack connection before the operator picks a channel.
        notify_channel_id TEXT,
        notify_channel_name TEXT,
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
      ALTER TABLE oauth_pending_states
        ADD COLUMN IF NOT EXISTS picker_payload JSONB;

      -- Per-tenant Slack (Phase 4 Option A), applied to EXISTING databases:
      -- widen the provider CHECK to allow 'slack' and add the notify-channel
      -- columns. Idempotent: DROP IF EXISTS + re-ADD the constraint, ADD COLUMN
      -- IF NOT EXISTS. No 'slack' rows can pre-exist (the old CHECK blocked them),
      -- so re-adding the constraint never fails on existing data.
      ALTER TABLE oauth_connections
        DROP CONSTRAINT IF EXISTS oauth_connections_provider_check;
      ALTER TABLE oauth_connections
        ADD CONSTRAINT oauth_connections_provider_check
        CHECK (provider IN ('facebook','instagram','linkedin','x','youtube','tiktok','reddit','slack'));
      ALTER TABLE oauth_connections
        ADD COLUMN IF NOT EXISTS notify_channel_id TEXT;
      ALTER TABLE oauth_connections
        ADD COLUMN IF NOT EXISTS notify_channel_name TEXT;
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

    // connected_accounts — end-user social/ad connections established through the
    // optional Composio integration layer (backend/integrations/composio).
    // SECURITY: this table intentionally has NO access/refresh-token column. It
    // persists the Composio connected_account_id (a pointer to the credential
    // Composio holds) and the auth_config_id, never the raw OAuth secret itself.
    await client.query(`
      CREATE TABLE IF NOT EXISTS connected_accounts (
        id BIGSERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        external_user_id TEXT NOT NULL,
        platform TEXT NOT NULL CHECK (platform IN ('facebook','instagram','meta_ads','tiktok','youtube','linkedin','reddit')),
        provider TEXT NOT NULL DEFAULT 'composio' CHECK (provider IN ('composio','direct_meta','none')),
        connected_account_id TEXT,
        auth_config_id TEXT,
        external_account_id TEXT,
        external_account_name TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('not_connected','pending','connected','reauthorization_required','error')),
        capabilities_json JSONB,
        last_capability_check_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, platform)
      );

      CREATE INDEX IF NOT EXISTS idx_connected_accounts_tenant ON connected_accounts (tenant_id);
      CREATE INDEX IF NOT EXISTS idx_connected_accounts_tenant_platform ON connected_accounts (tenant_id, platform);
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

      -- A4: per-tenant business timezone (IANA string, e.g. America/New_York).
      -- The calendar planner grid, schedule input conversion, and every
      -- timestamp label render and convert in this one zone. Nullable; an
      -- unset value falls back to the fixed default in lib/format-timestamp.ts.
      ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS timezone TEXT;
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
        variant_batch_id TEXT,
        variant_index INTEGER,
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
      ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS variant_batch_id TEXT;
      ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS variant_index INTEGER;
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
      CREATE INDEX IF NOT EXISTS idx_creative_assets_variant_batch ON creative_assets (tenant_id, variant_batch_id) WHERE variant_batch_id IS NOT NULL;
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

    await client.query(`
      -- Posts table columns for weekly social content.
      -- NOTE: 'caption' is the canonical post-body column. Prod's posts table
      -- has 'caption' (NOT NULL) and no 'content' column; init-db.js previously
      -- declared 'content' and drifted from prod. The drift origin is unknown
      -- (no .sql migration performs a content->caption rename). 'caption' is
      -- authoritative — keep all call sites on it.
      CREATE TABLE IF NOT EXISTS posts (
        id BIGSERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        caption TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      ALTER TABLE posts
        ADD COLUMN IF NOT EXISTS platform_post_id TEXT;

      ALTER TABLE posts
        ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

      ALTER TABLE posts
        ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;

      ALTER TABLE posts
        ADD COLUMN IF NOT EXISTS published_status TEXT DEFAULT 'draft' CHECK (published_status IN ('draft','in_review','approved','scheduled','publishing','published','failed','rolled_back'));

      ALTER TABLE posts
        DROP CONSTRAINT IF EXISTS posts_published_status_check;

      -- 'expired' is the terminal state the draft-expiry sweep
      -- (scripts/automations/draft-expiry-sweep-worker.ts) writes to a stranded
      -- pre-publish post: one that never reached the publish queue and is older
      -- than the age window. It removes the post from the approval/backlog trays
      -- without publishing it (stale content must not go out late). DROP + ADD
      -- runs on every container start, so this constraint widening reaches an
      -- existing prod posts table (CREATE TABLE IF NOT EXISTS would not).
      ALTER TABLE posts
        ADD CONSTRAINT posts_published_status_check CHECK (published_status IN ('draft','in_review','approved','scheduled','publishing','published','failed','rolled_back','unverified','expired'));

      -- Columns the prod posts table carries that init-db.js never declared.
      -- A fresh DB from this script previously drifted from prod, missing
      -- job_id (the marketing-job link used by resolveMediaUrls and the
      -- scheduled-dispatch path), the per-post media/creative columns, the
      -- hermes_run_id provenance link, and the legacy 'status' column.
      -- Defaults and NOT NULL mirror prod exactly (information_schema diff).
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS job_id TEXT;
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS media_type TEXT NOT NULL DEFAULT 'image';
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS media_urls TEXT[] NOT NULL DEFAULT '{}';
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS hermes_run_id TEXT;
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS creative_asset_ids TEXT[] NOT NULL DEFAULT '{}';
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft';
      ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_status_check;
      -- Keep the legacy mirror column's allowed values in lockstep with
      -- published_status: the draft-expiry sweep writes BOTH to 'expired' so
      -- they never diverge.
      ALTER TABLE posts ADD CONSTRAINT posts_status_check CHECK (status IN ('draft','in_review','approved','scheduled','publishing','published','failed','rolled_back','expired'));

      -- When the draft-expiry sweep expires a stranded post it stamps
      -- expired_at = now() for audit/observability (distinct from updated_at,
      -- which many paths touch). NULL on every non-expired post.
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ;

      -- Surface axis (feed|story|reel), orthogonal to media_type (image|video).
      -- Stories can be image or video; reels are always video; feed can be
      -- either. See migrations/20260531120000_posts_surface.sql.
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS surface TEXT NOT NULL DEFAULT 'feed';
      ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_surface_check;
      ALTER TABLE posts ADD CONSTRAINT posts_surface_check CHECK (surface IN ('feed','story','reel'));

      -- Generation-time visual-style lens stamped on synthesized posts so a later
      -- operator edit (regenerate/delete/review-reject) has a concrete
      -- (dimension,value) to mark approved/rejected with no per-edit LLM. Nullable
      -- + no default: a pre-stamp/legacy post stays NULL and is skipped by the
      -- taste producers. See migrations/20260609000000_marketing_taste_tenant_scoped.sql.
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS style_dimension TEXT;
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS style_value TEXT;

      -- Vision QA runs table for brand compliance checks
      CREATE TABLE IF NOT EXISTS vision_qa_runs (
        id BIGSERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        post_id BIGINT,
        creative_id BIGINT,
        attempt_number INTEGER NOT NULL DEFAULT 1,
        brand_color_match_score NUMERIC,
        text_legibility_score NUMERIC,
        forbidden_pattern_hits INTEGER,
        brand_violation_score NUMERIC,
        verdict TEXT CHECK (verdict IN ('pass','fail','operator_override')),
        model_version TEXT,
        raw_model_output JSONB,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      -- Scheduled posts table for publication scheduling
      CREATE TABLE IF NOT EXISTS scheduled_posts (
        id BIGSERIAL PRIMARY KEY,
        post_id BIGINT UNIQUE,
        tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        scheduled_for TIMESTAMPTZ NOT NULL,
        target_platforms TEXT[] NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ DEFAULT now()
      );

      -- OAuth callback tokens for secure state management
      CREATE TABLE IF NOT EXISTS oauth_callback_tokens (
        token_hash CHAR(64) PRIMARY KEY,
        aries_run_id TEXT NOT NULL,
        tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        issued_at TIMESTAMPTZ DEFAULT now(),
        consumed_at TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_oauth_callback_tokens_aries_run_id ON oauth_callback_tokens(aries_run_id);

      -- Add superseded_by column to creative_assets for regeneration tracking
      ALTER TABLE creative_assets
        ADD COLUMN IF NOT EXISTS superseded_by BIGINT;

      -- T15: orphan retention for upload-replace. When an upload-replace
      -- supersedes a previous creative the previous row is marked
      -- orphaned_at = now(); scripts/gc-orphan-uploads.ts deletes assets
      -- whose orphaned_at is older than 24h.
      ALTER TABLE creative_assets
        ADD COLUMN IF NOT EXISTS orphaned_at TIMESTAMPTZ;

      -- Backfill columns that may be missing on databases provisioned before
      -- these tables got their full schemas. CREATE TABLE IF NOT EXISTS
      -- above is a no-op when the table already exists, so older deployments
      -- end up with stub schemas missing the columns the CREATE INDEX below
      -- requires. ADD COLUMN IF NOT EXISTS is idempotent on fresh tables.
      -- Without these, init-db.js crashes at boot with
      -- "error: column post_id does not exist" and the container restarts
      -- forever (observed: PR #297 and PR #298 prod deploys, 2026-05-12).
      ALTER TABLE vision_qa_runs ADD COLUMN IF NOT EXISTS post_id BIGINT;
      ALTER TABLE vision_qa_runs ADD COLUMN IF NOT EXISTS creative_id BIGINT;
      ALTER TABLE vision_qa_runs ADD COLUMN IF NOT EXISTS attempt_number INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE vision_qa_runs ADD COLUMN IF NOT EXISTS brand_color_match_score NUMERIC;
      ALTER TABLE vision_qa_runs ADD COLUMN IF NOT EXISTS text_legibility_score NUMERIC;
      ALTER TABLE vision_qa_runs ADD COLUMN IF NOT EXISTS forbidden_pattern_hits INTEGER;
      ALTER TABLE vision_qa_runs ADD COLUMN IF NOT EXISTS brand_violation_score NUMERIC;
      ALTER TABLE vision_qa_runs ADD COLUMN IF NOT EXISTS verdict TEXT;
      ALTER TABLE vision_qa_runs ADD COLUMN IF NOT EXISTS model_version TEXT;
      ALTER TABLE vision_qa_runs ADD COLUMN IF NOT EXISTS raw_model_output JSONB;
      ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS post_id BIGINT;
      ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS target_platforms TEXT[] NOT NULL DEFAULT '{}';
      -- One-off event campaigns set this to the UTC instant when publishing must stop
      -- (tenant-local end-of-day, converted by the orchestrator at submit time). NULL means
      -- "no end date" -- the legacy weekly_social_content behaviour. The scheduled-posts
      -- worker filters claim-time on (campaign_end_date IS NULL OR campaign_end_date >= NOW()).
      ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS campaign_end_date TIMESTAMPTZ;
      -- Mirror surface + media_type onto scheduled_posts so the worker dispatch
      -- path forwards the publish shape without JOINing posts at claim time.
      ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS surface TEXT NOT NULL DEFAULT 'feed';
      ALTER TABLE scheduled_posts DROP CONSTRAINT IF EXISTS scheduled_posts_surface_check;
      ALTER TABLE scheduled_posts ADD CONSTRAINT scheduled_posts_surface_check CHECK (surface IN ('feed','story','reel'));
      ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS media_type TEXT NOT NULL DEFAULT 'image';
      ALTER TABLE scheduled_posts DROP CONSTRAINT IF EXISTS scheduled_posts_media_type_check;
      ALTER TABLE scheduled_posts ADD CONSTRAINT scheduled_posts_media_type_check CHECK (media_type IN ('image','video'));

      CREATE INDEX IF NOT EXISTS idx_posts_tenant_created ON posts (tenant_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_vision_qa_runs_tenant_post ON vision_qa_runs (tenant_id, post_id);
      CREATE INDEX IF NOT EXISTS idx_scheduled_posts_tenant_scheduled ON scheduled_posts (tenant_id, scheduled_for);
      CREATE INDEX IF NOT EXISTS idx_creative_assets_tenant_orphaned_at ON creative_assets (tenant_id, orphaned_at) WHERE orphaned_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS marketing_operator_creative_preferences (
        tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        always_match_creative_voice BOOLEAN NOT NULL DEFAULT FALSE,
        voice_style_label TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, user_id)
      );

      -- Onboarding first-post variant-board taste learning. Mirrored in
      -- migrations/20260602000000_marketing_taste_profile.sql (run manually on
      -- existing DBs). dimensions is an opaque jsonb map of dimension ->
      -- per-value counters; confidence + 5%/week decay are computed at READ time
      -- in backend/marketing/taste-profile-store.ts. tenant_id/user_id INTEGER
      -- match organizations.id/users.id (int4) -- do not use BIGINT.
      -- user_id is NULLABLE: a real SQL NULL identifies the tenant-scoped row used
      -- by the userless weekly run (NOT a sentinel int — still an FK to users).
      -- Uniqueness comes from the two indexes added below, not a PK, so a
      -- (tenant, NULL) row and per-user rows can coexist. See
      -- migrations/20260609000000_marketing_taste_tenant_scoped.sql.
      CREATE TABLE IF NOT EXISTS marketing_taste_profile (
        tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        dimensions JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Append-only event log: one row per pick/rate/edit signal on a variant
      -- (onboarding) or per-tenant edit signal (weekly run). user_id /
      -- variant_batch_id / variant_id are NULLABLE so a userless/non-variant
      -- signal row can be appended.
      CREATE TABLE IF NOT EXISTS marketing_taste_signal (
        id BIGSERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        job_id TEXT NOT NULL,
        variant_batch_id TEXT,
        slot_index INT NOT NULL DEFAULT 0,
        variant_id TEXT,
        picked BOOLEAN NOT NULL DEFAULT FALSE,
        rating INT,
        edit_ops JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT marketing_taste_signal_rating_range CHECK (rating IS NULL OR rating BETWEEN 1 AND 5)
      );
      CREATE INDEX IF NOT EXISTS idx_marketing_taste_signal_tenant_user ON marketing_taste_signal (tenant_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_marketing_taste_signal_batch ON marketing_taste_signal (variant_batch_id);
      CREATE INDEX IF NOT EXISTS idx_marketing_taste_signal_tenant_user_created ON marketing_taste_signal (tenant_id, user_id, created_at DESC);

      -- PR2 tenant-scoped relaxation (reaches an EXISTING prod table, which the
      -- CREATE TABLE IF NOT EXISTS above does not). Idempotent + re-runnable on
      -- every container start. Drop the (tenant_id,user_id) PK so a tenant-scoped
      -- (user_id NULL) row is allowed; re-establish uniqueness via two indexes:
      --   * (tenant_id, user_id) keeps the onboarding ON CONFLICT (tenant_id,user_id) upsert working;
      --   * partial (tenant_id) WHERE user_id IS NULL enforces one tenant row and
      --     is the inference target for the weekly upsert.
      ALTER TABLE marketing_taste_profile DROP CONSTRAINT IF EXISTS marketing_taste_profile_pkey;
      ALTER TABLE marketing_taste_profile ALTER COLUMN user_id DROP NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_taste_profile_tenant_user
        ON marketing_taste_profile (tenant_id, user_id);
      CREATE UNIQUE INDEX IF NOT EXISTS uq_marketing_taste_profile_tenant_only
        ON marketing_taste_profile (tenant_id) WHERE user_id IS NULL;
      ALTER TABLE marketing_taste_signal ALTER COLUMN user_id DROP NOT NULL;
      ALTER TABLE marketing_taste_signal ALTER COLUMN variant_batch_id DROP NOT NULL;
      ALTER TABLE marketing_taste_signal ALTER COLUMN variant_id DROP NOT NULL;

      CREATE TABLE IF NOT EXISTS honcho_write_idempotency_keys (
        key TEXT PRIMARY KEY,
        written_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Worker-side ledger for the honcho-performance-worker (delayed real-Meta
      -- performance -> Honcho memory). Distinct from honcho_write_idempotency_keys
      -- (the Honcho-side claim inside recordPerformanceEvent): this lets the
      -- due-posts query cheaply skip already-written (job_id, platform, metric_day)
      -- without re-driving the Honcho idempotency claim every 30-min tick.
      -- tenant_id INTEGER matches organizations.id (int4) -- do not use BIGINT.
      -- metric_day is the post's UTC publish day (the #513 metric day), so
      -- 24h/72h/7d/30d re-polls of the same metric-day collapse to one ledger row.
      CREATE TABLE IF NOT EXISTS honcho_perf_writes (
        tenant_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        job_id     TEXT    NOT NULL,
        platform   TEXT    NOT NULL,
        metric_day DATE    NOT NULL,
        written_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (tenant_id, job_id, platform, metric_day)
      );

      -- Hackathon landing page registrations. Standalone table -- not tied to
      -- organizations or users because the /hackathon landing page is public
      -- and most registrants will not have Aries accounts. Email is unique
      -- (case-insensitive) so a refresh-and-resubmit just upserts the same
      -- record; double-registration is silently idempotent rather than a 409.
      CREATE TABLE IF NOT EXISTS hackathon_registrations (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        motivation TEXT,
        ip_address TEXT,
        user_agent TEXT,
        registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_hackathon_registrations_email_lower
        ON hackathon_registrations (lower(email));

      CREATE TABLE IF NOT EXISTS partner_attribution_outbox (
        id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        ref_code TEXT NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        company TEXT,
        domain TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INT NOT NULL DEFAULT 0,
        last_error TEXT,
        next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        delivered_at TIMESTAMPTZ,
        CONSTRAINT partner_attribution_outbox_status_valid CHECK (status IN ('pending','delivered','dead'))
      );

      CREATE INDEX IF NOT EXISTS idx_partner_attribution_outbox_pending
        ON partner_attribution_outbox (next_attempt_at)
        WHERE status = 'pending';

      -- PR #327: posts idempotency_key for double-publish prevention.
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS platform TEXT;
      ALTER TABLE posts ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_tenant_platform_idempotency_key
        ON posts (tenant_id, platform, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_posts_tenant_platform ON posts (tenant_id, platform);

      -- resolveMediaUrls and the scheduled-dispatch path look posts up by
      -- (tenant_id, job_id) to scope creative assets; index the link.
      CREATE INDEX IF NOT EXISTS idx_posts_tenant_job ON posts (tenant_id, job_id) WHERE job_id IS NOT NULL;

      -- Draft-expiry sweep candidate scan: pre-publish posts ordered by
      -- updated_at. Partial index keeps the sweep's COUNT/SELECT cheap even as
      -- the posts table grows, since the vast majority of rows are terminal
      -- (published/scheduled/failed/expired) and fall outside the index. Keyed
      -- on the canonical published_status only — matches the sweep predicate,
      -- which trusts published_status (not the legacy status mirror).
      CREATE INDEX IF NOT EXISTS idx_posts_draft_expiry
        ON posts (updated_at)
        WHERE published_status IN ('draft','in_review','approved');

      -- Scheduled posts worker: dispatch status tracking columns.
      -- 'in_flight' is a non-terminal claimed state: the worker commits it
      -- before the network publish so a crash mid-publish leaves a reclaimable
      -- row rather than a false 'dispatched'. The parent dispatch_status is a
      -- rollup derived from the per-platform scheduled_post_dispatches rows.
      ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS dispatch_status TEXT NOT NULL DEFAULT 'pending' CHECK (dispatch_status IN ('pending','in_flight','dispatched','failed'));
      ALTER TABLE scheduled_posts DROP CONSTRAINT IF EXISTS scheduled_posts_dispatch_status_check;
      ALTER TABLE scheduled_posts ADD CONSTRAINT scheduled_posts_dispatch_status_check CHECK (dispatch_status IN ('pending','in_flight','dispatched','failed'));
      ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;
      ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS error_at TIMESTAMPTZ;
      ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS error_message TEXT;
      CREATE INDEX IF NOT EXISTS idx_scheduled_posts_pending ON scheduled_posts (scheduled_for) WHERE dispatch_status = 'pending';
      -- The reclaim branch of the worker's due-rows scan filters on
      -- dispatch_status = 'in_flight'; index it the same way as 'pending'.
      CREATE INDEX IF NOT EXISTS idx_scheduled_posts_in_flight ON scheduled_posts (scheduled_for) WHERE dispatch_status = 'in_flight';

      -- Per-platform dispatch state. A scheduled_posts row targets an array of
      -- platforms; a cross-post that succeeds on Facebook and fails on
      -- Instagram cannot be told the truth by one scalar dispatch_status.
      -- Each (scheduled_post, platform) pair gets its own row; the parent
      -- scheduled_posts.dispatch_status is the rollup (all dispatched ->
      -- dispatched, any failed -> failed, any still pending/in_flight ->
      -- the lower state).
      CREATE TABLE IF NOT EXISTS scheduled_post_dispatches (
        id BIGSERIAL PRIMARY KEY,
        scheduled_post_id BIGINT NOT NULL REFERENCES scheduled_posts(id) ON DELETE CASCADE,
        platform TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_flight','dispatched','failed')),
        dispatched_at TIMESTAMPTZ,
        error_at TIMESTAMPTZ,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (scheduled_post_id, platform)
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_post_dispatches_parent
        ON scheduled_post_dispatches (scheduled_post_id);

      -- Phase 4 PR1: Slack Events API inbound dedupe. Every delivery has a
      -- stable event_id; the webhook inserts ON CONFLICT DO NOTHING to drop
      -- retries before any business logic runs. Optional 30-day retention
      -- prune is scheduled separately.
      CREATE TABLE IF NOT EXISTS slack_event_ids (
        event_id TEXT PRIMARY KEY,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_slack_event_ids_received_at
        ON slack_event_ids (received_at);

      -- Phase 4 PR2: OUTBOUND Slack notification dedupe. The marketing callback
      -- is re-delivered by the reconciler under a different event_id than the
      -- original poll-bridge delivery, so notifications dedupe on a STABLE
      -- identity (e.g. approval:<jobId>:<stage>) via INSERT ON CONFLICT DO
      -- NOTHING — only the first delivery for a given key pings the channel.
      CREATE TABLE IF NOT EXISTS slack_notifications (
        dedup_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        tenant_id INTEGER,
        marketing_job_id TEXT,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_slack_notifications_sent_at
        ON slack_notifications (sent_at);
    `);

    // ─── Weekly trigger schedule ─────────────────────────────────────────────────
    // One row per tenant that opts into the weekly-content cadence. The
    // weekly-job-trigger-worker (scripts/automations/weekly-job-trigger-worker.ts)
    // atomically claims due rows and starts a weekly_social_content job for each.
    // Mirrors the scheduled-posts-worker pattern but UPSTREAM: it fills the
    // generate side of the pipeline so a human can review + approve, instead of
    // requiring the unsafe ARIES_AUTO_APPROVE_MARKETING_PIPELINE flag.
    //
    // last_triggered_at is the claim marker — the worker's conditional UPDATE
    // (last_triggered_at < window-start) is what makes "one job per tenant per
    // cadence window" safe across concurrent ticks AND multiple containers.
    // last_attempt_at / last_success_at split lets a failed submit be loud (an
    // attempt with no matching success = a missed week) without losing the retry.
    await client.query(`
      CREATE TABLE IF NOT EXISTS marketing_schedule (
        tenant_id INTEGER PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        cadence TEXT NOT NULL DEFAULT 'weekly' CHECK (cadence IN ('weekly')),
        day_of_week INTEGER NOT NULL DEFAULT 1 CHECK (day_of_week BETWEEN 0 AND 6),
        hour INTEGER NOT NULL DEFAULT 9 CHECK (hour BETWEEN 0 AND 23),
        timezone TEXT,
        enabled BOOLEAN NOT NULL DEFAULT false,
        last_triggered_at TIMESTAMPTZ,
        last_attempt_at TIMESTAMPTZ,
        last_success_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_marketing_schedule_enabled
        ON marketing_schedule (enabled) WHERE enabled;
    `);

    // ─── Insights module ────────────────────────────────────────────────────────
    // Platform-agnostic analytics tables. Every table is prefixed insights_ so
    // ownership is obvious at a glance and future features can't collide.
    await client.query(`
      -- One row per connected platform account on a tenant
      -- (e.g. one YouTube channel, one Instagram account).
      CREATE TABLE IF NOT EXISTS insights_accounts (
        id                     BIGSERIAL PRIMARY KEY,
        tenant_id              INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        platform               TEXT NOT NULL,
        external_account_id    TEXT NOT NULL,
        display_name           TEXT,
        connected_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_sync_at           TIMESTAMPTZ,
        backfill_completed_at  TIMESTAMPTZ,
        platform_data          JSONB NOT NULL DEFAULT '{}',
        UNIQUE (tenant_id, platform, external_account_id)
      );
      CREATE INDEX IF NOT EXISTS idx_insights_accounts_tenant_platform
        ON insights_accounts (tenant_id, platform);

      -- One row per piece of content fetched from a platform
      -- (YouTube video, Instagram reel, etc.).
      -- Named insights_posts to avoid collision with the existing posts table
      -- used by the weekly social-content feature.
      CREATE TABLE IF NOT EXISTS insights_posts (
        id                       BIGSERIAL PRIMARY KEY,
        tenant_id                INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        account_id               BIGINT NOT NULL REFERENCES insights_accounts(id) ON DELETE CASCADE,
        platform                 TEXT NOT NULL,
        external_post_id         TEXT NOT NULL,
        published_at             TIMESTAMPTZ NOT NULL,
        media_type               TEXT NOT NULL,  -- 'video'|'short'|'image'|'carousel'|'reel'|'story'|'text'|'live'
        title                    TEXT,
        caption                  TEXT,           -- YT description and IG/FB caption both land here
        permalink                TEXT,
        duration_seconds         INT,            -- null when not applicable
        platform_data            JSONB NOT NULL DEFAULT '{}',
        fetched_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_metrics_fetched_at  TIMESTAMPTZ,   -- drives post-publish checkpoint sync
        UNIQUE (tenant_id, platform, external_post_id)
      );
      CREATE INDEX IF NOT EXISTS idx_insights_posts_tenant_platform_published
        ON insights_posts (tenant_id, platform, published_at DESC);
      CREATE INDEX IF NOT EXISTS idx_insights_posts_tenant_published
        ON insights_posts (tenant_id, published_at DESC);
      CREATE INDEX IF NOT EXISTS idx_insights_posts_tenant_platform_metrics
        ON insights_posts (tenant_id, platform, last_metrics_fetched_at);

      -- Daily time-series for account-level metrics (channel views, followers, etc.).
      -- reach is NULL for platforms without a unique-viewer concept (e.g. YouTube).
      -- saves is NULL for platforms that don't expose saves.
      -- raw_source records adapter + mapping version for auditability.
      CREATE TABLE IF NOT EXISTS insights_account_metrics_daily (
        tenant_id              INTEGER NOT NULL,
        account_id             BIGINT NOT NULL REFERENCES insights_accounts(id) ON DELETE CASCADE,
        platform               TEXT NOT NULL,
        date                   DATE NOT NULL,
        views                  BIGINT,
        reach                  BIGINT,
        watch_time_minutes     BIGINT,
        followers              BIGINT,
        followers_delta        INT,
        profile_visits         INT,
        likes                  INT,
        comments_count         INT,
        shares                 INT,
        saves                  INT,
        platform_data          JSONB NOT NULL DEFAULT '{}',
        raw_source             JSONB NOT NULL,
        PRIMARY KEY (tenant_id, account_id, date)
      );
      CREATE INDEX IF NOT EXISTS idx_insights_account_metrics_daily_tenant_platform_date
        ON insights_account_metrics_daily (tenant_id, platform, date DESC);

      -- Daily time-series for post-level metrics.
      CREATE TABLE IF NOT EXISTS insights_post_metrics_daily (
        tenant_id              INTEGER NOT NULL,
        post_id                BIGINT NOT NULL REFERENCES insights_posts(id) ON DELETE CASCADE,
        platform               TEXT NOT NULL,
        date                   DATE NOT NULL,
        views                  BIGINT,
        reach                  BIGINT,
        watch_time_minutes     BIGINT,
        avg_view_duration_sec  INT,
        avg_view_percentage    NUMERIC(5,2),
        likes                  INT,
        comments_count         INT,
        shares                 INT,
        saves                  INT,
        platform_data          JSONB NOT NULL DEFAULT '{}',
        raw_source             JSONB NOT NULL,
        PRIMARY KEY (tenant_id, post_id, date)
      );
      CREATE INDEX IF NOT EXISTS idx_insights_post_metrics_daily_tenant_platform_date
        ON insights_post_metrics_daily (tenant_id, platform, date DESC);

      -- Raw comments fetched from platforms.
      CREATE TABLE IF NOT EXISTS insights_comments (
        id                  BIGSERIAL PRIMARY KEY,
        tenant_id           INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        post_id             BIGINT NOT NULL REFERENCES insights_posts(id) ON DELETE CASCADE,
        platform            TEXT NOT NULL,
        external_comment_id TEXT NOT NULL,
        received_at         TIMESTAMPTZ NOT NULL,
        author_handle       TEXT,
        body_text           TEXT NOT NULL,
        is_replied          BOOLEAN NOT NULL DEFAULT false,
        platform_data       JSONB NOT NULL DEFAULT '{}',
        UNIQUE (tenant_id, platform, external_comment_id)
      );
      CREATE INDEX IF NOT EXISTS idx_insights_comments_tenant_platform_received
        ON insights_comments (tenant_id, platform, received_at DESC);

      -- LLM sentiment + lead classification results per comment.
      CREATE TABLE IF NOT EXISTS insights_comment_classifications (
        comment_id         BIGINT PRIMARY KEY REFERENCES insights_comments(id) ON DELETE CASCADE,
        tenant_id          INTEGER NOT NULL,
        sentiment          TEXT,    -- 'positive'|'neutral'|'negative'
        is_lead            BOOLEAN,
        category           TEXT,    -- 'question'|'compliment'|'complaint'|'spam'|'other'
        classifier_version TEXT NOT NULL,
        cost_cents         NUMERIC(10,4) NOT NULL,
        classified_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );

      -- Demographics snapshots. demographics is NULL when unavailable;
      -- unavailable_reason explains why (e.g. 'below_threshold', 'permission_missing').
      CREATE TABLE IF NOT EXISTS insights_audience_snapshots (
        tenant_id          INTEGER NOT NULL,
        account_id         BIGINT NOT NULL REFERENCES insights_accounts(id) ON DELETE CASCADE,
        platform           TEXT NOT NULL,
        snapshot_date      DATE NOT NULL,
        demographics       JSONB,
        unavailable_reason TEXT,
        raw_source         JSONB NOT NULL,
        PRIMARY KEY (tenant_id, account_id, snapshot_date)
      );

      -- LLM-generated narrative copy for each dashboard section.
      -- input_hash dedupes: if the underlying numbers haven't changed,
      -- no new LLM call is needed. UNIQUE on (tenant, period, platform, section_key)
      -- so upsert is safe.
      CREATE TABLE IF NOT EXISTS insights_narratives (
        id              BIGSERIAL PRIMARY KEY,
        tenant_id       INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        period          TEXT NOT NULL,       -- 'week'|'30day'|'90day'
        platform        TEXT NOT NULL,       -- platform value or 'all'
        section_key     TEXT NOT NULL,       -- 'hero'|'goal'|'attention'|...
        body            JSONB NOT NULL,
        prompt_version  TEXT NOT NULL,
        model           TEXT NOT NULL,
        input_hash      TEXT NOT NULL,
        cost_cents      NUMERIC(10,4) NOT NULL,
        generated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (tenant_id, period, platform, section_key)
      );

      -- Audit log: one row per sync run (interval, manual, or backfill).
      CREATE TABLE IF NOT EXISTS insights_sync_runs (
        id              BIGSERIAL PRIMARY KEY,
        tenant_id       INTEGER NOT NULL,
        account_id      BIGINT NOT NULL,
        platform        TEXT NOT NULL,
        trigger         TEXT NOT NULL,    -- 'interval'|'handler'|'backfill'
        started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        finished_at     TIMESTAMPTZ,
        status          TEXT NOT NULL,    -- 'running'|'ok'|'partial'|'failed'
        posts_seen      INT NOT NULL DEFAULT 0,
        comments_seen   INT NOT NULL DEFAULT 0,
        api_units_used  INT NOT NULL DEFAULT 0,
        error_message   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_insights_sync_runs_tenant_platform_started
        ON insights_sync_runs (tenant_id, platform, started_at DESC);
      -- Partial index serving the stranded-run sweep
      -- (backend/insights/sync/sweep-stranded-runs.ts: WHERE status='running'
      -- AND started_at < cutoff). Near-empty — 'running' rows are transient —
      -- so the half-hourly sweep never seq-scans this append-only audit table.
      CREATE INDEX IF NOT EXISTS idx_insights_sync_runs_running_started
        ON insights_sync_runs (started_at) WHERE status = 'running';

      -- Audit log: every LLM call with cost, tokens, and outcome.
      CREATE TABLE IF NOT EXISTS insights_llm_calls (
        id            BIGSERIAL PRIMARY KEY,
        tenant_id     INTEGER NOT NULL,
        purpose       TEXT NOT NULL,    -- 'classify_comment'|'generate_narrative'
        model         TEXT NOT NULL,
        cost_cents    NUMERIC(10,4) NOT NULL,
        input_tokens  INT,
        output_tokens INT,
        duration_ms   INT,
        succeeded     BOOLEAN NOT NULL,
        error_code    TEXT,
        called_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_insights_llm_calls_tenant_called_at
        ON insights_llm_calls (tenant_id, called_at DESC);

      -- content_type is set by Hermes at generation time on the posts table.
      -- It is propagated to insights_posts on sync so the analytics module
      -- stays self-contained (no cross-domain JOIN needed for content mix queries).
      -- aries_post_id links each analytics row back to its Aries-generated source post,
      -- enforcing the Aries-only analytics scope.
      ALTER TABLE insights_posts ADD COLUMN IF NOT EXISTS content_type TEXT;
      ALTER TABLE insights_posts ADD COLUMN IF NOT EXISTS aries_post_id BIGINT REFERENCES posts(id) ON DELETE SET NULL;

      CREATE INDEX IF NOT EXISTS idx_insights_posts_content_type
        ON insights_posts (tenant_id, content_type)
        WHERE content_type IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_insights_posts_aries_post_id
        ON insights_posts (aries_post_id)
        WHERE aries_post_id IS NOT NULL;

      -- is_replied is also declared inline in the CREATE TABLE insights_comments
      -- above, but that table predates the column on existing databases and
      -- CREATE TABLE IF NOT EXISTS never widens them — so the inline declaration is
      -- a no-op on prod. Add it idempotently here too (matching the
      -- content_type/aries_post_id pattern) so existing tables backfill on start.
      -- conversations/narrative/attention/trends builders read c.is_replied and
      -- would 500 once a tenant has comment rows without this.
      ALTER TABLE insights_comments ADD COLUMN IF NOT EXISTS is_replied BOOLEAN NOT NULL DEFAULT false;
    `);
    // ─── End insights module ─────────────────────────────────────────────────

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
