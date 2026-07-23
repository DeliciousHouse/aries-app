-- AA-167: durable Jira create/attachment state for crash-safe reconciliation.
-- A create fence is committed before Jira network I/O. Ambiguous creates are
-- reconciled by label and never blindly repeated after one stale search miss.
-- New screenshots are private Aries records and are not copied to Jira. The
-- legacy schema cannot prove whether an existing screenshot was attached, so
-- populated rows cross the cutover as uncertain rather than retained_private.

DO $feedback_delivery_state$
DECLARE
  jira_create_state_was_missing BOOLEAN;
  attachment_state_was_missing BOOLEAN;
BEGIN
  -- Serialize first-upgrade detection across concurrently starting app nodes.
  LOCK TABLE feedback_reports IN ACCESS EXCLUSIVE MODE;

  SELECT NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'feedback_reports'
       AND column_name = 'jira_create_state'
  ) INTO jira_create_state_was_missing;
  SELECT NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'feedback_reports'
       AND column_name = 'attachment_state'
  ) INTO attachment_state_was_missing;

  ALTER TABLE feedback_reports
    ADD COLUMN IF NOT EXISTS jira_create_state TEXT NOT NULL DEFAULT 'not_started'
      CHECK (jira_create_state IN ('not_started','in_flight','uncertain','completed')),
    ADD COLUMN IF NOT EXISTS jira_create_token TEXT,
    ADD COLUMN IF NOT EXISTS attachment_state TEXT NOT NULL DEFAULT 'none'
      CHECK (attachment_state IN ('none','in_flight','uncertain','completed','retained_private'));

  IF jira_create_state_was_missing THEN
    UPDATE feedback_reports
       SET jira_create_state = 'completed'
     WHERE jira_ticket_key IS NOT NULL;

    -- Any keyless legacy row may represent a create whose acknowledgement was
    -- lost before status/attempt bookkeeping. Fence every such row and require
    -- label reconciliation; one stale Jira search miss can never authorize a
    -- duplicate create.
    UPDATE feedback_reports
       SET jira_create_state = 'uncertain',
           jira_create_token = COALESCE(jira_create_token, 'aries-sub-' || id)
     WHERE jira_ticket_key IS NULL;
  END IF;

  IF attachment_state_was_missing THEN
    UPDATE feedback_reports
       SET attachment_state = 'uncertain'
     WHERE screenshot_bytes IS NOT NULL;
  END IF;
END
$feedback_delivery_state$;
