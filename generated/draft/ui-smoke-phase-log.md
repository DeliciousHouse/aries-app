# phase_3_end_to_end_ui_smoke re-run log

- Runtime target: `http://localhost:3000`
- Result: **pass**
- Bounded repairs required: **no**
- Hard failures: **none**

## Onboarding flow
1. Opened `/onboarding/start`.
2. Submitted valid payload (`tenant_id` resolved from proposed slug, signup event provided).
3. Verified start success by UI transition to onboarding status route.
4. Loaded `/onboarding/status?tenant_id=tenant-smoke-b&signup_event_id=signup-smoke-b`.
5. Verified status data rendered from live API:
   - `onboarding_status: ok`
   - `provisioning_status: not_found`
   - `validation_status: unknown`

## Marketing flow
1. Opened `/marketing/new-job`.
2. Submitted valid job request for tenant `tenant-smoke-b`.
3. Verified accepted response rendered with job id `mkt_tenant-smoke-b_1773049130830`.
4. Opened `/marketing/job-status?jobId=mkt_tenant-smoke-b_1773049130830` and loaded live status.
5. Verified stage/status render before approval:
   - `marketing_stage: research`
   - `marketing_job_status: pending`
6. Opened `/marketing/job-approve?...` and executed approval action.
7. Verified approval success and updated render:
   - `approval_status: resumed`
   - current stage moved to `strategy`
   - stage status includes `research: completed`
