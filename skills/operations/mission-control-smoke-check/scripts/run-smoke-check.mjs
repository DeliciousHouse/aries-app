#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { preflightOrExit, resolveBinary } from "../../../../scripts/automations/lib/common.mjs";

const missionControlRoot = process.env.MISSION_CONTROL_ROOT || "/home/node/.openclaw/projects/mission_control";
const essentialEndpointPaths = new Set([
  "/",
  "/ops",
  "/brain",
  "/lab",
  "/skills",
]);

const endpointSpecs = [
  {
    path: "/",
    summarize: () => "overview page",
  },
  {
    path: "/ops",
    summarize: () => "ops page",
  },
  {
    path: "/brain",
    summarize: () => "brain page",
  },
  {
    path: "/lab",
    summarize: () => "lab page",
  },
  {
    path: "/skills",
    summarize: () => "skills page",
  },
];

const jsonMode = process.argv.includes("--json");

let serverChild = null;

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});
process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(143);
});
process.on("exit", () => {
  if (serverChild && !serverChild.killed) {
    serverChild.kill("SIGTERM");
  }
});

async function main() {
  const startedAt = new Date().toISOString();
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const result = {
    header: "MISSION CONTROL SMOKE CHECK FAILED",
    status: "FAILED",
    build: { ok: false, detail: null },
    server: { ok: false, detail: null, url: baseUrl },
    endpoints: [],
    runtimeDetail: `root ${missionControlRoot}`,
    startedAt,
  };

  try {
    await runCommand(npmCommand, ["run", "build"], { cwd: missionControlRoot });
    result.build = { ok: true, detail: "ok" };

    const nextBinary = path.join(missionControlRoot, "node_modules", ".bin", "next");
    serverChild = spawn(nextBinary, ["start", "-H", "127.0.0.1", "-p", String(port)], {
      cwd: missionControlRoot,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let serverLog = "";
    serverChild.stdout.on("data", (chunk) => {
      serverLog += chunk.toString();
    });
    serverChild.stderr.on("data", (chunk) => {
      serverLog += chunk.toString();
    });
    serverChild.on("exit", (code) => {
      if (!result.server.ok && code !== 0) {
        result.server.detail = (serverLog || `next exited with ${code}`).trim();
      }
    });

    try {
      await waitForServer(baseUrl, 20000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const logTail = serverLog
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-20)
        .join(" | ");
      throw new Error(logTail ? `${message}; startup log: ${logTail}` : message);
    }

    result.server = { ok: true, detail: `ok (${baseUrl})`, url: baseUrl };

    for (const spec of endpointSpecs) {
      const endpoint = await probeEndpoint(baseUrl, spec.path, spec.summarize);
      result.endpoints.push(endpoint);
    }

    result.runtimeDetail = "page-route contract verified against the current standalone Mission Control shell";

    const failedEndpoints = result.endpoints.filter((entry) => !entry.ok);
    const failedEssentialEndpoints = failedEndpoints.filter((entry) => essentialEndpointPaths.has(entry.path));

    if (!result.build.ok || !result.server.ok || failedEssentialEndpoints.length > 0) {
      result.status = "FAILED";
    } else if (failedEndpoints.length > 0) {
      result.status = "PARTIAL";
    } else {
      result.status = "OK";
    }

    result.header = `MISSION CONTROL SMOKE CHECK ${result.status}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!result.build.ok) {
      result.build.detail = message;
    } else if (!result.server.ok) {
      result.server.detail = message;
    } else {
      result.runtimeDetail = message;
    }
  } finally {
    await cleanup();
  }

  if (jsonMode) {
    const payload = {
      status: result.status,
      header: result.header,
      build: result.build,
      server: result.server,
      endpoints: result.endpoints.map(({ payload, ...rest }) => rest),
      runtimeDetail: result.runtimeDetail,
      startedAt: result.startedAt,
    };
    console.log(JSON.stringify(payload, null, 2));
    process.exit(result.status === "FAILED" ? 1 : 0);
  }

  const passedEndpoints = result.endpoints.filter((entry) => entry.ok).length;
  const lines = [
    result.header,
    `- build: ${result.build.ok ? result.build.detail : `failed (${result.build.detail})`}`,
    `- server: ${result.server.ok ? result.server.detail : `failed (${result.server.detail})`}`,
    `- endpoints: ${passedEndpoints}/${endpointSpecs.length} passed`,
    ...result.endpoints.map((entry) => `- ${entry.path}: ${entry.statusCode ?? "ERR"} ${entry.summary}`),
  ];

  if (result.runtimeDetail) {
    lines.push(`- runtime detail: ${result.runtimeDetail}`);
  }

  console.log(lines.join("\n"));
  process.exit(result.status === "FAILED" ? 1 : 0);
}

async function probeEndpoint(baseUrl, routePath, summarize) {
  const response = await fetch(`${baseUrl}${routePath}`);
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }

  return {
    path: routePath,
    ok: response.ok,
    statusCode: response.status,
    summary: response.ok ? summarize(payload) : text.slice(0, 240).replace(/\s+/g, " ").trim(),
    payload,
  };
}

function resolveMissionControlRoot() {
  const candidates = [
    process.env.MISSION_CONTROL_ROOT,
    "/home/node/.openclaw/projects/mission_control",
    "/home/node/openclaw/projects/mission-control-builder/mission-control",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return candidates[0];
}

async function runCommand(command, args, options) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error((stderr || stdout || `${command} exited with ${code}`).trim()));
    });
  });
}

async function waitForServer(baseUrl, timeoutMs) {
  const start = Date.now();
  let lastError = "server did not respond";
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
      lastError = `server responded ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(lastError);
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not allocate a local port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function cleanup() {
  if (!serverChild || serverChild.killed) return;
  const child = serverChild;
  serverChild = null;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(2000).then(() => {
      if (!child.killed) child.kill("SIGKILL");
    }),
  ]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
