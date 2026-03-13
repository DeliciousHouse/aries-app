#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveCodePath, resolveDataPath } from '../lib/runtime-paths';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

type Spec = {
  inputs: {
    phase_name: string;
    tenant_types: string[];
    required_workspaces: string[];
  };
  required_directories: Array<{ path: string; must_exist: boolean }>;
  required_files: Array<{ path: string; format: string }>;
  invariants: Array<{ id: string }>;
  placeholders: Array<{ token: string; validation_regex?: string; allowed_values?: string[] }>;
};

type Input = {
  tenant_id: string;
  tenant_type: string;
};

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = 'true';
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function readJsonFile<T>(p: string): T {
  const raw = fs.readFileSync(p, 'utf8');
  try {
    return JSON.parse(raw) as T;
  } catch {
    try {
      const repaired = raw.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
      return JSON.parse(repaired) as T;
    } catch {
      return Function(`"use strict"; return (${raw});`)() as T;
    }
  }
}

function writeText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function writeJson(file: string, value: Json): void {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function section(title: string, body: string): string {
  return `## ${title}\n${body.trim()}\n`;
}

function workspaceReadme(workspace: string): string {
  const purpose = `This workspace stores ${workspace} artifacts for the tenant lifecycle.`;
  const allowed = [
    '- Markdown documents describing plans and outcomes.',
    '- JSON files with deterministic configuration or metadata.',
    '- Static assets directly related to this workspace scope.'
  ].join('\n');
  const disallowed = [
    '- Source code or executable scripts.',
    '- Files outside tenant scope.',
    '- Runtime state that cannot be regenerated deterministically.'
  ].join('\n');

  return [
    `# ${workspace[0].toUpperCase()}${workspace.slice(1)} Workspace`,
    '',
    section('Purpose', purpose),
    section('Allowed Content', allowed),
    section('Disallowed Content', disallowed)
  ].join('\n').trimEnd() + '\n';
}

function validateInput(spec: Spec, input: Input): void {
  const byToken = new Map(spec.placeholders.map((p) => [p.token, p]));

  const tenantIdDef = byToken.get('{{TENANT_ID}}');
  if (tenantIdDef?.validation_regex) {
    const re = new RegExp(tenantIdDef.validation_regex);
    if (!re.test(input.tenant_id)) {
      throw new Error(`tenant_id failed regex: ${tenantIdDef.validation_regex}`);
    }
  }

  const tenantTypeDef = byToken.get('{{TENANT_TYPE}}');
  const allowedTypes = tenantTypeDef?.allowed_values ?? spec.inputs.tenant_types;
  if (!allowedTypes.includes(input.tenant_type)) {
    throw new Error(`tenant_type must be one of: ${allowedTypes.join(', ')}`);
  }
}

function main(): number {
  const args = parseArgs(process.argv);
  const specPath = args['spec']
    ? path.resolve(args['spec'])
    : resolveCodePath('specs', 'tenant_provisioning_workspace_spec.v1.json');
  const inputPath = args['input']
    ? path.resolve(args['input'])
    : resolveDataPath('generated', 'draft', 'test-tenant-input.json');

  const spec = readJsonFile<Spec>(specPath);
  const input = readJsonFile<Input>(inputPath);
  validateInput(spec, input);

  const outputRoot = args['out']
    ? path.resolve(args['out'])
    : resolveDataPath('generated', 'draft', input.tenant_id);

  // Deterministic output: clear and recreate.
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });

  for (const d of spec.required_directories.filter((x) => x.must_exist)) {
    fs.mkdirSync(path.join(outputRoot, d.path), { recursive: true });
  }

  // Ensure parent directories for required files.
  for (const f of spec.required_files) {
    fs.mkdirSync(path.dirname(path.join(outputRoot, f.path)), { recursive: true });
  }

  const requiredWorkspaces = [...spec.inputs.required_workspaces];

  writeJson(path.join(outputRoot, 'tenant.json'), {
    tenant_id: input.tenant_id,
    tenant_type: input.tenant_type,
    phase_name: spec.inputs.phase_name,
    workspaces: requiredWorkspaces
  });

  const workspacePaths: Record<string, string> = {};
  requiredWorkspaces.forEach((w) => {
    workspacePaths[w] = `workspaces/${w}`;
  });

  writeJson(path.join(outputRoot, 'config/workspaces.json'), {
    required_workspaces: requiredWorkspaces,
    workspace_paths: workspacePaths,
    validation: {
      deterministic: true,
      invariants: spec.invariants.map((x) => x.id),
      status: 'ready'
    }
  });

  const docsReadme = [
    '# Tenant Workspace README',
    '',
    section('Overview', `Tenant ${input.tenant_id} is provisioned as ${input.tenant_type} for phase ${spec.inputs.phase_name}.`),
    section('Workspace Layout', [
      ...requiredWorkspaces.map((w) => `- workspaces/${w}`),
      '- config/workspaces.json',
      '- tenant.json'
    ].join('\n')),
    section('Validation Rules', [
      '- Directory and file presence is deterministic.',
      '- Workspace paths remain tenant-relative.',
      '- Tenant metadata must match allowed values.'
    ].join('\n'))
  ].join('\n').trimEnd() + '\n';
  writeText(path.join(outputRoot, 'docs/README.md'), docsReadme);

  for (const w of requiredWorkspaces) {
    writeText(path.join(outputRoot, `workspaces/${w}/README.md`), workspaceReadme(w));
  }

  const manifest = {
    status: 'generated',
    output_root: outputRoot,
    tenant_id: input.tenant_id,
    tenant_type: input.tenant_type,
    files: [
      'tenant.json',
      'config/workspaces.json',
      'docs/README.md',
      ...requiredWorkspaces.map((w) => `workspaces/${w}/README.md`)
    ]
  };

  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  return 0;
}

process.exit(main());
