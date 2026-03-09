export const ROLES = [
  "platform_owner",
  "platform_operator",
  "tenant_admin",
  "tenant_analyst",
  "tenant_viewer",
  "automation_service",
  "security_auditor"
] as const;

export const PERMISSIONS = [
  "onboarding.start",
  "onboarding.status.read",
  "marketing.job.start",
  "marketing.job.status.read",
  "marketing.job.approve",
  "video.job.start",
  "video.job.status.read",
  "video.job.approve",
  "runtime.artifact.read",
  "runtime.artifact.write",
  "workflow.invoke",
  "workflow.resume",
  "audit.log.read",
  "rbac.policy.manage"
] as const;

export type Role = (typeof ROLES)[number];
export type Permission = (typeof PERMISSIONS)[number];

export type OperationPermissionRequirement = {
  operation_id: string;
  method: string;
  path: string;
  required_any_permissions: Permission[];
  tenant_scope: "required";
};

export type PermissionDecision = {
  allow: boolean;
  role: Role;
  operation_id: string;
  evaluated_permissions: Permission[];
  matched_permissions: Permission[];
  deny_reason: "unknown_role" | "missing_permission" | "tenant_scope_mismatch" | "unknown_operation" | null;
};

export const ROLE_GRANTS: Readonly<Record<Role, readonly Permission[]>> = {
  platform_owner: [
    "onboarding.start",
    "onboarding.status.read",
    "marketing.job.start",
    "marketing.job.status.read",
    "marketing.job.approve",
    "video.job.start",
    "video.job.status.read",
    "video.job.approve",
    "runtime.artifact.read",
    "runtime.artifact.write",
    "workflow.invoke",
    "workflow.resume",
    "audit.log.read",
    "rbac.policy.manage"
  ],
  platform_operator: [
    "onboarding.status.read",
    "marketing.job.start",
    "marketing.job.status.read",
    "marketing.job.approve",
    "video.job.start",
    "video.job.status.read",
    "video.job.approve",
    "runtime.artifact.read",
    "runtime.artifact.write",
    "workflow.invoke",
    "workflow.resume",
    "audit.log.read"
  ],
  tenant_admin: [
    "onboarding.start",
    "onboarding.status.read",
    "marketing.job.start",
    "marketing.job.status.read",
    "marketing.job.approve",
    "video.job.start",
    "video.job.status.read",
    "video.job.approve",
    "runtime.artifact.read"
  ],
  tenant_analyst: [
    "onboarding.start",
    "onboarding.status.read",
    "marketing.job.start",
    "marketing.job.status.read",
    "video.job.start",
    "video.job.status.read",
    "runtime.artifact.read"
  ],
  tenant_viewer: [
    "onboarding.status.read",
    "marketing.job.status.read",
    "video.job.status.read",
    "runtime.artifact.read"
  ],
  automation_service: [
    "onboarding.start",
    "onboarding.status.read",
    "marketing.job.start",
    "marketing.job.status.read",
    "marketing.job.approve",
    "video.job.start",
    "video.job.status.read",
    "video.job.approve",
    "runtime.artifact.read",
    "runtime.artifact.write",
    "workflow.invoke",
    "workflow.resume",
    "audit.log.read"
  ],
  security_auditor: [
    "onboarding.status.read",
    "marketing.job.status.read",
    "video.job.status.read",
    "runtime.artifact.read",
    "audit.log.read"
  ]
} as const;

export const OPERATION_PERMISSIONS: Readonly<Record<string, OperationPermissionRequirement>> = {
  onboardingStart: {
    operation_id: "onboardingStart",
    method: "POST",
    path: "/api/onboarding/start",
    required_any_permissions: ["onboarding.start"],
    tenant_scope: "required"
  },
  onboardingStatusByTenant: {
    operation_id: "onboardingStatusByTenant",
    method: "GET",
    path: "/api/onboarding/status/:tenantId",
    required_any_permissions: ["onboarding.status.read"],
    tenant_scope: "required"
  },
  postMarketingJobs: {
    operation_id: "postMarketingJobs",
    method: "POST",
    path: "/api/marketing/jobs",
    required_any_permissions: ["marketing.job.start"],
    tenant_scope: "required"
  },
  getMarketingJobById: {
    operation_id: "getMarketingJobById",
    method: "GET",
    path: "/api/marketing/jobs/:jobId",
    required_any_permissions: ["marketing.job.status.read"],
    tenant_scope: "required"
  },
  postMarketingJobApprove: {
    operation_id: "postMarketingJobApprove",
    method: "POST",
    path: "/api/marketing/jobs/:jobId/approve",
    required_any_permissions: ["marketing.job.approve"],
    tenant_scope: "required"
  },
  startVideoJob: {
    operation_id: "startVideoJob",
    method: "POST",
    path: "/api/video/jobs",
    required_any_permissions: ["video.job.start"],
    tenant_scope: "required"
  },
  getVideoJobStatus: {
    operation_id: "getVideoJobStatus",
    method: "GET",
    path: "/api/video/jobs/:videoJobId",
    required_any_permissions: ["video.job.status.read"],
    tenant_scope: "required"
  },
  approveVideoJob: {
    operation_id: "approveVideoJob",
    method: "POST",
    path: "/api/video/jobs/:videoJobId/approve",
    required_any_permissions: ["video.job.approve"],
    tenant_scope: "required"
  },
  tenantAdminInviteMember: {
    operation_id: "tenantAdminInviteMember",
    method: "POST",
    path: "/api/tenant-admin/members/invite",
    required_any_permissions: ["rbac.policy.manage"],
    tenant_scope: "required"
  },
  tenantAdminUpdateMemberRole: {
    operation_id: "tenantAdminUpdateMemberRole",
    method: "PATCH",
    path: "/api/tenant-admin/members/role",
    required_any_permissions: ["rbac.policy.manage"],
    tenant_scope: "required"
  },
  tenantAdminUpdateSettings: {
    operation_id: "tenantAdminUpdateSettings",
    method: "PATCH",
    path: "/api/tenant-admin/settings",
    required_any_permissions: ["rbac.policy.manage"],
    tenant_scope: "required"
  }
} as const;

export function isKnownRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function getRolePermissions(role: Role): readonly Permission[] {
  return ROLE_GRANTS[role] || [];
}

export function getOperationPermissionRequirement(operationId: string): OperationPermissionRequirement | null {
  return OPERATION_PERMISSIONS[operationId] || null;
}

export function evaluatePermissionDecision(input: {
  role: string;
  operationId: string;
}): PermissionDecision {
  const operation = getOperationPermissionRequirement(input.operationId);

  if (!isKnownRole(input.role)) {
    return {
      allow: false,
      role: "tenant_viewer",
      operation_id: input.operationId,
      evaluated_permissions: [],
      matched_permissions: [],
      deny_reason: "unknown_role"
    };
  }

  if (!operation) {
    return {
      allow: false,
      role: input.role,
      operation_id: input.operationId,
      evaluated_permissions: [...getRolePermissions(input.role)],
      matched_permissions: [],
      deny_reason: "unknown_operation"
    };
  }

  const grantedPermissions = [...getRolePermissions(input.role)];
  const matchedPermissions = operation.required_any_permissions.filter((permission) =>
    grantedPermissions.includes(permission)
  );

  if (matchedPermissions.length === 0) {
    return {
      allow: false,
      role: input.role,
      operation_id: operation.operation_id,
      evaluated_permissions: grantedPermissions,
      matched_permissions: [],
      deny_reason: "missing_permission"
    };
  }

  return {
    allow: true,
    role: input.role,
    operation_id: operation.operation_id,
    evaluated_permissions: grantedPermissions,
    matched_permissions: matchedPermissions,
    deny_reason: null
  };
}
