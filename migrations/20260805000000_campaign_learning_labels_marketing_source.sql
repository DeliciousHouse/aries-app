-- S4-6 / AA-109 (gap C4): let the marketing review tray write learning labels.
--
-- Until now the ONLY writer of campaign_learning_labels was the manual Creative
-- Memory labeling tool, so the "Working with Aries" insights section (approval
-- flow bar + learning curve) read zeros for every real tenant — the data it
-- charts only existed if someone hand-labeled assets.
--
-- The marketing review tray could not write into this table as it stood: every
-- row had to reference prompt_recipes(id) or generated_assets(id), both Creative
-- Memory UUIDs. A marketing review decision identifies its target by marketing
-- job id (TEXT) plus a RUNTIME asset key such as 'img_1' that lives in a job
-- document under DATA_ROOT — there is no row to point a foreign key at. Hence
-- two untyped reference columns and a third alternative in the target CHECK,
-- rather than a fake FK or a synthetic generated_assets row per review.
--
-- confidence_basis already allowed 'review_decision'; the marketing writer uses
-- it, so its rows stay distinguishable from 'manual_label' ones forever.
--
-- Also shipped in scripts/init-db.js (applied on container start); this file is
-- the migration record.

ALTER TABLE campaign_learning_labels ADD COLUMN IF NOT EXISTS marketing_job_id TEXT;
ALTER TABLE campaign_learning_labels ADD COLUMN IF NOT EXISTS marketing_asset_id TEXT;

-- Widen the target CHECK. 'campaign_learning_labels_check' is the name Postgres
-- auto-assigns to this table's single unnamed table-level CHECK. Dropping it
-- only ever relaxes the constraint, so every existing row still satisfies the
-- replacement.
ALTER TABLE campaign_learning_labels
  DROP CONSTRAINT IF EXISTS campaign_learning_labels_check;
ALTER TABLE campaign_learning_labels
  ADD CONSTRAINT campaign_learning_labels_check
  CHECK (prompt_recipe_id IS NOT NULL OR generated_asset_id IS NOT NULL OR marketing_job_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_campaign_learning_labels_tenant_marketing_job
  ON campaign_learning_labels (tenant_id, marketing_job_id)
  WHERE marketing_job_id IS NOT NULL;
