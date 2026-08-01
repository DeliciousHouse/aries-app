-- AA-115 / S6-2 (gap F3b): the canonical goal key alongside the descriptive
-- free text. `primary_goal` stays exactly as it is — it has four free-form
-- writers and it feeds the Hermes brand prompts, so it is not being replaced.
-- This adds the machine-readable key next to it.
--
-- NULL is meaningful and is the default: it means "Aries has not confidently
-- mapped this tenant's goal", which is precisely the state the S1-5
-- "Goal inferred — confirm" chip exists to surface. A row is only ever given a
-- goal_type when the mapping is FORCED — the stored text is already a canonical
-- key, or exactly one keyword family matches it.
--
-- This migration deliberately writes NO DATA. Two reasons:
--
--   1. No silent baking-in. The read path defaults every unmatched goal to
--      brand_awareness so that the label and narrative are never blank. That
--      default is a guess, and shipped onboarding presets land on it —
--      "Increase social media presence" and "Book more qualified calls" both
--      match nothing. A SQL backfill that wrote brand_awareness for them would
--      convert a visible guess into a settled-looking fact and permanently
--      silence the confirm chip for exactly the tenants who most need it.
--   2. One vocabulary. The keyword families live in TypeScript
--      (backend/insights/goal/goal-type-classification.ts) and the read path
--      resolves with them on every request. Restating those regexes in SQL
--      would create a second source of truth that drifts.
--
-- The data pass is therefore scripts/backfill-business-profile-goal-type.ts,
-- which classifies with the same shared families, writes only confident rows,
-- and supports --dry-run. Run it after this migration:
--
--   tsx scripts/backfill-business-profile-goal-type.ts --all --dry-run
--   tsx scripts/backfill-business-profile-goal-type.ts --all
--
-- Mirrors scripts/init-db.js (applied on container start); this file is the
-- record for databases that are migrated rather than initialized.

ALTER TABLE business_profiles
  ADD COLUMN IF NOT EXISTS goal_type TEXT;

-- Named to match the constraint PostgreSQL auto-generates for the inline column
-- CHECK in scripts/init-db.js (`<table>_<column>_check`), so a freshly
-- initialized database and a migrated one converge on one constraint, and
-- re-running this file is a no-op either way.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'business_profiles'::regclass
      AND conname = 'business_profiles_goal_type_check'
  ) THEN
    ALTER TABLE business_profiles
      ADD CONSTRAINT business_profiles_goal_type_check
      CHECK (goal_type IS NULL OR goal_type IN (
        'lead_generation', 'content_growth', 'product_sales', 'brand_awareness'
      ));
  END IF;
END $$;
