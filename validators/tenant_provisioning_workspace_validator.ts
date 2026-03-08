#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

type Spec = {
  artifact_name: string;
  artifact_type: string;
  schema_version: string;
  inputs: {
    phase_name: string;
    tenant_types: string[];
    required_workspaces: string[];
    output_format: string;
  };
  required_directories: Array<{ path: string; purpose: string; must_exist: boolean }>;
  required_files: Array<{
    path: string;
    purpose: string;
    format: 'json' | 'markdown' | string;
    must_exist: boolean;
    required_fields?: string[];
    required_sections?: string[];
    allowed_placeholders: string[];
  }>;
  placeholders: Array<{
    token: string;
    description: string;
    allowed_in_files: string[];
    validation_regex?: string;
    allowed_values?: string[];
  }>;
};

type ValidatorSpec = {
  top_level_keys_exact: string[];
  regex: {
    placeholder_token: string;
    workspace_path: string;
    absolute_path: string;
    parent_traversal: string;
    external_ref: string;
    secret_pattern: string;
    code_file_ext: string;
  };
};

type Defect = {
  id: string;
  severity: 'error' | 'warn';
  check: string;
  message: string;
  path?: string;
  details?: Json;
};

type Result = {
  status: 'pass' | 'fail';
  target_root: string;
  passed_checks: string[];
  failed_checks: string[];
  defects: Defect[];
};

const CHECK_IDS = ['AT-001', 'AT-002', 'AT-003', 'AT-004', 'AT-005', 'AT-006', 'AT-007'] as const;

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

function toPosixRel(root: string, p: string): string {
  return path.relative(root, p).split(path.sep).join('/');
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        visit(full);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  };
  visit(root);
  return out;
}

function countSectionHeading(md: string, section: string): number {
  const esc = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^#{1,6}\\s+${esc}\\s*$`, 'gm');
  return [...md.matchAll(re)].length;
}

function collectJsonStrings(value: Json, keyPath = ''): Array<{ keyPath: string; value: string }> {
  const out: Array<{ keyPath: string; value: string }> = [];
  if (typeof value === 'string') {
    out.push({ keyPath, value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      out.push(...collectJsonStrings(v as Json, `${keyPath}[${i}]`));
    });
    return out;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, Json>;
    Object.keys(obj).sort().forEach((k) => {
      out.push(...collectJsonStrings(obj[k], keyPath ? `${keyPath}.${k}` : k));
    });
  }
  return out;
}

function normalizePathString(s: string): string {
  return s.replace(/\\/g, '/');
}

function main(): number {
  const args = parseArgs(process.argv);
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const projectRoot = path.resolve(__dirname, '..');
  const targetRoot = path.resolve(args['target-root'] ?? '');
  if (!targetRoot || !fs.existsSync(targetRoot)) {
    console.error('Missing or invalid --target-root');
    return 2;
  }

  const specPath = path.resolve(projectRoot, args['spec'] ?? './specs/tenant_provisioning_workspace_spec.v1.json');
  const validatorSpecPath = path.resolve(projectRoot, args['validator-spec'] ?? './specs/tenant_provisioning_workspace_validator_spec.v1.json');
  const reportPath = args['report'] ? path.resolve(projectRoot, args['report']) : undefined;

  const spec = readJsonFile<Spec>(specPath);
  const validatorSpec = readJsonFile<ValidatorSpec>(validatorSpecPath);

  const defects: Defect[] = [];
  const checkHasFailure = new Set<string>();
  let defectCounter = 0;

  const addDefect = (check: string, message: string, p?: string, details?: Json) => {
    defectCounter += 1;
    checkHasFailure.add(check);
    defects.push({
      id: `DEF-${String(defectCounter).padStart(4, '0')}`,
      severity: 'error',
      check,
      message,
      path: p,
      details
    });
  };

  // AT-001: top-level schema keys exact
  {
    const expected = [...validatorSpec.top_level_keys_exact].sort();
    const actual = Object.keys(spec as Record<string, unknown>).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      addDefect('AT-001', 'Top-level schema keys mismatch', specPath, { expected, actual });
    }
  }

  // AT-002: required directories exist
  for (const d of spec.required_directories) {
    if (!d.must_exist) continue;
    const abs = path.join(targetRoot, d.path);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      addDefect('AT-002', 'Required directory missing', d.path);
    }
  }

  // AT-003/INV-005: required files and required fields/sections
  const jsonFileCache = new Map<string, Json>();
  for (const f of spec.required_files) {
    if (typeof f.purpose !== 'string' || !Array.isArray(f.allowed_placeholders)) {
      addDefect('AT-003', 'Spec required_files metadata incomplete', f.path, f as unknown as Json);
      continue;
    }
    const abs = path.join(targetRoot, f.path);
    if (f.must_exist && (!fs.existsSync(abs) || !fs.statSync(abs).isFile())) {
      addDefect('AT-003', 'Required file missing', f.path);
      continue;
    }
    if (!fs.existsSync(abs)) continue;

    const raw = fs.readFileSync(abs, 'utf8');
    if (f.format === 'json') {
      let parsed: Json;
      try {
        parsed = JSON.parse(raw) as Json;
      } catch {
        addDefect('AT-003', 'Invalid JSON', f.path);
        continue;
      }
      jsonFileCache.set(f.path, parsed);
      if (Array.isArray(f.required_fields)) {
        for (const key of f.required_fields) {
          if (!(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && key in (parsed as Record<string, Json>))) {
            addDefect('AT-003', 'Missing required JSON field', f.path, { field: key });
          }
        }
      }
    }

    if (f.format === 'markdown' && Array.isArray(f.required_sections)) {
      for (const section of f.required_sections) {
        const count = countSectionHeading(raw, section);
        if (count !== 1) {
          addDefect('AT-003', 'Required markdown section must exist exactly once', f.path, { section, count });
        }
      }
    }
  }

  // AT-004: tenant semantics
  {
    const tenantPath = 'tenant.json';
    const tenant = (jsonFileCache.get(tenantPath)
      ?? (fs.existsSync(path.join(targetRoot, tenantPath)) ? readJsonFile<Json>(path.join(targetRoot, tenantPath)) : null)) as Json;

    if (!tenant || typeof tenant !== 'object' || Array.isArray(tenant)) {
      addDefect('AT-004', 'tenant.json missing or not an object', tenantPath);
    } else {
      const t = tenant as Record<string, Json>;
      const tenantType = t['tenant_type'];
      const phaseName = t['phase_name'];
      const workspaces = t['workspaces'];

      if (typeof tenantType !== 'string' || !spec.inputs.tenant_types.includes(tenantType)) {
        addDefect('AT-004', 'tenant_type must be one of allowed values', tenantPath, {
          expected: spec.inputs.tenant_types,
          actual: tenantType ?? null
        });
      }

      if (phaseName !== spec.inputs.phase_name) {
        addDefect('AT-004', 'phase_name mismatch', tenantPath, {
          expected: spec.inputs.phase_name,
          actual: phaseName ?? null
        });
      }

      const expectedWs = [...spec.inputs.required_workspaces].sort();
      const actualWs = Array.isArray(workspaces)
        ? [...workspaces].filter((x): x is string => typeof x === 'string').sort()
        : [];
      if (JSON.stringify(expectedWs) !== JSON.stringify(actualWs)) {
        addDefect('AT-004', 'workspaces must exactly match required_workspaces', tenantPath, {
          expected: expectedWs,
          actual: actualWs
        });
      }
    }
  }

  // AT-005: placeholder policy + resolved value constraints
  {
    const placeholderRe = new RegExp(validatorSpec.regex.placeholder_token, 'g');
    const placeholderDefs = new Map(spec.placeholders.map((p) => [p.token, p]));
    const files = walkFiles(targetRoot);

    for (const abs of files) {
      const rel = toPosixRel(targetRoot, abs);
      const raw = fs.readFileSync(abs, 'utf8');
      const matches = [...raw.matchAll(placeholderRe)].map((m) => m[0]);
      for (const token of matches) {
        const def = placeholderDefs.get(token);
        if (!def) {
          addDefect('AT-005', 'Unknown placeholder token', rel, { token });
          continue;
        }
        if (!def.allowed_in_files.includes(rel)) {
          addDefect('AT-005', 'Placeholder token found in non-whitelisted file', rel, {
            token,
            allowed_in_files: def.allowed_in_files
          });
        }
      }
    }

    const tenant = fs.existsSync(path.join(targetRoot, 'tenant.json'))
      ? readJsonFile<Record<string, Json>>(path.join(targetRoot, 'tenant.json'))
      : null;
    if (tenant && typeof tenant === 'object') {
      const resolved: Record<string, string | undefined> = {
        '{{TENANT_ID}}': typeof tenant['tenant_id'] === 'string' ? tenant['tenant_id'] : undefined,
        '{{TENANT_TYPE}}': typeof tenant['tenant_type'] === 'string' ? tenant['tenant_type'] : undefined,
        '{{PHASE_NAME}}': typeof tenant['phase_name'] === 'string' ? tenant['phase_name'] : undefined
      };

      for (const def of spec.placeholders) {
        const value = resolved[def.token];
        if (value === undefined) continue;
        if (def.validation_regex) {
          const re = new RegExp(def.validation_regex);
          if (!re.test(value)) {
            addDefect('AT-005', 'Resolved placeholder value failed regex', 'tenant.json', {
              token: def.token,
              value,
              regex: def.validation_regex
            });
          }
        }
        if (def.allowed_values && !def.allowed_values.includes(value)) {
          addDefect('AT-005', 'Resolved placeholder value not in allowed_values', 'tenant.json', {
            token: def.token,
            value,
            allowed_values: def.allowed_values
          });
        }
      }
    }
  }

  // AT-006: forbidden pattern scan
  {
    const absolutePathRe = new RegExp(validatorSpec.regex.absolute_path);
    const parentTraversalRe = new RegExp(validatorSpec.regex.parent_traversal);
    const externalRefRe = new RegExp(validatorSpec.regex.external_ref, 'i');
    const secretRe = new RegExp(validatorSpec.regex.secret_pattern, 'i');
    const codeExtRe = new RegExp(validatorSpec.regex.code_file_ext, 'i');

    const files = walkFiles(targetRoot);

    for (const abs of files) {
      const rel = toPosixRel(targetRoot, abs);
      if (codeExtRe.test(rel)) {
        addDefect('AT-006', 'Implementation code file extension is forbidden in artifact scope', rel);
      }

      const raw = fs.readFileSync(abs, 'utf8');
      const lines = raw.split(/\r?\n/);
      lines.forEach((line, idx) => {
        if (secretRe.test(line)) {
          addDefect('AT-006', 'Potential secret pattern is forbidden', rel, { line: idx + 1, text: line });
        }
      });

      if (rel.toLowerCase().endsWith('.json')) {
        try {
          const parsed = JSON.parse(raw) as Json;
          const strings = collectJsonStrings(parsed);
          for (const s of strings) {
            const v = normalizePathString(s.value);
            if (absolutePathRe.test(v)) {
              addDefect('AT-006', 'Absolute path forbidden', rel, { keyPath: s.keyPath, value: s.value });
            }
            if (parentTraversalRe.test(v)) {
              addDefect('AT-006', 'Parent traversal forbidden', rel, { keyPath: s.keyPath, value: s.value });
            }
            if (v.includes('/tenants/')) {
              addDefect('AT-006', 'Cross-tenant reference forbidden', rel, { keyPath: s.keyPath, value: s.value });
            }
            if (externalRefRe.test(v)) {
              addDefect('AT-006', 'External network reference forbidden in JSON', rel, { keyPath: s.keyPath, value: s.value });
            }
          }
        } catch {
          // JSON validity already checked elsewhere where required.
        }
      }
    }
  }

  // AT-007: path locality compliance
  {
    const cfgRel = 'config/workspaces.json';
    const cfgAbs = path.join(targetRoot, cfgRel);
    const workspacePathRe = new RegExp(validatorSpec.regex.workspace_path);
    const absolutePathRe = new RegExp(validatorSpec.regex.absolute_path);
    const parentTraversalRe = new RegExp(validatorSpec.regex.parent_traversal);

    if (!fs.existsSync(cfgAbs)) {
      addDefect('AT-007', 'Missing config/workspaces.json', cfgRel);
    } else {
      try {
        const cfg = readJsonFile<Record<string, Json>>(cfgAbs);
        const wp = cfg['workspace_paths'];
        if (!wp || typeof wp !== 'object' || Array.isArray(wp)) {
          addDefect('AT-007', 'workspace_paths must be an object', cfgRel);
        } else {
          Object.keys(wp).sort().forEach((k) => {
            const v = (wp as Record<string, Json>)[k];
            if (typeof v !== 'string') {
              addDefect('AT-007', 'workspace_paths values must be strings', cfgRel, { key: k, value: v ?? null });
              return;
            }
            const norm = normalizePathString(v);
            if (!workspacePathRe.test(norm)) {
              addDefect('AT-007', 'workspace path does not match required pattern', cfgRel, { key: k, value: v });
            }
            if (absolutePathRe.test(norm)) {
              addDefect('AT-007', 'workspace path must be tenant-relative', cfgRel, { key: k, value: v });
            }
            if (parentTraversalRe.test(norm)) {
              addDefect('AT-007', 'workspace path must not contain traversal', cfgRel, { key: k, value: v });
            }
          });
        }
      } catch {
        addDefect('AT-007', 'Invalid JSON in config/workspaces.json', cfgRel);
      }
    }
  }

  defects.sort((a, b) => {
    if (a.check !== b.check) return a.check.localeCompare(b.check);
    if ((a.path ?? '') !== (b.path ?? '')) return (a.path ?? '').localeCompare(b.path ?? '');
    return a.message.localeCompare(b.message);
  });

  const failed_checks = CHECK_IDS.filter((c) => checkHasFailure.has(c));
  const passed_checks = CHECK_IDS.filter((c) => !checkHasFailure.has(c));

  const result: Result = {
    status: defects.length === 0 ? 'pass' : 'fail',
    target_root: targetRoot,
    passed_checks,
    failed_checks,
    defects
  };

  const rendered = JSON.stringify(result, null, 2);
  if (reportPath) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${rendered}\n`, 'utf8');
  }
  process.stdout.write(`${rendered}\n`);
  return result.status === 'pass' ? 0 : 1;
}

process.exit(main());
