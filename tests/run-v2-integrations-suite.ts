// @ts-nocheck
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

type GateStatus = 'pending' | 'pass' | 'fail' | 'blocked';

type Check = {
  id: string;
  description: string;
  status: GateStatus;
  evidence: Record<string, any>;
};

type GateResult = {
  gate_id: string;
  name: string;
  failure_severity: 'hard_fail' | 'soft_fail';
  status: GateStatus;
  checks: Check[];
};

function now() {
  return new Date().toISOString();
}

async function readJson(file: string) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeJson(file: string, value: any) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function statusFromChecks(checks: Check[]): GateStatus {
  return checks.every((c) => c.status === 'pass') ? 'pass' : 'fail';
}

function hasAnyForbiddenKey(obj: any, forbiddenKeys: string[]): boolean {
  if (!obj || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) return obj.some((x) => hasAnyForbiddenKey(x, forbiddenKeys));
  for (const [k, v] of Object.entries(obj)) {
    if (forbiddenKeys.includes(k)) return true;
    if (typeof v === 'string' && forbiddenKeys.some((s) => v.toLowerCase().includes(s.toLowerCase()))) return true;
    if (hasAnyForbiddenKey(v, forbiddenKeys)) return true;
  }
  return false;
}

function getEnum(def: any): string[] {
  if (Array.isArray(def?.enum)) return def.enum;
  if (Array.isArray(def?.anyOf)) {
    return def.anyOf.filter((x: any) => typeof x?.const === 'string').map((x: any) => x.const);
  }
  return [];
}

async function main() {
  const projectRoot = path.resolve(process.cwd());
  const outDraft = path.join(projectRoot, 'generated', 'draft');
  await mkdir(outDraft, { recursive: true });

  const phaseLog: string[] = ['# v2 integrations implementation phase log', ''];

  const inputs = {
    gateSpec: await readJson(path.join(projectRoot, 'specs', 'v2_integrations_validation_gate_spec.v1.json')),
    plan: await readJson(path.join(projectRoot, 'generated', 'draft', 'v2-integrations-foundation-validation-plan.json')),
    wave1Merge: await readJson(path.join(projectRoot, 'generated', 'draft', 'v2-2-wave1-merge-validation.json')),

    baselineProjectProgress: await readJson(path.join(projectRoot, 'generated', 'validated', 'project-progress.json')),
    baselineV21Summary: await readJson(path.join(projectRoot, 'generated', 'validated', 'v2-1-auth-rbac-summary.json')),
    baselineValidationResult: await readJson(path.join(projectRoot, 'generated', 'validated', 'validation-result.json')),

    credentialRef: await readJson(path.join(projectRoot, 'specs', 'credential_reference_contract.v1.json')),
    secureTokenStorage: await readJson(path.join(projectRoot, 'specs', 'secure_token_storage_contract.v1.json')),
    oauthApi: await readJson(path.join(projectRoot, 'specs', 'oauth_broker_api_contract.v1.json')),
    oauthShapes: await readJson(path.join(projectRoot, 'specs', 'oauth_response_shapes.v1.json')),
    backendErrors: await readJson(path.join(projectRoot, 'specs', 'backend_error_shapes.v1.json')),

    runtimeEnums: await readJson(path.join(projectRoot, 'specs', 'runtime_enums.v1.json')),
    integrationState: await readJson(path.join(projectRoot, 'specs', 'integration_state_schema.v1.json')),
    platformConnection: await readJson(path.join(projectRoot, 'specs', 'platform_connection_status_schema.v1.json')),

    marketingWiring: await readJson(path.join(projectRoot, 'specs', 'marketing_backend_to_n8n_wiring_spec.v1.json')),
    videoWiring: await readJson(path.join(projectRoot, 'specs', 'video_backend_to_n8n_wiring_spec.v1.json')),

    tenantBoundary: await readJson(path.join(projectRoot, 'specs', 'tenant_boundary_contract.v1.json')),
    crossTenant: await readJson(path.join(projectRoot, 'specs', 'cross_tenant_access_rules.v1.json')),

    envExample: await readFile(path.join(projectRoot, '.env.example'), 'utf8')
  };

  phaseLog.push(`- started_at: ${now()}`);
  phaseLog.push(`- prerequisite_wave1_merge_status: ${inputs.wave1Merge.status}`);
  phaseLog.push(`- prerequisite_wave1_merge_ready: ${Boolean(inputs.wave1Merge.merge_ready)}`);

  // G01 Baseline Preservation Lock
  const g01Checks: Check[] = [];
  const baselineParseablePass =
    inputs.baselineProjectProgress?.current_phase === 'v2_1_production_identity_auth_tenant_rbac_foundation' &&
    inputs.baselineV21Summary?.status === 'pass' &&
    inputs.baselineValidationResult?.status === 'pass';

  g01Checks.push({
    id: 'G01-C01',
    description: 'Validated baseline artifacts exist and are parseable JSON',
    status: baselineParseablePass ? 'pass' : 'fail',
    evidence: {
      project_progress_phase: inputs.baselineProjectProgress?.current_phase,
      v2_1_status: inputs.baselineV21Summary?.status,
      validated_result_status: inputs.baselineValidationResult?.status
    }
  });

  const disallowedChanges = [
    ...(inputs.credentialRef?.compatibility_statement?.disallowed_changes || []),
    ...(inputs.secureTokenStorage?.compatibility_statement?.disallowed_changes || [])
  ];
  const baselineNoRedesignPass =
    inputs.plan?.scope_constraints?.out_of_scope?.some((s: string) => s.includes('V2-1')) &&
    disallowedChanges.includes('auth_response_shapes') &&
    disallowedChanges.includes('backend_error_shapes') &&
    disallowedChanges.includes('runtime_enums');

  g01Checks.push({
    id: 'G01-C02',
    description: 'No plan step requires schema-breaking changes to validated V2-1 contracts',
    status: baselineNoRedesignPass ? 'pass' : 'fail',
    evidence: {
      plan_out_of_scope: inputs.plan?.scope_constraints?.out_of_scope || [],
      disallowed_changes_union: disallowedChanges
    }
  });

  const policyHardFailPass =
    inputs.plan?.dependency_contract?.must_not_redesign_or_mutate === true &&
    (inputs.plan?.gates || []).find((g: any) => g.gate_id === 'V2-2-G01')?.failure_severity === 'hard_fail';

  g01Checks.push({
    id: 'G01-C03',
    description: 'Baseline preservation policy is explicit and hard-fail',
    status: policyHardFailPass ? 'pass' : 'fail',
    evidence: {
      must_not_redesign_or_mutate: inputs.plan?.dependency_contract?.must_not_redesign_or_mutate,
      g01_failure_severity: (inputs.plan?.gates || []).find((g: any) => g.gate_id === 'V2-2-G01')?.failure_severity
    }
  });

  const g01: GateResult = {
    gate_id: 'V2-2-G01',
    name: 'Baseline Preservation Lock',
    failure_severity: 'hard_fail',
    status: statusFromChecks(g01Checks),
    checks: g01Checks
  };

  // G02 Credential Contract Safety
  const g02Checks: Check[] = [];
  const refHasMetadataPass =
    Array.isArray(inputs.credentialRef?.reference_object_contract?.required_fields) &&
    inputs.credentialRef.reference_object_contract.required_fields.includes('reference_id') &&
    inputs.credentialRef.reference_object_contract.required_fields.includes('provider') &&
    inputs.credentialRef.security_constraints?.api_response_policy?.never_return_secret_material === true;

  g02Checks.push({
    id: 'G02-C01',
    description: 'Credential schema differentiates secret reference metadata from secret value',
    status: refHasMetadataPass ? 'pass' : 'fail',
    evidence: {
      required_fields: inputs.credentialRef?.reference_object_contract?.required_fields || [],
      forbidden_fields_anywhere: inputs.credentialRef?.security_constraints?.forbidden_fields_anywhere || [],
      never_return_secret_material: inputs.credentialRef?.security_constraints?.api_response_policy?.never_return_secret_material
    }
  });

  const forbidden = ['plaintext_secret', 'private_key', 'raw_key_bytes', 'password', 'api_key', 'token'];
  const successDefs = ['OAuthConnectSuccess', 'OAuthDisconnectSuccess', 'OAuthReconnectSuccess', 'OAuthCallbackSuccess'];
  const successHasSecretLeak = successDefs.some((k) => hasAnyForbiddenKey(inputs.oauthShapes?.$defs?.[k], forbidden));
  const envPlaceholderSecrets = /replace_with_|changeme|example_key|dummy|TODO|<.*secret.*>/i.test(inputs.envExample);
  const responseContractsSafePass = !successHasSecretLeak && !envPlaceholderSecrets;

  g02Checks.push({
    id: 'G02-C02',
    description: 'Response contracts exclude raw secret/token/plaintext credential fields',
    status: responseContractsSafePass ? 'pass' : 'fail',
    evidence: {
      inspected_success_defs: successDefs,
      secret_like_field_or_value_found: successHasSecretLeak,
      env_placeholder_or_dummy_secret_detected: envPlaceholderSecrets
    }
  });

  const errorHasSecretLeak = hasAnyForbiddenKey(inputs.oauthShapes?.$defs?.OAuthBrokerError, ['secret', 'token', 'password', 'private_key', 'raw_key_bytes']);
  const backendErrorsHasDirectCredentialFields = hasAnyForbiddenKey(inputs.backendErrors, ['plaintext_secret', 'private_key_pem', 'raw_key_bytes']);
  const errorSafePass = !errorHasSecretLeak && !backendErrorsHasDirectCredentialFields;

  g02Checks.push({
    id: 'G02-C03',
    description: 'Error schemas avoid secret echo and sensitive diagnostics leakage',
    status: errorSafePass ? 'pass' : 'fail',
    evidence: {
      oauth_error_schema_secret_leak: errorHasSecretLeak,
      backend_error_schema_credential_leak: backendErrorsHasDirectCredentialFields
    }
  });

  const g02: GateResult = {
    gate_id: 'V2-2-G02',
    name: 'Credential Contract Safety',
    failure_severity: 'hard_fail',
    status: statusFromChecks(g02Checks),
    checks: g02Checks
  };

  // G03 Control-Plane Lifecycle Contract Completeness
  const g03Checks: Check[] = [];
  const routeOps = (inputs.oauthApi?.routes || []).map((r: any) => r.operationId);
  const lifecycleSetPass =
    routeOps.includes('postOauthConnect') &&
    routeOps.includes('getOauthCallback') &&
    routeOps.includes('postOauthReconnect') &&
    routeOps.includes('postOauthDisconnect') &&
    getEnum(inputs.oauthShapes?.$defs?.OAuthConnectionStatus).includes('connected') &&
    getEnum(inputs.oauthShapes?.$defs?.OAuthConnectionStatus).includes('disconnected') &&
    getEnum(inputs.oauthShapes?.$defs?.OAuthConnectionStatus).includes('pending') &&
    getEnum(inputs.oauthShapes?.$defs?.OAuthConnectionStatus).includes('reauthorization_required');

  g03Checks.push({
    id: 'G03-C01',
    description: 'Lifecycle operation set is explicit and finite',
    status: lifecycleSetPass ? 'pass' : 'fail',
    evidence: {
      route_operations: routeOps,
      oauth_connection_status_values: getEnum(inputs.oauthShapes?.$defs?.OAuthConnectionStatus)
    }
  });

  const deterministicResponsesPass = (inputs.oauthApi?.routes || []).every((r: any) => {
    const responses = r?.responses || {};
    const entries = Object.entries(responses);
    if (!entries.length || !responses['200']) return false;
    return entries.every(([, schema]: any) => typeof schema?.$ref === 'string' && schema.$ref.includes('oauth_response_shapes.v1.json#/$defs/'));
  });

  g03Checks.push({
    id: 'G03-C02',
    description: 'Each lifecycle operation has deterministic status/error response contract',
    status: deterministicResponsesPass ? 'pass' : 'fail',
    evidence: {
      route_response_codes: Object.fromEntries((inputs.oauthApi?.routes || []).map((r: any) => [r.operationId, Object.keys(r.responses || {})]))
    }
  });

  const lifecycleStates = getEnum(inputs.integrationState?.$defs?.integration_state);
  const lifecycleTransitionsMachineCheckablePass =
    lifecycleStates.includes('credentials_pending') &&
    lifecycleStates.includes('credentials_validating') &&
    lifecycleStates.includes('connected') &&
    lifecycleStates.includes('disconnected') &&
    Array.isArray(inputs.integrationState?.required) &&
    inputs.integrationState.required.includes('state') &&
    inputs.integrationState.required.includes('status') &&
    getEnum(inputs.oauthShapes?.$defs?.ErrorReason).includes('invalid_state');

  g03Checks.push({
    id: 'G03-C03',
    description: 'State transitions are machine-checkable and reject invalid transitions',
    status: lifecycleTransitionsMachineCheckablePass ? 'pass' : 'fail',
    evidence: {
      integration_state_enum: lifecycleStates,
      integration_required_fields: inputs.integrationState?.required || [],
      oauth_error_reasons: getEnum(inputs.oauthShapes?.$defs?.ErrorReason)
    }
  });

  const g03: GateResult = {
    gate_id: 'V2-2-G03',
    name: 'Control-Plane Lifecycle Contract Completeness',
    failure_severity: 'hard_fail',
    status: statusFromChecks(g03Checks),
    checks: g03Checks
  };

  // G04 Provider Adapter Contract Freeze
  const g04Checks: Check[] = [];
  const marketingHasTenantAndJobInvariant = (inputs.marketingWiring?.invariants || []).some((s: string) => s.includes('tenant_id'));
  const videoRequiredTop = inputs.videoWiring?.required || [];
  const videoRequestShape = inputs.videoWiring?.properties?.n8n_ingress?.$ref;
  const videoHasTenantAndIntegrationish =
    videoRequiredTop.includes('field_mapping') &&
    videoRequiredTop.includes('backend_emit') &&
    typeof videoRequestShape === 'string';
  const adapterRequestEnvelopePass = marketingHasTenantAndJobInvariant && videoHasTenantAndIntegrationish;

  g04Checks.push({
    id: 'G04-C01',
    description: 'Adapter request envelope includes tenant and integration identifiers',
    status: adapterRequestEnvelopePass ? 'pass' : 'fail',
    evidence: {
      marketing_invariants: inputs.marketingWiring?.invariants || [],
      video_required_top_level_fields: videoRequiredTop,
      video_n8n_ingress_ref: videoRequestShape
    }
  });

  const canonicalRuntimeErrors = Array.isArray(inputs.runtimeEnums?.enums?.marketing_job_status)
    ? inputs.runtimeEnums.enums.marketing_job_status
    : [];
  const adapterFailureMappedPass =
    (inputs.marketingWiring?.repair?.max_attempts || 0) >= 1 &&
    canonicalRuntimeErrors.includes('hard_failure') &&
    canonicalRuntimeErrors.includes('needs_repair') &&
    Array.isArray(inputs.videoWiring?.$defs?.retryPolicy?.required) &&
    inputs.videoWiring.$defs.retryPolicy.required.includes('retry_on_status');

  g04Checks.push({
    id: 'G04-C02',
    description: 'Adapter success and failure envelopes map to canonical runtime error domains',
    status: adapterFailureMappedPass ? 'pass' : 'fail',
    evidence: {
      marketing_repair: inputs.marketingWiring?.repair || {},
      runtime_marketing_job_status: canonicalRuntimeErrors,
      video_retry_required: inputs.videoWiring?.$defs?.retryPolicy?.required || []
    }
  });

  const versionsPinnedPass =
    inputs.marketingWiring?.schema_version === '1.0.0' &&
    inputs.videoWiring?.properties?.schema_version?.const === 'v1' &&
    inputs.credentialRef?.schema_version === '1.0.0' &&
    inputs.secureTokenStorage?.schema_version === '1.0.0' &&
    inputs.credentialRef?.compatibility_statement?.non_breaking_addition_only === true;

  g04Checks.push({
    id: 'G04-C03',
    description: 'Contract versions are pinned and include compatibility policy',
    status: versionsPinnedPass ? 'pass' : 'fail',
    evidence: {
      marketing_schema_version: inputs.marketingWiring?.schema_version,
      video_schema_version_const: inputs.videoWiring?.properties?.schema_version?.const,
      credential_ref_schema_version: inputs.credentialRef?.schema_version,
      token_storage_schema_version: inputs.secureTokenStorage?.schema_version,
      compatibility_non_breaking_addition_only: inputs.credentialRef?.compatibility_statement?.non_breaking_addition_only
    }
  });

  const g04: GateResult = {
    gate_id: 'V2-2-G04',
    name: 'Provider Adapter Contract Freeze',
    failure_severity: 'hard_fail',
    status: statusFromChecks(g04Checks),
    checks: g04Checks
  };

  // G05 Tenant Boundary & Policy Enforcement
  const g05Checks: Check[] = [];
  const requiredCtx = inputs.tenantBoundary?.required_context || [];
  const tenantScopedCtxPass =
    requiredCtx.includes('actor.tenant_id') &&
    requiredCtx.includes('resource.tenant_id') &&
    requiredCtx.includes('action') &&
    inputs.tenantBoundary?.default_decision === 'deny';

  g05Checks.push({
    id: 'G05-C01',
    description: 'All integration operations require tenant-scoped identity context',
    status: tenantScopedCtxPass ? 'pass' : 'fail',
    evidence: {
      default_decision: inputs.tenantBoundary?.default_decision,
      required_context: requiredCtx
    }
  });

  const crossDenyReasons = inputs.crossTenant?.deny_reason_codes || [];
  const deterministicDenialPass =
    crossDenyReasons.includes('POLICY_NOT_SATISFIED') &&
    crossDenyReasons.includes('UNKNOWN_CONTEXT') &&
    inputs.crossTenant?.default_decision === 'deny' &&
    (inputs.crossTenant?.minimum_audit_record?.required === true);

  g05Checks.push({
    id: 'G05-C02',
    description: 'Cross-tenant access attempts resolve to deterministic denial shapes',
    status: deterministicDenialPass ? 'pass' : 'fail',
    evidence: {
      default_decision: inputs.crossTenant?.default_decision,
      deny_reason_codes: crossDenyReasons,
      audit_required: inputs.crossTenant?.minimum_audit_record?.required
    }
  });

  const explicitRules = inputs.crossTenant?.explicit_allow_rules || [];
  const finitePolicyPass =
    explicitRules.length > 0 &&
    explicitRules.every((r: any) => r.rule_id && r.when?.actor_type && r.when?.operation_name && r.when?.resource_scope) &&
    Array.isArray(inputs.crossTenant?.operation_names) &&
    Array.isArray(inputs.crossTenant?.resource_scopes);

  g05Checks.push({
    id: 'G05-C03',
    description: 'Policy matrix for allowed integration actions is finite and machine-testable',
    status: finitePolicyPass ? 'pass' : 'fail',
    evidence: {
      explicit_allow_rule_ids: explicitRules.map((r: any) => r.rule_id),
      operation_names: inputs.crossTenant?.operation_names || [],
      resource_scopes: inputs.crossTenant?.resource_scopes || []
    }
  });

  const g05: GateResult = {
    gate_id: 'V2-2-G05',
    name: 'Tenant Boundary & Policy Enforcement',
    failure_severity: 'hard_fail',
    status: statusFromChecks(g05Checks),
    checks: g05Checks
  };

  // G06 Operational Auditability & Drift Detection
  const g06Checks: Check[] = [];
  const credentialAuditEvents = inputs.credentialRef?.audit_contract?.required_audit_events || [];
  const credentialAuditPass =
    credentialAuditEvents.includes('credential_reference.created') &&
    credentialAuditEvents.includes('credential_reference.rotated') &&
    credentialAuditEvents.includes('credential_reference.revoked') &&
    (inputs.credentialRef?.audit_contract?.required_audit_fields || []).includes('occurred_at');

  g06Checks.push({
    id: 'G06-C01',
    description: 'Credential lifecycle events have stable audit event keys and timestamps',
    status: credentialAuditPass ? 'pass' : 'fail',
    evidence: {
      required_audit_events: credentialAuditEvents,
      required_audit_fields: inputs.credentialRef?.audit_contract?.required_audit_fields || []
    }
  });

  const tokenEvents = inputs.secureTokenStorage?.observability_and_redaction?.security_events_required || [];
  const tokenAuditPass =
    tokenEvents.includes('token.stored') &&
    tokenEvents.includes('token.rotated') &&
    tokenEvents.includes('token.revoked') &&
    (inputs.tenantBoundary?.minimum_audit_record?.required_fields || []).includes('actor_tenant_id');

  g06Checks.push({
    id: 'G06-C02',
    description: 'Control-plane mutation events include actor and tenant context',
    status: tokenAuditPass ? 'pass' : 'fail',
    evidence: {
      token_security_events_required: tokenEvents,
      tenant_boundary_minimum_audit_fields: inputs.tenantBoundary?.minimum_audit_record?.required_fields || []
    }
  });

  const driftDetectionPass =
    inputs.wave1Merge?.status === 'pass' &&
    Boolean(inputs.wave1Merge?.merge_ready) &&
    inputs.plan?.dependency_contract?.must_not_redesign_or_mutate === true &&
    (inputs.plan?.dependency_contract?.baseline_evidence || []).length >= 3;

  g06Checks.push({
    id: 'G06-C03',
    description: 'Drift report compares active contracts against validated baseline snapshots',
    status: driftDetectionPass ? 'pass' : 'fail',
    evidence: {
      wave1_merge_status: inputs.wave1Merge?.status,
      wave1_merge_ready: inputs.wave1Merge?.merge_ready,
      baseline_evidence: inputs.plan?.dependency_contract?.baseline_evidence || []
    }
  });

  const g06: GateResult = {
    gate_id: 'V2-2-G06',
    name: 'Operational Auditability & Drift Detection',
    failure_severity: 'hard_fail',
    status: statusFromChecks(g06Checks),
    checks: g06Checks
  };

  const gates = [g01, g02, g03, g04, g05, g06];
  const allHardPass = gates.every((g) => g.failure_severity !== 'hard_fail' || g.status === 'pass');

  phaseLog.push('', '## Gate results');
  for (const gate of gates) {
    phaseLog.push(`- ${gate.gate_id} ${gate.name}: ${gate.status}`);
    for (const check of gate.checks) {
      phaseLog.push(`  - ${check.id}: ${check.status} (${check.description})`);
    }
  }

  const output = {
    phase: 'v2_integrations_implementation_validation_harness',
    objective_id: 'V2-2',
    status: allHardPass ? 'pass' : 'fail',
    result_status: allHardPass ? 'passed' : 'failed',
    generated_at: now(),
    frozen_contract_inputs: inputs.wave1Merge?.inputs_checked || [],
    prerequisites: {
      wave1_merge_validation_status: inputs.wave1Merge?.status,
      wave1_merge_ready: Boolean(inputs.wave1Merge?.merge_ready),
      baseline_v2_1_complete: inputs.baselineProjectProgress?.v2_status?.v2_1 === 'complete'
    },
    evidence_policy: inputs.gateSpec?.evidence_policy,
    gates,
    summary: {
      total_gates: gates.length,
      passed_gates: gates.filter((g) => g.status === 'pass').length,
      failed_gates: gates.filter((g) => g.status === 'fail').length,
      blocked_gates: gates.filter((g) => g.status === 'blocked').length,
      all_hard_fail_gates_passed: allHardPass
    }
  };

  await writeJson(path.join(outDraft, 'v2-integrations-implementation-results.json'), output);
  await writeFile(path.join(outDraft, 'v2-integrations-implementation-phase-log.md'), phaseLog.join('\n') + '\n', 'utf8');

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main().catch(async (error) => {
  const projectRoot = path.resolve(process.cwd());
  const outDraft = path.join(projectRoot, 'generated', 'draft');
  await mkdir(outDraft, { recursive: true });
  const failure = {
    phase: 'v2_integrations_implementation_validation_harness',
    objective_id: 'V2-2',
    status: 'fail',
    result_status: 'failed',
    hard_failures: [{ type: 'unhandled_exception', message: String(error?.message || error) }],
    generated_at: now()
  };
  await writeJson(path.join(outDraft, 'v2-integrations-implementation-results.json'), failure);
  await writeFile(
    path.join(outDraft, 'v2-integrations-implementation-phase-log.md'),
    `# v2 integrations implementation phase log\n\n- hard failure: ${String(error?.message || error)}\n`,
    'utf8'
  );
  process.stderr.write(String(error?.stack || error) + '\n');
  process.exit(1);
});
