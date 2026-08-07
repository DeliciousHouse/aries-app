import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

import { resolveProjectRoot } from './helpers/project-root.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const COMPOSE_PATH = path.join(PROJECT_ROOT, 'docker-compose.yml');
const HEALTHCHECK_PATH = path.join(PROJECT_ROOT, 'scripts', 'container-healthcheck.mjs');
const HERMES_IMAGE =
  'nousresearch/hermes-agent:v2026.8.3@sha256:16788311e2fa3035456bdc1bafb8ec2b1777db64ebf020af9bb7eb73c3712c9e';
const SOURCE_ROOTS = ['app', 'backend', 'components', 'hooks', 'lib', 'packages', 'scripts'];
const CHILD_PROCESS_COMMANDS = new Set([
  'exec',
  'execFile',
  'execFileSync',
  'execSync',
  'spawn',
  'spawnSync',
]);
const CLI_COMPAT_PATH = 'scripts/hermes-kanban-gc-worker.ts';

function serviceBlock(composeSource: string, serviceName: string): string {
  const lines = composeSource.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${serviceName}:`);
  assert.notEqual(start, -1, `expected docker-compose.yml to define ${serviceName}`);

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[A-Za-z0-9][A-Za-z0-9._-]*:\s*$/.test(lines[index]) || /^\S/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(entryPath);
    }
    if (!/\.(?:[cm]?[jt]s|tsx)$/.test(entry.name) || /\.(?:test|spec)\./.test(entry.name)) {
      return [];
    }
    return [entryPath];
  });
}

function directHermesCliCalls(): string[] {
  const calls: string[] = [];
  for (const sourceRoot of SOURCE_ROOTS) {
    const absoluteRoot = path.join(PROJECT_ROOT, sourceRoot);
    for (const filePath of sourceFiles(absoluteRoot)) {
      const source = readFileSync(filePath, 'utf8');
      const sourceFile = ts.createSourceFile(
        filePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        /\.(?:ts|tsx)$/.test(filePath) ? ts.ScriptKind.TS : ts.ScriptKind.JS,
      );
      const commandBindings = new Set<string>();
      for (const statement of sourceFile.statements) {
        if (
          !ts.isImportDeclaration(statement)
          || statement.moduleSpecifier.getText(sourceFile).replaceAll(/["']/g, '') !== 'node:child_process'
          || !statement.importClause?.namedBindings
          || !ts.isNamedImports(statement.importClause.namedBindings)
        ) {
          continue;
        }
        for (const element of statement.importClause.namedBindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (CHILD_PROCESS_COMMANDS.has(importedName)) {
            commandBindings.add(element.name.text);
          }
        }
      }
      if (commandBindings.size === 0) {
        continue;
      }

      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node)
          && ts.isIdentifier(node.expression)
          && commandBindings.has(node.expression.text)
          && /hermes/i.test(node.arguments[0]?.getText(sourceFile) ?? '')
        ) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          calls.push(`${path.relative(PROJECT_ROOT, filePath).replaceAll('\\', '/')}:${line}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }
  return calls;
}

function runHealthcheck(
  env: Record<string, string | undefined>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HEALTHCHECK_PATH], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('production Compose defines an opt-in, pinned Hermes sidecar on the app network', () => {
  const composeSource = readFileSync(COMPOSE_PATH, 'utf8');
  const installSource = readFileSync(path.join(PROJECT_ROOT, 'install.sh'), 'utf8');
  const sidecar = serviceBlock(composeSource, 'aries-hermes');
  const app = serviceBlock(composeSource, 'aries-app');

  assert.ok(sidecar.includes(`image: \${ARIES_HERMES_IMAGE:-${HERMES_IMAGE}}`));
  assert.match(sidecar, /profiles: \["hermes-sidecar"\]/);
  assert.match(sidecar, /API_SERVER_ENABLED: "true"/);
  assert.match(sidecar, /API_SERVER_HOST: 0\.0\.0\.0/);
  assert.match(sidecar, /API_SERVER_KEY: \$\{HERMES_API_SERVER_KEY:-\}/);
  assert.match(sidecar, /command: \["gateway", "run"\]/);
  assert.match(sidecar, /\$\{ARIES_HERMES_DATA_ROOT:-\/home\/node\/\.hermes\}:\/opt\/data/);
  assert.match(sidecar, /http:\/\/127\.0\.0\.1:8642\/health/);
  assert.match(sidecar, /- docker_stack/);
  assert.match(app, /test: \["CMD", "node", "scripts\/container-healthcheck\.mjs"\]/);
  assert.match(
    installSource,
    /set_env_var ARIES_HERMES_NETWORK_HEALTHCHECK_ENABLED "\$WITH_HERMES"/,
  );
});

test('the only direct Hermes CLI spawn is the explicitly flagged compatibility worker', () => {
  const calls = directHermesCliCalls();
  assert.equal(calls.length, 1, `expected one temporary direct Hermes CLI call, found: ${calls.join(', ')}`);
  assert.ok(calls[0].startsWith(`${CLI_COMPAT_PATH}:`), `unexpected direct Hermes CLI call: ${calls[0]}`);

  const compatSource = readFileSync(path.join(PROJECT_ROOT, CLI_COMPAT_PATH), 'utf8');
  assert.match(compatSource, /ARIES_HERMES_CLI_COMPAT_ENABLED/);
});

test('container healthcheck fails closed on Hermes failure and supports no-Hermes installs', async (t) => {
  const server = createServer((request, response) => {
    response.statusCode = request.url === '/app' ? 204 : 503;
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const baseEnv = {
    ARIES_APP_HEALTHCHECK_URL: `${baseUrl}/app`,
    HERMES_GATEWAY_URL: baseUrl,
  };

  const required = await runHealthcheck({
    ...baseEnv,
    ARIES_HERMES_NETWORK_HEALTHCHECK_ENABLED: '1',
  });
  assert.equal(required.code, 1);
  assert.match(required.stderr, /Hermes healthcheck failed/);

  const disabled = await runHealthcheck({
    ...baseEnv,
    ARIES_HERMES_NETWORK_HEALTHCHECK_ENABLED: '0',
  });
  assert.equal(disabled.code, 0, `${disabled.stderr}\n${disabled.stdout}`);
});
