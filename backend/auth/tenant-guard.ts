const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}$/;

export const TENANT_SCOPED_ROLES = ["tenant_admin", "tenant_analyst", "tenant_viewer"] as const;
export const CROSS_TENANT_ALLOWED_ROLES = [
  "platform_owner",
  "platform_operator",
  "automation_service",
  "security_auditor"
] as const;

export type TenantBoundaryReasonCode =
  | "DEFAULT_DENY"
  | "MISSING_CONTEXT"
  | "INVALID_TENANT_ID"
  | "TENANT_MISMATCH"
  | "UNKNOWN_CONTEXT"
  | "RESOURCE_SCOPE_VIOLATION"
  | "PATH_BOUNDARY_VIOLATION"
  | "POLICY_NOT_SATISFIED";

export type TenantBoundaryDecision = {
  decision: "allow" | "deny";
  reason_code: TenantBoundaryReasonCode;
  audit_required: boolean;
};

export function isValidTenantId(value: unknown): value is string {
  return typeof value === "string" && TENANT_ID_PATTERN.test(value);
}

function hasPathViolation(artifactPath: string): boolean {
  const forbiddenPatterns = [/^\//, /^[A-Za-z]:\\/, /(^|\/)\.\.($|\/)/];
  return forbiddenPatterns.some((pattern) => pattern.test(artifactPath));
}

function roleInList(role: string, list: readonly string[]): boolean {
  return list.includes(role);
}

export function evaluateTenantBoundary(input: {
  role: string;
  actorTenantId?: string | null;
  resourceTenantId?: string | null;
  resourceScope?: "tenant_data" | "tenant_artifacts" | "tenant_runtime_state" | "shared_control_plane";
  action?: string;
  artifactPath?: string;
}): TenantBoundaryDecision {
  const scope = input.resourceScope;
  if (!scope) {
    return { decision: "deny", reason_code: "MISSING_CONTEXT", audit_required: true };
  }

  const knownScopes = ["tenant_data", "tenant_artifacts", "tenant_runtime_state", "shared_control_plane"];
  if (!knownScopes.includes(scope)) {
    return { decision: "deny", reason_code: "UNKNOWN_CONTEXT", audit_required: true };
  }

  if (!input.action || typeof input.action !== "string") {
    return { decision: "deny", reason_code: "MISSING_CONTEXT", audit_required: true };
  }

  if (scope === "shared_control_plane") {
    return { decision: "allow", reason_code: "DEFAULT_DENY", audit_required: false };
  }

  if (!isValidTenantId(input.actorTenantId) || !isValidTenantId(input.resourceTenantId)) {
    return { decision: "deny", reason_code: "INVALID_TENANT_ID", audit_required: true };
  }

  if (scope === "tenant_artifacts" && typeof input.artifactPath === "string" && hasPathViolation(input.artifactPath)) {
    return { decision: "deny", reason_code: "PATH_BOUNDARY_VIOLATION", audit_required: true };
  }

  if (input.actorTenantId !== input.resourceTenantId) {
    const crossTenantRole = roleInList(input.role, CROSS_TENANT_ALLOWED_ROLES);
    if (!crossTenantRole) {
      return { decision: "deny", reason_code: "TENANT_MISMATCH", audit_required: true };
    }
  }

  return { decision: "allow", reason_code: "DEFAULT_DENY", audit_required: false };
}

export type CrossTenantReasonCode =
  | "DEFAULT_DENY"
  | "MISSING_CONTEXT"
  | "UNKNOWN_CONTEXT"
  | "MISSING_JUSTIFICATION"
  | "INVALID_TIME_WINDOW"
  | "SCOPE_NOT_ELIGIBLE"
  | "POLICY_NOT_SATISFIED"
  | "RULE_CONSTRAINT_FAILED";

export type CrossTenantDecision = {
  decision: "allow" | "deny";
  matched_rule_id: "XTA-ALLOW-001" | "XTA-ALLOW-002" | "XTA-ALLOW-003" | "XTA-ALLOW-004" | null;
  reason_code: CrossTenantReasonCode;
};

export function evaluateCrossTenantAccess(input: {
  actor_type?: "tenant_user" | "tenant_service" | "platform_operator" | "platform_automation";
  actor_tenant_id?: string;
  target_tenant_id?: string;
  operation_name?: "read_metadata" | "read_aggregated_metrics" | "transfer_artifact" | "delegate_job_execution";
  resource_scope?: "tenant_metadata" | "tenant_metrics_aggregate" | "tenant_artifact_manifest" | "tenant_job_control";
  ticket_id?: string;
  start_at?: string;
  end_at?: string;
  payload_fields?: string[];
  requested_action?: string;
}): CrossTenantDecision {
  const required = [
    input.actor_type,
    input.actor_tenant_id,
    input.target_tenant_id,
    input.operation_name,
    input.resource_scope,
    input.start_at,
    input.end_at
  ];

  if (required.some((v) => !v)) {
    return { decision: "deny", matched_rule_id: null, reason_code: "MISSING_CONTEXT" };
  }

  if (input.actor_tenant_id === input.target_tenant_id) {
    return { decision: "deny", matched_rule_id: null, reason_code: "POLICY_NOT_SATISFIED" };
  }

  if (!input.ticket_id) {
    return { decision: "deny", matched_rule_id: null, reason_code: "MISSING_JUSTIFICATION" };
  }

  const start = new Date(input.start_at as string);
  const end = new Date(input.end_at as string);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return { decision: "deny", matched_rule_id: null, reason_code: "INVALID_TIME_WINDOW" };
  }

  const payloadFields = input.payload_fields || [];

  if (
    input.actor_type === "platform_operator" &&
    input.operation_name === "read_metadata" &&
    input.resource_scope === "tenant_metadata"
  ) {
    const prohibited = ["secrets", "credentials", "private_content"];
    if (payloadFields.some((f) => prohibited.includes(f))) {
      return { decision: "deny", matched_rule_id: null, reason_code: "RULE_CONSTRAINT_FAILED" };
    }
    if ((end.getTime() - start.getTime()) / 60000 > 120) {
      return { decision: "deny", matched_rule_id: null, reason_code: "RULE_CONSTRAINT_FAILED" };
    }
    return { decision: "allow", matched_rule_id: "XTA-ALLOW-001", reason_code: "DEFAULT_DENY" };
  }

  if (
    input.actor_type === "platform_automation" &&
    input.operation_name === "read_aggregated_metrics" &&
    input.resource_scope === "tenant_metrics_aggregate"
  ) {
    const prohibited = ["row_level_records", "identifiers"];
    if (payloadFields.some((f) => prohibited.includes(f))) {
      return { decision: "deny", matched_rule_id: null, reason_code: "RULE_CONSTRAINT_FAILED" };
    }
    if ((end.getTime() - start.getTime()) / 60000 > 30) {
      return { decision: "deny", matched_rule_id: null, reason_code: "RULE_CONSTRAINT_FAILED" };
    }
    return { decision: "allow", matched_rule_id: "XTA-ALLOW-002", reason_code: "DEFAULT_DENY" };
  }

  if (
    input.actor_type === "tenant_service" &&
    input.operation_name === "transfer_artifact" &&
    input.resource_scope === "tenant_artifact_manifest"
  ) {
    const prohibited = ["artifact_body", "embedded_secrets"];
    const allowedPayloadClasses = ["manifest", "checksum", "lineage"];
    if (payloadFields.some((f) => prohibited.includes(f))) {
      return { decision: "deny", matched_rule_id: null, reason_code: "RULE_CONSTRAINT_FAILED" };
    }
    if (payloadFields.length > 0 && payloadFields.some((f) => !allowedPayloadClasses.includes(f))) {
      return { decision: "deny", matched_rule_id: null, reason_code: "RULE_CONSTRAINT_FAILED" };
    }
    if ((end.getTime() - start.getTime()) / 60000 > 240) {
      return { decision: "deny", matched_rule_id: null, reason_code: "RULE_CONSTRAINT_FAILED" };
    }
    return { decision: "allow", matched_rule_id: "XTA-ALLOW-003", reason_code: "DEFAULT_DENY" };
  }

  if (
    input.actor_type === "platform_operator" &&
    input.operation_name === "delegate_job_execution" &&
    input.resource_scope === "tenant_job_control"
  ) {
    const allowedActions = ["pause", "resume", "cancel"];
    if (input.requested_action && !allowedActions.includes(input.requested_action)) {
      return { decision: "deny", matched_rule_id: null, reason_code: "RULE_CONSTRAINT_FAILED" };
    }
    if ((end.getTime() - start.getTime()) / 60000 > 60) {
      return { decision: "deny", matched_rule_id: null, reason_code: "RULE_CONSTRAINT_FAILED" };
    }
    return { decision: "allow", matched_rule_id: "XTA-ALLOW-004", reason_code: "DEFAULT_DENY" };
  }

  return { decision: "deny", matched_rule_id: null, reason_code: "DEFAULT_DENY" };
}
