#!/usr/bin/env node
import { spawn } from "node:child_process";
import net from "node:net";
import process from "node:process";

const missionControlRoot = "/app/mission-control";
const essentialEndpointPaths = new Set([
  "/api/app/command",
  "/api/app/build-lab",
  "/api/org",
  "/api/app/runtime",
]);

const endpointSpecs = [
  {
    path: "/api/app/command",
    summarize: (payload) => `${payload?.data?.tasks?.length ?? 0} tasks`,
  },
  {
    path: "/api/app/briefing",
    summarize: (payload) => `HTTP ${payload ? 200 : "200"}`,
  },
  {
    path: "/api/app/build-lab",
    summarize: (payload) => `${Object.keys(payload?.data || {}).length} sections`,
  },
  {
    path: "/api/cron-health",
    summarize: (payload) => {
      const stats = payload?.data?.stats || {};
      return `healthy ${stats.healthy ?? 0}, failed ${stats.failed ?? 0}, unavailable ${stats.unavailable ?? 0}, disconnected ${stats.disconnected ?? 0}`;
    },
  },
  {
    path: "/api/org",
    summarize: (payload) => `${payload?.data?.members?.length ?? 0} members`,
  },
  {
    path: "/api/app/runtime",
    summarize: (payload) => `${payload?.data?.sources?.length ?? 0} sources`,
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
    runtimeDetail: null,
    startedAt,
  };

  try {
    await runCommand("npm", ["run", "build"], { cwd: missionControlRoot });
    result.build = { ok: true, detail: "ok" };

    serverChild = spawn("node", ["server/index.mjs"], {
      cwd: missionControlRoot,
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let serverLog = "";
    serverChild.stdout.on("data", (chunk) => {
      serverLog += chunk.toString();
    });
    serverChild.stderr.on("data", (chunk) => {
      serverLog += chunk.toString();
    });

    await waitForServer(baseUrl, 20000);
    result.server = { ok: true, detail: `ok (${baseUrl})`, url: baseUrl };

    for (const spec of endpointSpecs) {
      const endpoint = await probeEndpoint(baseUrl, spec.path, spec.summarize);
      result.endpoints.push(endpoint);
    }

    const runtimePayload = result.endpoints.find((entry) => entry.path === "/api/app/runtime")?.payload;
    result.runtimeDetail = summarizeRuntime(runtimePayload?.data);

    const failedEndpoints = result.endpoints.filter((entry) => !entry.ok);
    const failedEssentialEndpoints = failedEndpoints.filter((entry) => essentialEndpointPaths.has(entry.path));
    const problematicRuntime = runtimeProblems(runtimePayload?.data);

    if (!result.build.ok || !result.server.ok || failedEssentialEndpoints.length > 0) {
      result.status = "FAILED";
    } else if (failedEndpoints.length > 0 || problematicRuntime.length > 0) {
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

async function probeEndpoint(baseUrl, path, summarize) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = null;
  }

  return {
    path,
    ok: response.ok,
    statusCode: response.status,
    summary: response.ok ? summarize(payload) : text.slice(0, 240).replace(/\s+/g, " ").trim(),
    payload,
  };
}

function summarizeRuntime(runtime) {
  if (!runtime) return "runtime payload unavailable";
  const parts = [];

  if (runtime.sessions?.state) parts.push(`sessions are ${runtime.sessions.state}`);
  if (runtime.health?.state) parts.push(`health is ${runtime.health.state}`);
  if (runtime.modelUsage?.state) parts.push(`models are ${runtime.modelUsage.state}`);

  if (runtime.tasks?.state === "disconnected") {
    if (/intentional|fast runtime path|fast initial runtime path/i.test(runtime.tasks?.detail || "")) {
      parts.push("tasks are intentionally disconnected on the fast path");
    } else {
      parts.push(`tasks are disconnected${runtime.tasks?.detail ? ` because ${runtime.tasks.detail}` : ""}`);
    }
  } else if (runtime.tasks?.state) {
    parts.push(`tasks are ${runtime.tasks.state}`);
  }

  if (runtime.flows?.state === "disconnected") {
    if (/intentional|fast runtime path|fast initial runtime path/i.test(runtime.flows?.detail || "")) {
      parts.push("flows are intentionally disconnected on the fast path");
    } else {
      parts.push(`flows are disconnected${runtime.flows?.detail ? ` because ${runtime.flows.detail}` : ""}`);
    }
  } else if (runtime.flows?.state) {
    parts.push(`flows are ${runtime.flows.state}`);
  }

  if (runtime.cron?.state === "disconnected") {
    parts.push(`cron-list is disconnected${runtime.cron?.detail ? ` because ${runtime.cron.detail}` : ""}`);
  } else if (runtime.cron?.state) {
    parts.push(`cron-list is ${runtime.cron.state}`);
  }

  return parts.join("; ");
}

function runtimeProblems(runtime) {
  if (!runtime) return ["runtime payload unavailable"];
  const problems = [];

  const check = (label, state, detail, allowIntentional = false) => {
    if (!state) return;
    if (state === "connected" || state === "empty") return;
    if (allowIntentional && state === "disconnected" && /intentional|fast runtime path|fast initial runtime path/i.test(detail || "")) return;
    problems.push(`${label}:${state}`);
  };

  check("sessions", runtime.sessions?.state, runtime.sessions?.detail);
  check("health", runtime.health?.state, runtime.health?.detail);
  check("models", runtime.modelUsage?.state, runtime.modelUsage?.detail);
  check("tasks", runtime.tasks?.state, runtime.tasks?.detail, true);
  check("flows", runtime.flows?.state, runtime.flows?.detail, true);
  check("cron", runtime.cron?.state, runtime.cron?.detail);

  return problems;
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
