# Tenant Workspace README

## Overview
Tenant acme is provisioned as single_user for phase tenant_provisioning_workspace.

## Workspace Layout
- workspaces/core
- workspaces/research
- workspaces/marketing
- config/workspaces.json
- tenant.json

## Validation Rules
- Directory and file presence is deterministic.
- Workspace paths remain tenant-relative.
- Tenant metadata must match allowed values.
