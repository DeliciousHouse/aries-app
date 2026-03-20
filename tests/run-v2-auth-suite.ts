// @ts-nocheck
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveProjectRoot } from './helpers/project-root';

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

function hasAnyCredentialField(obj: any, sensitiveKeys: string[]): boolean {
  if (!obj || typeof obj !== 'object') return false;
  if (Array.isArray(obj)) return obj.some((x) => hasAnyCredentialField(x, sensitiveKeys));
  for (const [k, v] of Object.entries(obj)) {
    if (sensitiveKeys.includes(k)) return true;
    if (hasAnyCredentialField(v, sensitiveKeys)) return true;
  }
  return false;
}

async function main() {
  const projectRoot = path.resolve(process.env.CODE_ROOT?.trim() || resolveProjectRoot(import.meta.url));
  const outDraft = path.join(projectRoot, 'generated', 'draft');
  await mkdir(outDraft, { recursive: true });

  const phaseLog: string[] = ['# v2 auth implementation phase log', ''];

  const inputs = {
    authApi: await readJson(path.join(projectRoot, 'specs', 'auth_api_contract.v1.json')),
    authShapes: await readJson(path.join(projectRoot, 'specs', 'auth_response_shapes.v1.json')),
    rbac: await readJson(path.join(projectRoot, 'specs', 'rbac_matrix.v1.json')),
    rolePerm: await readJson(path.join(projectRoot, 'specs', 'role_permission_contract.v1.json')),
    tenantBoundary: await readJson(path.join(projectRoot, 'specs', 'tenant_boundary_contract.v1.json')),
    crossTenant: await readJson(path.join(projectRoot, 'specs', 'cross_tenant_access_rules.v1.json')),
    sessionPolicy: await readJson(path.join(projectRoot, 'specs', 'session_security_policy.v1.json')),
    authSession: await readJson(path.join(projectRoot, 'specs', 'auth_session_contract.v1.json')),
    authUi: await readJson(path.join(projectRoot, 'specs', 'auth_ui_contract.v1.json')),
    tenantAdminUi: await readJson(path.join(projectRoot, 'specs', 'tenant_admin_ui_contract.v1.json')),
    gateSpec: await readJson(path.join(projectRoot, 'specs', 'v2_auth_validation_gate_spec.v1.json')),
    wave1Merge: await readJson(path.join(projectRoot, 'generated', 'draft', 'v2-wave1-merge-validation.json')),
    envExample: await readFile(path.join(projectRoot, '.env.example'), 'utf8')
  };

  phaseLog.push(`- started_at: ${now()}`);
  phaseLog.push(`- prerequisite_wave1_merge_status: ${inputs.wave1Merge.status}`);

  // G01
  const g01Checks: Check[] = [];
  const routes = inputs.authApi.routes || [];
  const routeCompletenessPass = routes.length > 0 && routes.every((r: any) => {
    const hasReq = r.method === 'GET' ? true : Boolean(r.requestSchemaRef);
    return hasReq && Boolean(r.responses) && Object.keys(r.responses).length > 0;
  });
  g01Checks.push({
    id: 'G01-C01',
    description: 'All auth endpoints have request/response schemas',
    status: routeCompletenessPass ? 'pass' : 'fail',
    evidence: { route_count: routes.length }
  });

  const gateSpecVersionPinned =
    inputs.gateSpec?.version === 'v1' ||
    inputs.gateSpec?.properties?.version?.const === 'v1';
  const versionPinnedPass = [
    inputs.authApi.schema_version,
    inputs.authShapes.schema_version,
    inputs.rbac.schema_version,
    inputs.rolePerm.schema_version,
    inputs.authSession.schema_version,
    inputs.sessionPolicy.schema_version
  ].every((v) => v === '1.0.0') && gateSpecVersionPinned;
  g01Checks.push({
    id: 'G01-C02',
    description: 'Schema versions are pinned and non-ambiguous',
    status: versionPinnedPass ? 'pass' : 'fail',
    evidence: {
      schema_versions: {
        auth_api: inputs.authApi.schema_version,
        auth_shapes: inputs.authShapes.schema_version,
        rbac: inputs.rbac.schema_version,
        role_permission: inputs.rolePerm.schema_version,
        auth_session: inputs.authSession.schema_version,
        session_policy: inputs.sessionPolicy.schema_version,
        gate_spec: inputs.gateSpec.version || inputs.gateSpec?.properties?.version?.const
      }
    }
  });

  const defs = inputs.authShapes.$defs || {};
  const requiredAndEnumPass =
    Array.isArray(defs.AuthStatus?.enum) && defs.AuthStatus.enum.length > 0 &&
    Array.isArray(defs.SessionStatus?.enum) && defs.SessionStatus.enum.length > 0 &&
    Array.isArray(defs.StartSessionRequest?.required) && defs.StartSessionRequest.required.length >= 3 &&
    Array.isArray(defs.AuthError?.required) && defs.AuthError.required.includes('reason');
  g01Checks.push({
    id: 'G01-C03',
    description: 'Required fields and enum domains are declared',
    status: requiredAndEnumPass ? 'pass' : 'fail',
    evidence: {
      auth_status_values: defs.AuthStatus?.enum || [],
      session_status_values: defs.SessionStatus?.enum || [],
      start_session_required: defs.StartSessionRequest?.required || [],
      auth_error_required: defs.AuthError?.required || []
    }
  });

  const g01: GateResult = {
    gate_id: 'V2-1-G01',
    name: 'Auth Contract Completeness',
    failure_severity: 'hard_fail',
    status: statusFromChecks(g01Checks),
    checks: g01Checks
  };

  // G02
  const sensitive = ['password', 'challenge_value', 'verification_code', 'secret', 'api_key'];
  const successDefs = ['StartSessionSuccess', 'GetSessionSuccess', 'RefreshSessionSuccess', 'RevokeSessionSuccess'];
  const successLeak = successDefs.some((k) => hasAnyCredentialField(defs[k], sensitive));
  const g02c1: Check = {
    id: 'G02-C01',
    description: 'Credential fields are absent from success payload schemas',
    status: successLeak ? 'fail' : 'pass',
    evidence: { inspected_defs: successDefs, credential_field_found: successLeak }
  };

  const hasPlaceholderSecrets = /replace_with_|changeme|example_key|dummy/i.test(inputs.envExample);
  const g02c2: Check = {
    id: 'G02-C02',
    description: 'Config manifest uses non-placeholder secret source values',
    status: hasPlaceholderSecrets ? 'fail' : 'pass',
    evidence: { placeholder_detected: hasPlaceholderSecrets }
  };

  const authErrorLeak = hasAnyCredentialField(defs.AuthError, sensitive.filter((k) => k !== 'api_key'));
  const g02c3: Check = {
    id: 'G02-C03',
    description: 'Auth error payload schema does not echo credential material',
    status: authErrorLeak ? 'fail' : 'pass',
    evidence: { auth_error_contains_sensitive_keys: authErrorLeak }
  };

  const g02: GateResult = {
    gate_id: 'V2-1-G02',
    name: 'Credential Handling Guardrails',
    failure_severity: 'hard_fail',
    status: statusFromChecks([g02c1, g02c2, g02c3]),
    checks: [g02c1, g02c2, g02c3]
  };

  // G03
  const apiLifecycle = inputs.authApi.status_vocabularies?.session_status_values || [];
  const shapeLifecycle = defs.SessionStatus?.enum || [];
  const lifecyclePass = ['active', 'expired', 'revoked', 'pending'].every((s) => apiLifecycle.includes(s) && shapeLifecycle.includes(s));
  const g03c1: Check = {
    id: 'G03-C01',
    description: 'Lifecycle states/transitions are explicitly defined',
    status: lifecyclePass ? 'pass' : 'fail',
    evidence: { api_lifecycle: apiLifecycle, shape_lifecycle: shapeLifecycle }
  };

  const errorAny = defs.ErrorReason?.anyOf || [];
  const reasons = errorAny.filter((x: any) => typeof x?.const === 'string').map((x: any) => x.const);
  const revocationDistinctPass = reasons.includes('session_expired') && reasons.includes('session_revoked') && defs.RevokeSessionSuccess?.properties?.session_status?.const === 'revoked';
  const g03c2: Check = {
    id: 'G03-C02',
    description: 'Expiry and revocation outcomes are distinguishable',
    status: revocationDistinctPass ? 'pass' : 'fail',
    evidence: { error_reasons: reasons, revoke_status_const: defs.RevokeSessionSuccess?.properties?.session_status?.const }
  };

  const refreshRoute = routes.find((r: any) => r.operationId === 'postAuthSessionRefresh');
  const refreshDenialPass = Boolean(refreshRoute?.responses?.['401']) && reasons.includes('refresh_denied') && reasons.includes('invalid_session');
  const g03c3: Check = {
    id: 'G03-C03',
    description: 'Refresh contract includes invalid/expired denial semantics',
    status: refreshDenialPass ? 'pass' : 'fail',
    evidence: { refresh_response_codes: Object.keys(refreshRoute?.responses || {}), includes_refresh_denied: reasons.includes('refresh_denied') }
  };

  const g03: GateResult = {
    gate_id: 'V2-1-G03',
    name: 'Session & Token Lifecycle Semantics',
    failure_severity: 'hard_fail',
    status: statusFromChecks([g03c1, g03c2, g03c3]),
    checks: [g03c1, g03c2, g03c3]
  };

  // G04
  const non200RefsAuthErrorPass = routes.every((r: any) => Object.entries(r.responses || {}).every(([code, val]: any) => {
    if (code === '200') return true;
    return typeof val?.$ref === 'string' && val.$ref.includes('#/$defs/AuthError');
  }));
  const g04c1: Check = {
    id: 'G04-C01',
    description: 'Auth denials use canonical AuthError schema',
    status: non200RefsAuthErrorPass ? 'pass' : 'fail',
    evidence: { routes_checked: routes.length }
  };

  const hasPatternReason = errorAny.some((x: any) => typeof x?.pattern === 'string');
  const finiteErrorDomainPass = !hasPatternReason;
  const g04c2: Check = {
    id: 'G04-C02',
    description: 'Error code domain is finite and documented',
    status: finiteErrorDomainPass ? 'pass' : 'fail',
    evidence: { has_pattern_based_reason_codes: hasPatternReason }
  };

  const statusMappingDeterministicPass = routes.every((r: any) => {
    const entries = Object.entries(r.responses || {});
    return entries.every(([, val]: any) => val && typeof val === 'object' && Object.keys(val).length === 1 && typeof val.$ref === 'string');
  });
  const g04c3: Check = {
    id: 'G04-C03',
    description: 'HTTP status to schema mapping is deterministic',
    status: statusMappingDeterministicPass ? 'pass' : 'fail',
    evidence: { deterministic_mapping: statusMappingDeterministicPass }
  };

  const g04: GateResult = {
    gate_id: 'V2-1-G04',
    name: 'Canonical Auth Failure Shapes',
    failure_severity: 'hard_fail',
    status: statusFromChecks([g04c1, g04c2, g04c3]),
    checks: [g04c1, g04c2, g04c3]
  };

  // G05
  const eventTypes = inputs.authSession.security_event_contract?.event_types || [];
  const reqEventFields = inputs.authSession.security_event_contract?.required_event_fields || [];
  const g05c1: Check = {
    id: 'G05-C01',
    description: 'Login success/failure event keys are defined',
    status: eventTypes.includes('auth.login.success') && eventTypes.includes('auth.login.failure') ? 'pass' : 'fail',
    evidence: { event_types: eventTypes }
  };

  const g05c2: Check = {
    id: 'G05-C02',
    description: 'Revocation events include actor and timestamp fields',
    status: reqEventFields.includes('occurred_at') && reqEventFields.includes('subject_id') ? 'pass' : 'fail',
    evidence: { required_event_fields: reqEventFields }
  };

  const sensitiveEventFields = ['access_token', 'refresh_token', 'password', 'secret', 'api_key'];
  const eventSafePass = sensitiveEventFields.every((f) => !reqEventFields.includes(f));
  const g05c3: Check = {
    id: 'G05-C03',
    description: 'Audit event schema avoids sensitive secret material',
    status: eventSafePass ? 'pass' : 'fail',
    evidence: { required_event_fields: reqEventFields }
  };

  const g05: GateResult = {
    gate_id: 'V2-1-G05',
    name: 'Auth Auditability Minimum',
    failure_severity: 'hard_fail',
    status: statusFromChecks([g05c1, g05c2, g05c3]),
    checks: [g05c1, g05c2, g05c3]
  };

  const gates = [g01, g02, g03, g04, g05];
  const hardFailGates = gates.filter((g) => g.failure_severity === 'hard_fail');
  const allHardPass = hardFailGates.every((g) => g.status === 'pass');
  const resultStatus = allHardPass ? 'passed' : 'failed';

  phaseLog.push('', '## Gate results');
  for (const gate of gates) {
    phaseLog.push(`- ${gate.gate_id} ${gate.name}: ${gate.status}`);
    for (const check of gate.checks) {
      phaseLog.push(`  - ${check.id}: ${check.status} (${check.description})`);
    }
  }

  const output = {
    phase: 'v2_auth_implementation_validation_harness',
    objective_id: 'V2-1',
    status: allHardPass ? 'pass' : 'fail',
    result_status: resultStatus,
    generated_at: now(),
    evidence_policy: inputs.gateSpec.evidence_policy,
    prerequisites: {
      wave1_merge_validation_status: inputs.wave1Merge.status,
      wave1_merge_ready: Boolean(inputs.wave1Merge.merge_ready)
    },
    gates,
    summary: {
      total_gates: gates.length,
      passed_gates: gates.filter((g) => g.status === 'pass').length,
      failed_gates: gates.filter((g) => g.status === 'fail').length,
      blocked_gates: gates.filter((g) => g.status === 'blocked').length,
      hard_fail_gates_passed: allHardPass
    }
  };

  await writeJson(path.join(outDraft, 'v2-auth-implementation-results.json'), output);
  await writeFile(path.join(outDraft, 'v2-auth-implementation-phase-log.md'), phaseLog.join('\n') + '\n', 'utf8');

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

main().catch(async (error) => {
  const projectRoot = path.resolve(process.env.CODE_ROOT?.trim() || resolveProjectRoot(import.meta.url));
  const outDraft = path.join(projectRoot, 'generated', 'draft');
  await mkdir(outDraft, { recursive: true });
  const failure = {
    phase: 'v2_auth_implementation_validation_harness',
    objective_id: 'V2-1',
    status: 'fail',
    result_status: 'failed',
    hard_failures: [{ type: 'unhandled_exception', message: String(error?.message || error) }],
    generated_at: now()
  };
  await writeJson(path.join(outDraft, 'v2-auth-implementation-results.json'), failure);
  await writeFile(path.join(outDraft, 'v2-auth-implementation-phase-log.md'), `# v2 auth implementation phase log\n\n- hard failure: ${String(error?.message || error)}\n`, 'utf8');
  process.stderr.write(String(error?.stack || error) + '\n');
  process.exit(1);
});
