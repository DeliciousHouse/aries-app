-- Preserve onboarding's canonical selection independently from free-text goal prose.
ALTER TABLE onboarding_drafts
  ADD COLUMN IF NOT EXISTS goal_type TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'onboarding_drafts'::regclass
      AND conname = 'onboarding_drafts_goal_type_check'
  ) THEN
    ALTER TABLE onboarding_drafts
      ADD CONSTRAINT onboarding_drafts_goal_type_check
      CHECK (goal_type IS NULL OR goal_type IN (
        'lead_generation', 'content_growth', 'product_sales', 'brand_awareness'
      ));
  END IF;
END $$;
