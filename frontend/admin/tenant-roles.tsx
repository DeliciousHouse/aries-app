"use client";

import { useMemo, useState } from 'react';

type RoleId =
  | 'platform_owner'
  | 'platform_operator'
  | 'tenant_admin'
  | 'tenant_analyst'
  | 'tenant_viewer'
  | 'automation_service'
  | 'security_auditor';

type PermissionId =
  | 'onboarding.start'
  | 'onboarding.status.read'
  | 'marketing.job.start'
  | 'marketing.job.status.read'
  | 'marketing.job.approve'
  | 'video.job.start'
  | 'video.job.status.read'
  | 'video.job.approve'
  | 'runtime.artifact.read'
  | 'runtime.artifact.write'
  | 'workflow.invoke'
  | 'workflow.resume'
  | 'audit.log.read'
  | 'rbac.policy.manage';

type TenantRole = 'tenant_admin' | 'tenant_analyst' | 'tenant_viewer';

type RolePermissionDecision = {
  allow: boolean;
  role: RoleId;
  operation_id: string;
  evaluated_permissions: string[];
  matched_permissions: string[];
  deny_reason: 'unknown_role' | 'missing_permission' | 'tenant_scope_mismatch' | 'unknown_operation' | null;
};

const roleGrants: Record<RoleId, PermissionId[]> = {
  platform_owner: [
    'onboarding.start',
    'onboarding.status.read',
    'marketing.job.start',
    'marketing.job.status.read',
    'marketing.job.approve',
    'video.job.start',
    'video.job.status.read',
    'video.job.approve',
    'runtime.artifact.read',
    'runtime.artifact.write',
    'workflow.invoke',
    'workflow.resume',
    'audit.log.read',
    'rbac.policy.manage'
  ],
  platform_operator: [
    'onboarding.status.read',
    'marketing.job.start',
    'marketing.job.status.read',
    'marketing.job.approve',
    'video.job.start',
    'video.job.status.read',
    'video.job.approve',
    'runtime.artifact.read',
    'runtime.artifact.write',
    'workflow.invoke',
    'workflow.resume',
    'audit.log.read'
  ],
  tenant_admin: [
    'onboarding.start',
    'onboarding.status.read',
    'marketing.job.start',
    'marketing.job.status.read',
    'marketing.job.approve',
    'video.job.start',
    'video.job.status.read',
    'video.job.approve',
    'runtime.artifact.read'
  ],
  tenant_analyst: [
    'onboarding.start',
    'onboarding.status.read',
    'marketing.job.start',
    'marketing.job.status.read',
    'video.job.start',
    'video.job.status.read',
    'runtime.artifact.read'
  ],
  tenant_viewer: [
    'onboarding.status.read',
    'marketing.job.status.read',
    'video.job.status.read',
    'runtime.artifact.read'
  ],
  automation_service: [
    'onboarding.start',
    'onboarding.status.read',
    'marketing.job.start',
    'marketing.job.status.read',
    'marketing.job.approve',
    'video.job.start',
    'video.job.status.read',
    'video.job.approve',
    'runtime.artifact.read',
    'runtime.artifact.write',
    'workflow.invoke',
    'workflow.resume',
    'audit.log.read'
  ],
  security_auditor: [
    'onboarding.status.read',
    'marketing.job.status.read',
    'video.job.status.read',
    'runtime.artifact.read',
    'audit.log.read'
  ]
};

const operationPermissionMap: Record<string, PermissionId[]> = {
  onboardingStart: ['onboarding.start'],
  onboardingStatusByTenant: ['onboarding.status.read'],
  postMarketingJobs: ['marketing.job.start'],
  getMarketingJobById: ['marketing.job.status.read'],
  postMarketingJobApprove: ['marketing.job.approve'],
  startVideoJob: ['video.job.start'],
  getVideoJobStatus: ['video.job.status.read'],
  approveVideoJob: ['video.job.approve'],
  tenantAdminInviteMember: ['rbac.policy.manage'],
  tenantAdminUpdateMemberRole: ['rbac.policy.manage'],
  tenantAdminUpdateSettings: ['rbac.policy.manage']
};

const tenantScopedOperations = new Set<string>([
  'onboardingStart',
  'onboardingStatusByTenant',
  'postMarketingJobs',
  'getMarketingJobById',
  'postMarketingJobApprove',
  'startVideoJob',
  'getVideoJobStatus',
  'approveVideoJob',
  'tenantAdminInviteMember',
  'tenantAdminUpdateMemberRole',
  'tenantAdminUpdateSettings'
]);

function evaluateAccess(role: RoleId, operationId: string, tenantMatches: boolean): RolePermissionDecision {
  const required = operationPermissionMap[operationId];

  if (!required) {
    return {
      allow: false,
      role,
      operation_id: operationId,
      evaluated_permissions: roleGrants[role],
      matched_permissions: [],
      deny_reason: 'unknown_operation'
    };
  }

  if ((['tenant_admin', 'tenant_analyst', 'tenant_viewer'] as TenantRole[]).includes(role as TenantRole)) {
    if (tenantScopedOperations.has(operationId) && !tenantMatches) {
      return {
        allow: false,
        role,
        operation_id: operationId,
        evaluated_permissions: roleGrants[role],
        matched_permissions: [],
        deny_reason: 'tenant_scope_mismatch'
      };
    }
  }

  const matched = required.filter((permission) => roleGrants[role].includes(permission));
  if (matched.length === 0) {
    return {
      allow: false,
      role,
      operation_id: operationId,
      evaluated_permissions: roleGrants[role],
      matched_permissions: [],
      deny_reason: 'missing_permission'
    };
  }

  return {
    allow: true,
    role,
    operation_id: operationId,
    evaluated_permissions: roleGrants[role],
    matched_permissions: matched,
    deny_reason: null
  };
}

export default function TenantRolesScreen(): JSX.Element {
  const [role, setRole] = useState<RoleId>('tenant_admin');
  const [operationId, setOperationId] = useState('tenantAdminInviteMember');
  const [tenantMatches, setTenantMatches] = useState(true);

  const decision = useMemo(
    () => evaluateAccess(role, operationId.trim(), tenantMatches),
    [role, operationId, tenantMatches]
  );

  const operations = Object.keys(operationPermissionMap);

  return (
    <section>
      <h1>Tenant Role & Permission Matrix</h1>
      <p>Scaffold aligned to role_permission_contract.v1 and rbac_matrix.v1.</p>

      <div>
        <label htmlFor="role_id">role</label>
        <select id="role_id" value={role} onChange={(event) => setRole(event.target.value as RoleId)}>
          {Object.keys(roleGrants).map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="operation_id">operation_id</label>
        <select id="operation_id" value={operationId} onChange={(event) => setOperationId(event.target.value)}>
          {operations.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="tenant_matches">
          <input
            id="tenant_matches"
            type="checkbox"
            checked={tenantMatches}
            onChange={(event) => setTenantMatches(event.target.checked)}
          />
          tenant_id matches resource tenant_id
        </label>
      </div>

      <h2>Decision</h2>
      <pre>{JSON.stringify(decision, null, 2)}</pre>

      <h2>Role grants</h2>
      <pre>{JSON.stringify(roleGrants, null, 2)}</pre>
    </section>
  );
}
