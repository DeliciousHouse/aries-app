-- creative_assets: onboarding variant-board grouping columns.
--
-- variant_batch_id groups the N (MVP = 3) competing first-post variants the
-- onboarding board fans out; variant_index is the 0-based position within the
-- batch. Both nullable + backward-compatible: every existing/non-variant asset
-- stays NULL and is unaffected. They are stamped at ingest time from the job
-- doc (doc.inputs.request.variant_batch_id / variant_index), NOT from the Hermes
-- callback (the callback payload carries no callback_context).
--
-- Applied via scripts/init-db.js on fresh DBs; run this file manually on
-- existing deployments. Additive + idempotent (ADD COLUMN IF NOT EXISTS).
-- Reverse: ALTER TABLE creative_assets DROP COLUMN variant_index, DROP COLUMN variant_batch_id;

ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS variant_batch_id TEXT;
ALTER TABLE creative_assets ADD COLUMN IF NOT EXISTS variant_index INTEGER;

-- Board read path: "the variants in this batch" — partial index, NULL rows excluded.
CREATE INDEX IF NOT EXISTS idx_creative_assets_variant_batch
  ON creative_assets (tenant_id, variant_batch_id)
  WHERE variant_batch_id IS NOT NULL;
