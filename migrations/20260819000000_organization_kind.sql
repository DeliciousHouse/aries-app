-- Existing organizations are production unless an operator classifies them otherwise.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'production';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'organizations'::regclass
       AND conname = 'organizations_kind_check'
  ) THEN
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_kind_check
      CHECK (kind IN ('production', 'test', 'archived'));
  END IF;
END $$;
