-- AA-151: distinguish goals a person explicitly chose/confirmed from goals
-- inferred by Aries. Unknown legacy values default to inferred so the Insights
-- confirmation prompt fails safe. Pre-column rows have no durable evidence of
-- who supplied the text, so even values matching onboarding presets stay inferred.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'business_profiles'
      AND column_name = 'primary_goal_source'
  ) THEN
    ALTER TABLE business_profiles
      ADD COLUMN IF NOT EXISTS primary_goal_source TEXT NOT NULL DEFAULT 'inferred'
      CHECK (primary_goal_source IN ('explicit', 'inferred'));
  END IF;
END $$;