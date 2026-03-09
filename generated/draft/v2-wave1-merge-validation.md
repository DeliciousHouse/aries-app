# V2-1 Wave 1 Merge Consistency Validation

- Status: **fail**
- Merge ready: **false**
- Wave 2 unblocked: **false**

## Check results
- field_type_conflicts: **pass**
- enum_conflicts: **fail**
- role_permission_mismatches: **fail**
- auth_session_policy_contradictions: **pass**
- tenant_boundary_contradictions: **pass**
- ui_references_defined: **fail**

## Blocking conflicts
1. `enum_conflict` — `auth_ui.shared_enums.mfa_method vs auth_api.status_vocabularies.challenge_type_values`
   - files: ./specs/auth_ui_contract.v1.json, ./specs/auth_api_contract.v1.json
   - details: `{"undefined_in_auth_api": ["email", "sms", "totp"]}`
2. `role_permission_mismatch` — `tenant_admin_ui.shared_enums.tenant_role`
   - files: ./specs/tenant_admin_ui_contract.v1.json, ./specs/rbac_matrix.v1.json
   - details: `{"undefined_roles_in_rbac": ["admin", "member", "owner", "viewer"]}`
3. `ui_reference_undefined` — `auth_ui.auth.sign_in.api_binding.operation_id`
   - files: ./specs/auth_ui_contract.v1.json, ./specs/auth_api_contract.v1.json
   - details: `{"undefined_operation_id": "authSignIn"}`
4. `ui_reference_undefined` — `auth_ui.auth.sign_in.api_binding.path`
   - files: ./specs/auth_ui_contract.v1.json, ./specs/auth_api_contract.v1.json
   - details: `{"undefined_path": "/api/auth/sign-in"}`
5. `ui_reference_undefined` — `auth_ui.auth.mfa_challenge.api_binding.operation_id`
   - files: ./specs/auth_ui_contract.v1.json, ./specs/auth_api_contract.v1.json
   - details: `{"undefined_operation_id": "authVerifyMfa"}`
6. `ui_reference_undefined` — `auth_ui.auth.mfa_challenge.api_binding.path`
   - files: ./specs/auth_ui_contract.v1.json, ./specs/auth_api_contract.v1.json
   - details: `{"undefined_path": "/api/auth/mfa/verify"}`
7. `ui_reference_undefined` — `tenant_admin_ui.tenant_admin.members.invite.api_binding.path`
   - files: ./specs/tenant_admin_ui_contract.v1.json, ./specs/role_permission_contract.v1.json
   - details: `{"undefined_path": "/api/tenant-admin/members/invite"}`
8. `ui_reference_undefined` — `tenant_admin_ui.tenant_admin.members.update_role.api_binding.path`
   - files: ./specs/tenant_admin_ui_contract.v1.json, ./specs/role_permission_contract.v1.json
   - details: `{"undefined_path": "/api/tenant-admin/members/role"}`
9. `ui_reference_undefined` — `tenant_admin_ui.tenant_admin.settings.update_profile.api_binding.path`
   - files: ./specs/tenant_admin_ui_contract.v1.json, ./specs/role_permission_contract.v1.json
   - details: `{"undefined_path": "/api/tenant-admin/settings"}`

## Inputs checked
- `./specs/auth_api_contract.v1.json`
- `./specs/auth_response_shapes.v1.json`
- `./specs/rbac_matrix.v1.json`
- `./specs/role_permission_contract.v1.json`
- `./specs/tenant_boundary_contract.v1.json`
- `./specs/cross_tenant_access_rules.v1.json`
- `./specs/session_security_policy.v1.json`
- `./specs/auth_session_contract.v1.json`
- `./specs/auth_ui_contract.v1.json`
- `./specs/tenant_admin_ui_contract.v1.json`
- `./specs/v2_auth_validation_gate_spec.v1.json`
- `./generated/draft/v2-auth-foundation-validation-plan.json`
