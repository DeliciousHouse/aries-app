import {
  evaluatePermissionDecision,
  getOperationPermissionRequirement,
  isKnownRole,
  type PermissionDecision,
  type Role
} from "./permission-check";
import { evaluateTenantBoundary } from "./tenant-guard";

export const SERVICE_ACTOR_BYPASS_TENANT_CLAIM_ROLES = [
  "platform_owner",
  "platform_operator",
  "automation_service",
  "security_auditor"
] as const;

export type AuthClaims = {
  sub?: string;
  role?: string;
  tenant_id?: string;
  scopes?: string[];
  actor_type?: string;
  session_id?: string;
};

export type RbacDecision = PermissionDecision;

function roleBypassesTenantClaim(role: Role): boolean {
  return (SERVICE_ACTOR_BYPASS_TENANT_CLAIM_ROLES as readonly string[]).includes(role);
}

function unknownRoleDecision(operationId: string): RbacDecision {
  return {
    allow: false,
    role: "tenant_viewer",
    operation_id: operationId,
    evaluated_permissions: [],
    matched_permissions: [],
    deny_reason: "unknown_role"
  };
}

export function evaluateRbac(input: {
  claims: AuthClaims;
  operationId: string;
  resourceTenantId?: string;
  resourceScope?: "tenant_data" | "tenant_artifacts" | "tenant_runtime_state" | "shared_control_plane";
  action?: string;
  artifactPath?: string;
}): RbacDecision {
  const role = input.claims.role;
  if (!role || !isKnownRole(role)) {
    return unknownRoleDecision(input.operationId);
  }

  const operation = getOperationPermissionRequirement(input.operationId);
  if (!operation) {
    return {
      allow: false,
      role,
      operation_id: input.operationId,
      evaluated_permissions: [],
      matched_permissions: [],
      deny_reason: "unknown_operation"
    };
  }

  const hasRequiredClaims = typeof input.claims.sub === "string" && input.claims.sub.length > 0;
  if (!hasRequiredClaims) {
    return {
      allow: false,
      role,
      operation_id: input.operationId,
      evaluated_permissions: [],
      matched_permissions: [],
      deny_reason: "missing_permission"
    };
  }

  if (operation.tenant_scope === "required") {
    const actorTenantId = input.claims.tenant_id;
    const resourceTenantId = input.resourceTenantId;

    if (!roleBypassesTenantClaim(role) && (!actorTenantId || actorTenantId.length === 0)) {
      return {
        allow: false,
        role,
        operation_id: input.operationId,
        evaluated_permissions: [],
        matched_permissions: [],
        deny_reason: "tenant_scope_mismatch"
      };
    }

    if (resourceTenantId) {
      const boundary = evaluateTenantBoundary({
        role,
        actorTenantId,
        resourceTenantId,
        resourceScope: input.resourceScope || "tenant_runtime_state",
        action: input.action || "read",
        artifactPath: input.artifactPath
      });

      if (boundary.decision === "deny") {
        return {
          allow: false,
          role,
          operation_id: input.operationId,
          evaluated_permissions: [],
          matched_permissions: [],
          deny_reason: "tenant_scope_mismatch"
        };
      }
    }
  }

  return evaluatePermissionDecision({ role, operationId: input.operationId });
}

export type RbacMiddlewareRequest = {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  params?: Record<string, string | undefined>;
  auth?: {
    claims?: AuthClaims;
  };
};

export type RbacMiddlewareResult = {
  ok: boolean;
  status: number;
  body: {
    allow: boolean;
    role: Role;
    operation_id: string;
    evaluated_permissions: string[];
    matched_permissions: string[];
    deny_reason: "unknown_role" | "missing_permission" | "tenant_scope_mismatch" | "unknown_operation" | null;
  };
};

export function createRbacMiddleware(config: {
  resolveOperationId: (req: RbacMiddlewareRequest) => string;
  resolveResourceTenantId?: (req: RbacMiddlewareRequest) => string | undefined;
  resolveResourceScope?: (
    req: RbacMiddlewareRequest
  ) => "tenant_data" | "tenant_artifacts" | "tenant_runtime_state" | "shared_control_plane";
  resolveAction?: (req: RbacMiddlewareRequest) => string;
}): (req: RbacMiddlewareRequest) => RbacMiddlewareResult {
  return (req) => {
    const decision = evaluateRbac({
      claims: req.auth?.claims || {},
      operationId: config.resolveOperationId(req),
      resourceTenantId: config.resolveResourceTenantId?.(req),
      resourceScope: config.resolveResourceScope?.(req),
      action: config.resolveAction?.(req)
    });

    return {
      ok: decision.allow,
      status: decision.allow ? 200 : 403,
      body: decision
    };
  };
}
