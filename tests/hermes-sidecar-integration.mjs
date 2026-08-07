import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const HERMES_IMAGE =
  'nousresearch/hermes-agent:v2026.8.3@sha256:16788311e2fa3035456bdc1bafb8ec2b1777db64ebf020af9bb7eb73c3712c9e';
const HERMES_VERSION = '0.20.0';
const API_KEY = 'aries-hermes-sidecar-contract-key-2026';
const EXPECTED_OUTPUT = 'ARIES_HERMES_SIDECAR_OK';
const MODEL = 'aries-sidecar-contract';

function run(command, args, { allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      const result = { code, stdout: stdout.trim(), stderr: stderr.trim() };
      if (code === 0 || allowFailure) {
        resolve(result);
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} failed (${code})\n${stderr || stdout}`));
    });
  });
}

function docker(args, options) {
  return run('docker', args, options);
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 120_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Hermes sidecar did not become healthy: ${String(lastError?.message || lastError)}`);
}

async function waitForRun(baseUrl, runId) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(5_000),
    });
    const responseBody = await response.text();
    assert.equal(response.status, 200, responseBody);
    const runRecord = JSON.parse(responseBody);
    if (['completed', 'failed', 'cancelled'].includes(runRecord.status)) return runRecord;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Hermes run ${runId} did not finish`);
}

const providerSource = String.raw`
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODEL = "${MODEL}"
OUTPUT = "${EXPECTED_OUTPUT}"

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        print("provider " + (format % args), flush=True)

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            self.send_json({"object": "list", "data": [{"id": MODEL, "object": "model"}]})
            return
        self.send_json({"error": "not found"}, 404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        payload = json.loads(self.rfile.read(length) or b"{}")
        if not self.path.rstrip("/").endswith("/chat/completions"):
            self.send_json({"error": "not found"}, 404)
            return
        print("provider generation request", flush=True)
        if payload.get("stream"):
            chunks = [
                {
                    "id": "chatcmpl-aries-sidecar",
                    "object": "chat.completion.chunk",
                    "created": 1,
                    "model": MODEL,
                    "choices": [{"index": 0, "delta": {"role": "assistant", "content": OUTPUT}, "finish_reason": None}],
                },
                {
                    "id": "chatcmpl-aries-sidecar",
                    "object": "chat.completion.chunk",
                    "created": 1,
                    "model": MODEL,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                },
            ]
            body = "".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks) + "data: [DONE]\n\n"
            encoded = body.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
            self.wfile.flush()
            return
        self.send_json({
            "id": "chatcmpl-aries-sidecar",
            "object": "chat.completion",
            "created": 1,
            "model": MODEL,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": OUTPUT}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
        })

ThreadingHTTPServer(("0.0.0.0", 18080), Handler).serve_forever()
`;

const suffix = randomUUID().slice(0, 8);
const networkName = `aries-hermes-contract-${suffix}`;
const providerName = `aries-hermes-provider-${suffix}`;
const sidecarName = `aries-hermes-sidecar-${suffix}`;
const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'aries-hermes-sidecar-'));
const providerPath = path.join(dataRoot, 'provider.py');
const configPath = path.join(dataRoot, 'config.yaml');
let failure;

try {
  await writeFile(providerPath, providerSource);
  await writeFile(configPath, [
    '_config_version: 33',
    'model:',
    `  default: ${MODEL}`,
    '  provider: custom',
    '  base_url: http://provider:18080/v1',
    '  api_key: no-key-required',
    '',
  ].join('\n'));
  await chmod(dataRoot, 0o755);
  await chmod(providerPath, 0o644);
  await chmod(configPath, 0o644);

  await docker(['network', 'create', networkName]);
  await docker([
    'run', '--detach', '--name', providerName, '--network', networkName,
    '--network-alias', 'provider', '--entrypoint', '/opt/hermes/.venv/bin/python',
    '--volume', `${providerPath}:/mock-provider.py:ro`, HERMES_IMAGE, '/mock-provider.py',
  ]);
  await docker([
    'run', '--detach', '--name', sidecarName, '--network', networkName,
    '--publish', '127.0.0.1::8642',
    '--env', `HERMES_UID=${typeof process.getuid === 'function' ? process.getuid() : 1000}`,
    '--env', `HERMES_GID=${typeof process.getgid === 'function' ? process.getgid() : 1000}`,
    '--env', 'API_SERVER_ENABLED=true',
    '--env', 'API_SERVER_HOST=0.0.0.0',
    '--env', 'API_SERVER_PORT=8642',
    '--env', `API_SERVER_KEY=${API_KEY}`,
    '--volume', `${dataRoot}:/opt/data`,
    HERMES_IMAGE, 'gateway', 'run',
  ]);

  const portResult = await docker(['port', sidecarName, '8642/tcp']);
  const port = portResult.stdout.match(/:(\d+)$/)?.[1];
  assert.ok(port, `unable to resolve sidecar port from: ${portResult.stdout}`);
  const baseUrl = `http://127.0.0.1:${port}`;

  const health = await waitForHealth(baseUrl);
  assert.deepEqual(
    { status: health.status, platform: health.platform, version: health.version },
    { status: 'ok', platform: 'hermes-agent', version: HERMES_VERSION },
  );
  const image = await docker(['inspect', '--format', '{{.Config.Image}}', sidecarName]);
  assert.equal(image.stdout, HERMES_IMAGE);

  const startResponse = await fetch(`${baseUrl}/v1/runs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ input: `Reply with exactly ${EXPECTED_OUTPUT}. Do not use tools.` }),
    signal: AbortSignal.timeout(10_000),
  });
  const startBody = await startResponse.text();
  assert.equal(startResponse.status, 202, startBody);
  const started = JSON.parse(startBody);
  assert.match(started.run_id, /^run_[a-f0-9]+$/);

  const completed = await waitForRun(baseUrl, started.run_id);
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  assert.equal(completed.output, EXPECTED_OUTPUT);
  const providerLogs = await docker(['logs', providerName]);
  assert.match(providerLogs.stdout, /provider generation request/);

  console.log(`[hermes-sidecar-contract] ${health.platform} ${health.version} generation round-trip ok`);
} catch (error) {
  failure = error;
  for (const name of [sidecarName, providerName]) {
    const logs = await docker(['logs', name], { allowFailure: true });
    if (logs.stdout || logs.stderr) {
      console.error(`--- ${name} logs ---\n${logs.stdout}\n${logs.stderr}`);
    }
  }
} finally {
  await docker(['rm', '--force', sidecarName, providerName], { allowFailure: true });
  await docker(['network', 'rm', networkName], { allowFailure: true });
  await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined);
}

if (failure) throw failure;
