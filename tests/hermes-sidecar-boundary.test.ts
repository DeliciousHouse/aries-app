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

function directHermesCliCallsInSource(filePath: string, source: string): string[] {
  const calls: string[] = [];
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    /\.(?:ts|tsx)$/.test(filePath) ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const commandBindings = new Set<string>();
  const namespaceBindings = new Set<string>();
  const initializers = new Map<string, ts.Expression>();
  const variableDeclarations: Array<{ name: ts.BindingName; initializer: ts.Expression }> = [];
  const childProcessModule = (expression: ts.Expression): boolean => (
    ts.isStringLiteral(expression)
    && (expression.text === 'child_process' || expression.text === 'node:child_process')
  );
  const childProcessRequire = (expression: ts.Expression | undefined): boolean => (
    Boolean(expression)
    && ts.isCallExpression(expression!)
    && ts.isIdentifier(expression!.expression)
    && expression!.expression.text === 'require'
    && expression!.arguments.length === 1
    && childProcessModule(expression!.arguments[0])
  );

  const collectBindings = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node)
      && childProcessModule(node.moduleSpecifier)
      && node.importClause?.namedBindings
    ) {
      if (ts.isNamedImports(node.importClause.namedBindings)) {
        for (const element of node.importClause.namedBindings.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          if (CHILD_PROCESS_COMMANDS.has(importedName)) {
            commandBindings.add(element.name.text);
          }
        }
      } else {
        namespaceBindings.add(node.importClause.namedBindings.name.text);
      }
    }

    if (ts.isVariableDeclaration(node) && node.initializer) {
      variableDeclarations.push({ name: node.name, initializer: node.initializer });
      if (ts.isIdentifier(node.name)) {
        initializers.set(node.name.text, node.initializer);
        if (childProcessRequire(node.initializer)) {
          namespaceBindings.add(node.name.text);
        }
      } else if (ts.isObjectBindingPattern(node.name) && childProcessRequire(node.initializer)) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const importedName = element.propertyName?.getText(sourceFile) ?? element.name.text;
          if (CHILD_PROCESS_COMMANDS.has(importedName)) {
            commandBindings.add(element.name.text);
          }
        }
      }
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(sourceFile);

  let bindingCount = -1;
  while (bindingCount !== commandBindings.size + namespaceBindings.size) {
    bindingCount = commandBindings.size + namespaceBindings.size;
    for (const { name, initializer } of variableDeclarations) {
      const namespaceInitializer = childProcessRequire(initializer)
        || (ts.isIdentifier(initializer) && namespaceBindings.has(initializer.text));
      if (ts.isIdentifier(name)) {
        if (namespaceInitializer) namespaceBindings.add(name.text);
        if (ts.isIdentifier(initializer) && commandBindings.has(initializer.text)) {
          commandBindings.add(name.text);
        }
        if (
          ts.isPropertyAccessExpression(initializer)
          && CHILD_PROCESS_COMMANDS.has(initializer.name.text)
          && (
            childProcessRequire(initializer.expression)
            || (ts.isIdentifier(initializer.expression) && namespaceBindings.has(initializer.expression.text))
          )
        ) {
          commandBindings.add(name.text);
        }
      } else if (ts.isObjectBindingPattern(name) && namespaceInitializer) {
        for (const element of name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const importedName = element.propertyName?.getText(sourceFile) ?? element.name.text;
          if (CHILD_PROCESS_COMMANDS.has(importedName)) {
            commandBindings.add(element.name.text);
          }
        }
      }
    }
  }

  const resolveStaticString = (expression: ts.Expression | undefined, seen = new Set<string>()): string | null => {
    if (!expression) return null;
    if (ts.isStringLiteralLike(expression)) return expression.text;
    if (ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
    if (ts.isParenthesizedExpression(expression)) return resolveStaticString(expression.expression, seen);
    if (ts.isIdentifier(expression)) {
      if (seen.has(expression.text)) return null;
      const initializer = initializers.get(expression.text);
      if (!initializer) return null;
      return resolveStaticString(initializer, new Set([...seen, expression.text]));
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = resolveStaticString(expression.left, seen);
      const right = resolveStaticString(expression.right, seen);
      return left !== null && right !== null ? left + right : null;
    }
    return null;
  };

  const isChildProcessCommand = (expression: ts.LeftHandSideExpression): boolean => {
    if (ts.isIdentifier(expression)) return commandBindings.has(expression.text);
    return ts.isPropertyAccessExpression(expression)
      && CHILD_PROCESS_COMMANDS.has(expression.name.text)
      && (
        (ts.isIdentifier(expression.expression) && namespaceBindings.has(expression.expression.text))
        || childProcessRequire(expression.expression)
      );
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && isChildProcessCommand(node.expression)
      && /hermes/i.test(resolveStaticString(node.arguments[0]) ?? node.arguments[0]?.getText(sourceFile) ?? '')
    ) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      calls.push(`${path.relative(PROJECT_ROOT, filePath).replaceAll('\\', '/')}:${line}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

function directHermesCliCalls(): string[] {
  return SOURCE_ROOTS.flatMap((sourceRoot) => {
    const absoluteRoot = path.join(PROJECT_ROOT, sourceRoot);
    return sourceFiles(absoluteRoot).flatMap((filePath) => (
      directHermesCliCallsInSource(filePath, readFileSync(filePath, 'utf8'))
    ));
  });
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

test('the direct Hermes CLI boundary catches command aliases, namespace imports, and require forms', () => {
  const fixtures = [
    `import { spawn as run } from 'node:child_process'; const command = 'hermes'; run(command, []);`,
    `import * as cp from 'node:child_process'; const command = 'hermes'; cp.execFile(command, []);`,
    `const cp = require('child_process'); const command = 'hermes'; cp.spawnSync(command, []);`,
    `const { execFileSync: run } = require('node:child_process'); const command = 'hermes'; run(command, []);`,
    `const command = 'hermes'; require('child_process').execFile(command, []);`,
    `const cp = require('node:child_process'); const { spawn: run } = cp; run('hermes', []);`,
    `import * as proc from 'node:child_process'; const cp = proc; cp.spawn('hermes', []);`,
  ];
  const calls = fixtures.flatMap((source, index) => (
    directHermesCliCallsInSource(path.join(PROJECT_ROOT, `fixture-${index}.ts`), source)
  ));

  assert.equal(calls.length, fixtures.length, `undetected direct Hermes CLI fixtures: ${calls.join(', ')}`);
});

test('container healthcheck probes distinct stage gateways once and identifies failures', async (t) => {
  const healthHits = [0, 0, 0];
  const statuses = [200, 200, 503];
  const expectedAuthorizations = ['Bearer base-key', 'Bearer strategist-key', 'Bearer content-key'];
  const servers = statuses.map((status, index) => createServer((request, response) => {
    if (request.url === '/health') healthHits[index] += 1;
    response.statusCode = request.url === '/app'
      ? 204
      : request.headers.authorization === expectedAuthorizations[index] ? status : 401;
    response.end();
  }));
  await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  })));
  t.after(() => Promise.all(servers.map((server) => (
    new Promise<void>((resolve) => server.close(() => resolve()))
  ))).then(() => undefined));

  const urls = servers.map((server) => {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}`;
  });
  const baseEnv = {
    ARIES_APP_HEALTHCHECK_URL: `${urls[0]}/app`,
    HERMES_GATEWAY_URL: urls[0],
    HERMES_API_SERVER_KEY: 'base-key',
    HERMES_RESEARCH_GATEWAY_URL: urls[0],
    HERMES_RESEARCH_API_SERVER_KEY: 'research-key',
    HERMES_STRATEGIST_GATEWAY_URL: urls[1],
    HERMES_STRATEGIST_API_SERVER_KEY: 'strategist-key',
    HERMES_CONTENT_GATEWAY_URL: urls[2],
    HERMES_CONTENT_API_SERVER_KEY: 'content-key',
  };

  const required = await runHealthcheck({
    ...baseEnv,
    ARIES_HERMES_NETWORK_HEALTHCHECK_ENABLED: '1',
  });
  assert.equal(required.code, 1, `${required.stderr}\n${required.stdout}`);
  assert.match(required.stderr, /content/);
  assert.deepEqual(healthHits, [1, 1, 1]);

  const disabled = await runHealthcheck({
    ...baseEnv,
    ARIES_HERMES_NETWORK_HEALTHCHECK_ENABLED: '0',
  });
  assert.equal(disabled.code, 0, `${disabled.stderr}\n${disabled.stdout}`);
});

test('container healthcheck probes five delayed responders before the Compose deadline', async (t) => {
  const delayMs = 1_100;
  const healthHits = [0, 0, 0, 0, 0];
  const expectedAuthorizations = [
    undefined,
    'Bearer base-key',
    'Bearer research-key',
    'Bearer strategist-key',
    'Bearer content-key',
  ];
  const servers = healthHits.map((_, index) => createServer((request, response) => {
    healthHits[index] += 1;
    setTimeout(() => {
      response.statusCode = index === 4
        ? 503
        : request.headers.authorization === expectedAuthorizations[index] ? 204 : 401;
      response.end();
    }, delayMs);
  }));
  await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  })));
  t.after(() => Promise.all(servers.map((server) => (
    new Promise<void>((resolve) => server.close(() => resolve()))
  ))).then(() => undefined));

  const urls = servers.map((server) => {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}`;
  });
  const startedAt = Date.now();
  const result = await runHealthcheck({
    ARIES_APP_HEALTHCHECK_URL: `${urls[0]}/app`,
    ARIES_HERMES_NETWORK_HEALTHCHECK_ENABLED: '1',
    HERMES_GATEWAY_URL: urls[1],
    HERMES_API_SERVER_KEY: 'base-key',
    HERMES_RESEARCH_GATEWAY_URL: urls[2],
    HERMES_RESEARCH_API_SERVER_KEY: 'research-key',
    HERMES_STRATEGIST_GATEWAY_URL: urls[3],
    HERMES_STRATEGIST_API_SERVER_KEY: 'strategist-key',
    HERMES_CONTENT_GATEWAY_URL: urls[4],
    HERMES_CONTENT_API_SERVER_KEY: 'content-key',
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.code, 1, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stderr, /content/);
  assert.ok(elapsedMs < 5_000, `healthcheck exceeded Compose timeout: ${elapsedMs}ms`);
  assert.deepEqual(healthHits, [1, 1, 1, 1, 1]);
});
