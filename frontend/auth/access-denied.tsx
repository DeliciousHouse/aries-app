"use client";

const roleCatalog = [
  'platform_owner',
  'platform_operator',
  'tenant_admin',
  'tenant_analyst',
  'tenant_viewer',
  'automation_service',
  'security_auditor'
] as const;

type KnownRole = (typeof roleCatalog)[number];

type RolePermissionDenyReason = 'unknown_role' | 'missing_permission' | 'tenant_scope_mismatch' | 'unknown_operation';
type TenantBoundaryDenyReason =
  | 'DEFAULT_DENY'
  | 'MISSING_CONTEXT'
  | 'INVALID_TENANT_ID'
  | 'TENANT_MISMATCH'
  | 'UNKNOWN_CONTEXT'
  | 'RESOURCE_SCOPE_VIOLATION'
  | 'PATH_BOUNDARY_VIOLATION'
  | 'POLICY_NOT_SATISFIED';
type CrossTenantDenyReason =
  | 'DEFAULT_DENY'
  | 'MISSING_CONTEXT'
  | 'UNKNOWN_CONTEXT'
  | 'MISSING_JUSTIFICATION'
  | 'INVALID_TIME_WINDOW'
  | 'SCOPE_NOT_ELIGIBLE'
  | 'POLICY_NOT_SATISFIED'
  | 'RULE_CONSTRAINT_FAILED';

type AccessDenyReason = RolePermissionDenyReason | TenantBoundaryDenyReason | CrossTenantDenyReason;

interface AccessDecision {
  allow: boolean;
  role: KnownRole;
  operation_id: string;
  evaluated_permissions: string[];
  matched_permissions: string[];
  deny_reason: RolePermissionDenyReason | null;
}

function parseSearchParams(): URLSearchParams {
  if (typeof window === 'undefined') {
    return new URLSearchParams();
  }
  return new URLSearchParams(window.location.search);
}

export default function AccessDeniedScreen(): JSX.Element {
  const params = parseSearchParams();

  const role = params.get('role') as KnownRole | null;
  const operationId = params.get('operation_id');
  const denyReason = params.get('deny_reason') as AccessDenyReason | null;

  const evaluatedPermissions = (params.get('evaluated_permissions') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const matchedPermissions = (params.get('matched_permissions') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const fallbackDecision: AccessDecision = {
    allow: false,
    role: roleCatalog.includes((role ?? '') as KnownRole) ? (role as KnownRole) : 'tenant_viewer',
    operation_id: operationId ?? 'unknown_operation',
    evaluated_permissions: evaluatedPermissions,
    matched_permissions: matchedPermissions,
    deny_reason:
      denyReason === 'unknown_role' ||
      denyReason === 'missing_permission' ||
      denyReason === 'tenant_scope_mismatch' ||
      denyReason === 'unknown_operation'
        ? denyReason
        : null
  };

  return (
    <section>
      <h1>Access denied</h1>
      <p>Fail-closed authorization surface for role/permission and tenant-boundary denials.</p>

      <p>
        decision: <strong>deny</strong>
      </p>
      <p>allow: {String(fallbackDecision.allow)}</p>
      <p>role: {fallbackDecision.role}</p>
      <p>operation_id: {fallbackDecision.operation_id}</p>
      <p>deny_reason: {denyReason ?? fallbackDecision.deny_reason ?? 'DEFAULT_DENY'}</p>

      <h2>evaluated_permissions</h2>
      {fallbackDecision.evaluated_permissions.length > 0 ? (
        <ul>
          {fallbackDecision.evaluated_permissions.map((permission) => (
            <li key={permission}>{permission}</li>
          ))}
        </ul>
      ) : (
        <p>none</p>
      )}

      <h2>matched_permissions</h2>
      {fallbackDecision.matched_permissions.length > 0 ? (
        <ul>
          {fallbackDecision.matched_permissions.map((permission) => (
            <li key={permission}>{permission}</li>
          ))}
        </ul>
      ) : (
        <p>none</p>
      )}

      <details>
        <summary>Known deny reason codes in frozen contracts</summary>
        <pre>
{JSON.stringify(
  {
    role_permission_contract: ['unknown_role', 'missing_permission', 'tenant_scope_mismatch', 'unknown_operation'],
    tenant_boundary_contract: [
      'DEFAULT_DENY',
      'MISSING_CONTEXT',
      'INVALID_TENANT_ID',
      'TENANT_MISMATCH',
      'UNKNOWN_CONTEXT',
      'RESOURCE_SCOPE_VIOLATION',
      'PATH_BOUNDARY_VIOLATION',
      'POLICY_NOT_SATISFIED'
    ],
    cross_tenant_access_rules: [
      'DEFAULT_DENY',
      'MISSING_CONTEXT',
      'UNKNOWN_CONTEXT',
      'MISSING_JUSTIFICATION',
      'INVALID_TIME_WINDOW',
      'SCOPE_NOT_ELIGIBLE',
      'POLICY_NOT_SATISFIED',
      'RULE_CONSTRAINT_FAILED'
    ]
  },
  null,
  2
)}
        </pre>
      </details>
    </section>
  );
}
