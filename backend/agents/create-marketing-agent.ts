declare const require: (name: string) => any;
declare const process: { cwd: () => string };

const fs = require('fs');
const path = require('path');

export type TenantType = 'single_user' | 'team';
export type AgentType = 'marketing';

export type CreateAgentInput = {
  tenantId: string;
  tenantType: TenantType;
  projectRoot?: string;
};

export type ProvisionedAgent = {
  schema_name: 'agent_provisioning_record';
  schema_version: '1.0.0';
  tenant_id: string;
  tenant_type: TenantType;
  agent_type: AgentType;
  agent_id: string;
  workspace: AgentType;
  workspace_path: string;
  capabilities: string[];
  policy: {
    deterministic: true;
    writable_paths: string[];
    disallowed: string[];
  };
  source: {
    tenant_runtime_schema: string;
    workspace_config: string;
  };
};

const REQUIRED_TENANT_RUNTIME_SCHEMA = './specs/tenant_runtime_state_schema.v1.json';

function hardFailIfMissingSchema(projectRoot: string): string {
  const schemaPath = path.resolve(projectRoot, REQUIRED_TENANT_RUNTIME_SCHEMA);
  if (!fs.existsSync(schemaPath)) {
    throw new Error(
      `HARD_FAILURE: missing required schema input(s): ${REQUIRED_TENANT_RUNTIME_SCHEMA}`
    );
  }
  return schemaPath;
}

function loadWorkspaceConfig(projectRoot: string, tenantId: string): { path: string; parsed: Record<string, unknown> } {
  const cfgPath = path.resolve(projectRoot, 'generated/validated', tenantId, 'config', 'workspaces.json');
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`HARD_FAILURE: missing validated provisioning artifact: ${cfgPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
  return { path: cfgPath, parsed };
}

function workspacePathFromConfig(
  projectRoot: string,
  tenantId: string,
  cfg: Record<string, unknown>,
  workspace: AgentType
): string {
  const workspacePaths = (cfg.workspace_paths || {}) as Record<string, string>;
  const relativePath = workspacePaths[workspace];
  if (!relativePath || relativePath.indexOf('workspaces/') !== 0) {
    throw new Error(
      `HARD_FAILURE: invalid validated provisioning artifact mapping for workspace '${workspace}'`
    );
  }
  return path.resolve(projectRoot, 'generated/validated', tenantId, relativePath);
}

export function createMarketingAgent(input: CreateAgentInput): ProvisionedAgent {
  const projectRoot = input.projectRoot || process.cwd();
  const schemaPath = hardFailIfMissingSchema(projectRoot);
  const workspaceConfig = loadWorkspaceConfig(projectRoot, input.tenantId);

  const workspacePath = workspacePathFromConfig(projectRoot, input.tenantId, workspaceConfig.parsed, 'marketing');

  return {
    schema_name: 'agent_provisioning_record',
    schema_version: '1.0.0',
    tenant_id: input.tenantId,
    tenant_type: input.tenantType,
    agent_type: 'marketing',
    agent_id: `${input.tenantId}-marketing-agent`,
    workspace: 'marketing',
    workspace_path: workspacePath,
    capabilities: ['workspace.read', 'workspace.write', 'campaign.plan', 'audience.segment'],
    policy: {
      deterministic: true,
      writable_paths: [workspacePath],
      disallowed: ['network.write', 'secrets.read']
    },
    source: {
      tenant_runtime_schema: schemaPath,
      workspace_config: workspaceConfig.path
    }
  };
}
