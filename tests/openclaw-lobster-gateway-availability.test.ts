import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);
const ARTIFACT_DIR = path.join(PROJECT_ROOT, '.artifacts', 'openclaw-lobster-availability');
const DIAGNOSTIC_WORKFLOW = 'diagnostics/openclaw-gateway-availability.lobster';
const REPO_ROOT_GATEWAY_CWD = 'lobster';
const HOST_HOME_GATEWAY_CWD = 'aries-app/lobster';

const OPENCLAW_ENV_KEYS = [
  'OPENCLAW_GATEWAY_URL',
  'OPENCLAW_GATEWAY_TOKEN',
  'OPENCLAW_SESSION_KEY',
  'OPENCLAW_GATEWAY_LOBSTER_CWD',
] as const;

type OpenClawEnvKey = typeof OPENCLAW_ENV_KEYS[number];

type DiagnosticReport = {
  ok: boolean;
  marker: string;
  reportPath: string;
  gatewayConfigured: boolean;
  gatewayHost: string | null;
  effectiveGatewayHost: string | null;
  requested: {
    tool: 'lobster';
    cwd: string;
    workflow: string;
    outputLocation: string;
  };
  result?: unknown;
  error?: {
    name: string;
    code?: string;
    status?: number;
    message: string;
  };
  fix?: string;
};

function parseDotenv(text: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const equals = line.indexOf('=');
    if (equals <= 0) continue;

    const key = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

function defaultGatewayCwdForSmoke(): string {
  const raw = process.env.OPENCLAW_GATEWAY_URL?.trim();
  if (raw) {
    try {
      const url = new URL(raw);
      if (url.hostname === 'host.docker.internal') {
        return HOST_HOME_GATEWAY_CWD;
      }
    } catch {
      // Invalid URL is handled by gatewayConfigured/selectReachableGatewayUrlForSmoke.
    }
  }
  return REPO_ROOT_GATEWAY_CWD;
}

async function loadGatewayEnvForSmoke(): Promise<{
  previous: Map<OpenClawEnvKey, string | undefined>;
  loadedFrom: string[];
}> {
  const previous = new Map<OpenClawEnvKey, string | undefined>();
  for (const key of OPENCLAW_ENV_KEYS) {
    previous.set(key, process.env[key]);
  }

  const loadedFrom: string[] = [];
  for (const envFile of ['.env.local', '.env']) {
    const envPath = path.join(PROJECT_ROOT, envFile);
    let text = '';
    try {
      text = await readFile(envPath, 'utf8');
    } catch {
      continue;
    }

    const values = parseDotenv(text);
    let loadedAny = false;
    for (const key of OPENCLAW_ENV_KEYS) {
      if (!process.env[key] && values[key]) {
        process.env[key] = values[key];
        loadedAny = true;
      }
    }
    if (loadedAny) loadedFrom.push(envFile);
  }

  // Aries must call the OpenClaw Lobster tool from the repo-relative Lobster cwd.
  // This is the output-location contract the live gateway needs in order to find
  // checked-in workflows and write diagnostics to ../.artifacts.
  if (!process.env.OPENCLAW_GATEWAY_LOBSTER_CWD) {
    process.env.OPENCLAW_GATEWAY_LOBSTER_CWD = defaultGatewayCwdForSmoke();
  }

  return { previous, loadedFrom };
}

function restoreGatewayEnv(previous: Map<OpenClawEnvKey, string | undefined>): void {
  for (const key of OPENCLAW_ENV_KEYS) {
    const value = previous.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function hostForUrl(raw: string | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    const url = new URL(raw);
    return url.host;
  } catch {
    return '<invalid-url>';
  }
}

function gatewayHostForReport(): string | null {
  return hostForUrl(process.env.OPENCLAW_GATEWAY_URL);
}

async function gatewayHealthOk(rawUrl: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  url.pathname = '/health';
  url.search = '';
  url.hash = '';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_500);
  try {
    const response = await fetch(url, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function selectReachableGatewayUrlForSmoke(): Promise<string | null> {
  const configured = process.env.OPENCLAW_GATEWAY_URL?.trim();
  if (!configured) return null;

  const candidates = [configured];
  try {
    const parsed = new URL(configured);
    if (parsed.hostname === 'host.docker.internal' && parsed.port) {
      const loopback = new URL(configured);
      loopback.hostname = '127.0.0.1';
      candidates.push(loopback.toString().replace(/\/$/, ''));
    }
  } catch {
    return null;
  }

  for (const candidate of candidates) {
    if (await gatewayHealthOk(candidate)) {
      process.env.OPENCLAW_GATEWAY_URL = candidate.replace(/\/$/, '');
      return process.env.OPENCLAW_GATEWAY_URL;
    }
  }

  return null;
}

function gatewayConfigured(): boolean {
  return Boolean(process.env.OPENCLAW_GATEWAY_URL?.trim() && process.env.OPENCLAW_GATEWAY_TOKEN?.trim());
}

async function writeDiagnosticReport(report: DiagnosticReport): Promise<void> {
  await mkdir(path.dirname(report.reportPath), { recursive: true });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(report.reportPath, serialized);
  await writeFile(path.join(ARTIFACT_DIR, 'latest.json'), serialized);
}

function outputRecordFromEnvelope(envelope: unknown): Record<string, unknown> {
  assert.ok(envelope && typeof envelope === 'object', 'Lobster gateway smoke returned a non-object envelope.');
  const candidate = envelope as { ok?: unknown; status?: unknown; output?: unknown };
  assert.equal(candidate.ok, true, 'Lobster gateway smoke envelope must report ok=true.');
  assert.equal(candidate.status, 'ok', 'Lobster gateway smoke envelope must complete without approvals.');
  assert.ok(Array.isArray(candidate.output), 'Lobster gateway smoke envelope must include an output array.');
  const output = candidate.output as unknown[];
  assert.equal(output.length, 1, 'Lobster gateway smoke must emit exactly one diagnostic output object.');
  const first = output[0];
  assert.ok(first && typeof first === 'object' && !Array.isArray(first), 'Diagnostic output must be an object.');
  return first as Record<string, unknown>;
}

test('live OpenClaw gateway exposes the lobster tool and writes the diagnostic output location', async (t) => {
  const marker = `aries-lobster-gateway-${Date.now()}`;
  const reportPath = path.join(ARTIFACT_DIR, `${marker}.json`);
  const outputLocation = `../.artifacts/openclaw-lobster-availability/${marker}.workflow.json`;
  const { previous } = await loadGatewayEnvForSmoke();

  try {
    if (!gatewayConfigured()) {
      t.skip('OPENCLAW_GATEWAY_URL and OPENCLAW_GATEWAY_TOKEN are not configured; skipping live Lobster gateway availability smoke.');
      return;
    }

    const configuredGatewayHost = gatewayHostForReport();
    const effectiveGatewayUrl = await selectReachableGatewayUrlForSmoke();
    const cwd = process.env.OPENCLAW_GATEWAY_LOBSTER_CWD?.trim() || defaultGatewayCwdForSmoke();
    const baseReport: Omit<DiagnosticReport, 'ok'> = {
      marker,
      reportPath,
      gatewayConfigured: true,
      gatewayHost: configuredGatewayHost,
      effectiveGatewayHost: hostForUrl(effectiveGatewayUrl ?? undefined),
      requested: {
        tool: 'lobster',
        cwd,
        workflow: DIAGNOSTIC_WORKFLOW,
        outputLocation,
      },
    };

    assert.ok(
      !path.isAbsolute(cwd) && (cwd === REPO_ROOT_GATEWAY_CWD || cwd.endsWith(`/${REPO_ROOT_GATEWAY_CWD}`)),
      `OpenClaw Lobster gateway cwd must be a repo-relative path ending in '${REPO_ROOT_GATEWAY_CWD}' ` +
        `so Aries workflows and diagnostic output resolve correctly. Set OPENCLAW_GATEWAY_LOBSTER_CWD to ` +
        `'${REPO_ROOT_GATEWAY_CWD}' when OpenClaw starts from the repo root, or '${HOST_HOME_GATEWAY_CWD}' ` +
        `when the OpenClaw gateway service starts from /home/node. Diagnostic report: ${reportPath}`,
    );

    const { OpenClawGatewayError, runOpenClawLobsterWorkflow } = await import('../backend/openclaw/gateway-client');

    try {
      const envelope = await runOpenClawLobsterWorkflow({
        pipeline: DIAGNOSTIC_WORKFLOW,
        argsJson: JSON.stringify({
          marker,
          output_location: outputLocation,
        }),
        cwd,
        timeoutMs: 15_000,
        maxStdoutBytes: 256 * 1024,
        allowLocalFallback: false,
      });
      const diagnostic = outputRecordFromEnvelope(envelope);

      assert.equal(diagnostic.lobster_tool, 'available');
      assert.equal(diagnostic.marker, marker);
      assert.equal(diagnostic.output_location_requested, outputLocation);
      assert.equal(diagnostic.workflow, DIAGNOSTIC_WORKFLOW);

      await writeDiagnosticReport({
        ...baseReport,
        ok: true,
        result: diagnostic,
      });
    } catch (error) {
      const gatewayError = error instanceof OpenClawGatewayError ? error : null;
      const report: DiagnosticReport = {
        ...baseReport,
        ok: false,
        error: {
          name: error instanceof Error ? error.name : typeof error,
          ...(gatewayError?.code ? { code: gatewayError.code } : {}),
          ...(gatewayError?.status ? { status: gatewayError.status } : {}),
          message: error instanceof Error ? error.message : String(error),
        },
        fix:
          gatewayError?.code === 'openclaw_gateway_tool_unavailable'
            ? "OpenClaw is reachable but does not expose the 'lobster' tool. Add tools.alsoAllow: ['lobster'] for the active gateway/agent config path and restart OpenClaw."
            : "Check the OpenClaw gateway process, OPENCLAW_GATEWAY_* env, OPENCLAW_GATEWAY_LOBSTER_CWD, and the diagnostic workflow output location.",
      };
      await writeDiagnosticReport(report);

      if (gatewayError?.code === 'openclaw_gateway_tool_unavailable') {
        assert.fail(
          "OpenClaw gateway is reachable but does not expose the 'lobster' tool. " +
            "Add tools.alsoAllow: ['lobster'] to the active gateway/agent config path and restart OpenClaw. " +
            `Diagnostic report: ${reportPath}`,
        );
      }

      assert.fail(
        `OpenClaw Lobster gateway availability smoke failed: ${report.error?.message}. Diagnostic report: ${reportPath}`,
      );
    }
  } finally {
    restoreGatewayEnv(previous);
  }
});
