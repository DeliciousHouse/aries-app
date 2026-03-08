# gating test phase log

## TEST 1 HAPPY PATH @ 2026-03-08T12:10:27.718Z
- workspace_created: true
- validator_pass: true
- promoted: true

## TEST 2 IDEMPOTENCY @ 2026-03-08T12:10:32.024Z
- duplicate_workspace_created: false
- duplicate_tenant_created: false
- duplicate_agent_created: false

## TEST 3 FORCED VALIDATOR FAILURE @ 2026-03-08T12:10:36.195Z
- validator_failed_deterministically: true
- repaired_section_only: true
- final_validation_pass: true

## TEST 4 FORCED N8N PUBLISH FAILURE @ 2026-03-08T12:10:40.155Z
- failure_payload_captured: true
- bounded_repair_applied: false
- final_publish_pass: false
- hard_failure: true

## TEST 4 FORCED N8N PUBLISH FAILURE RERUN @ 2026-03-08T12:44:07.912Z
- failure_payload_captured: true
- bounded_repair_applied: true
- final_publish_pass: false
- hard_failure: true

## TEST 4 FORCED N8N PUBLISH FAILURE RERUN @ 2026-03-08T12:44:59.503Z
- failure_payload_captured: true
- bounded_repair_applied: true
- final_publish_pass: false
- hard_failure: true

## TEST 4 FORCED N8N PUBLISH FAILURE RERUN @ 2026-03-08T12:45:37.280Z
- failure_payload_captured: true
- bounded_repair_applied: true
- final_publish_pass: false
- hard_failure: true

## TEST 4 FORCED N8N PUBLISH FAILURE RERUN @ 2026-03-08T12:46:27.852Z
- failure_payload_captured: false
- bounded_repair_applied: false
- final_publish_pass: true
- hard_failure: false

## TEST 4 FORCED N8N PUBLISH FAILURE RERUN @ 2026-03-08T12:47:16.407Z
- failure_payload_captured: false
- bounded_repair_applied: false
- final_publish_pass: true
- hard_failure: false

## TEST 4 FORCED N8N PUBLISH FAILURE RERUN @ 2026-03-08T12:48:12.457Z
- failure_payload_captured: false
- bounded_repair_applied: false
- final_publish_pass: true
- hard_failure: false

## TEST 4 FORCED N8N PUBLISH FAILURE RERUN @ 2026-03-08T12:49:13.509Z
- failure_payload_captured: true
- bounded_repair_applied: true
- final_publish_pass: true
- hard_failure: false

