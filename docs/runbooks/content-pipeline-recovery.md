# Content pipeline recovery

The alert rules in `ops/alerts/aries-content-pipeline.rules.yml` are staged for the A2 Prometheus endpoint. Do not enable them until A2 exposes `aries_dispatch_dead_letters_total` and `aries_drafts_expiring_24h` with the same names.

## Dispatch dead letters

1. List dead-lettered platform attempts and their class:

   ```sql
   SELECT spd.scheduled_post_id, spd.platform, spd.failure_class,
          spd.attempts, spd.error_message, spd.dead_lettered_at
     FROM scheduled_post_dispatches spd
    WHERE spd.status = 'dead_letter'
    ORDER BY spd.dead_lettered_at DESC;
   ```

2. Remediate by class:
   - `auth_token`: reconnect the tenant's Meta account and verify the connection.
   - `media_invalid`: replace or correct the referenced media asset.
   - `platform_permanent`: correct the rejected post/provider configuration.
   - `platform_transient`: confirm the provider has recovered; this class reached the configured attempt ceiling.
3. Confirm the provider did not publish the post. Dead-letter classes are failures for which Aries received explicit non-success evidence; `outcome_unknown` remains quarantined in `manual_reconciliation` and must never be replayed blindly.
4. Requeue only the corrected platform child and its parent in one transaction, using the concrete IDs from step 1:

   ```sql
   BEGIN;
   UPDATE scheduled_post_dispatches
      SET status = 'pending', failure_class = NULL, error_message = NULL,
          error_at = NULL, dead_lettered_at = NULL, attempts = 0, updated_at = now()
    WHERE scheduled_post_id = :scheduled_post_id
      AND platform = :platform
      AND status = 'dead_letter';
   UPDATE scheduled_posts
      SET dispatch_status = 'pending', failure_class = NULL, error_message = NULL,
          error_at = NULL, dead_lettered_at = NULL, next_attempt_at = NULL,
          updated_at = now()
    WHERE id = :scheduled_post_id
      AND dispatch_status = 'dead_letter';
   COMMIT;
   ```

5. Watch the next worker summary and verify the child becomes `dispatched`. If it dead-letters again, stop replaying and fix the underlying class-specific cause.

## Drafts expiring within 24 hours

1. Find unscheduled drafts in the warning window using the same age configured by `ARIES_DRAFT_EXPIRY_AGE_DAYS`.
2. Schedule drafts that should publish. Scheduling removes them from the expiry predicate.
3. For drafts intentionally retained for later review, update them through the normal edit flow so `updated_at` reflects real operator activity. Do not touch timestamps in bulk merely to silence the warning.
4. Allow abandoned drafts to expire; the sweep is idempotent and never expires scheduled or provider-published posts.
