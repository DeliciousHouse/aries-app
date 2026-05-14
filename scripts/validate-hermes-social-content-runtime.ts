import { env, exit } from 'node:process';

import { probeHermesSocialContentRuntime } from '../backend/marketing/hermes-runtime-contract';

async function main() {
  const report = await probeHermesSocialContentRuntime(env);
  const output = {
    ok: report.ok,
    workflow: report.workflow,
    callbackContract: report.callbackContract,
    gateway: {
      ok: report.gateway.ok,
      url: report.gateway.url,
      httpStatus: report.gateway.httpStatus,
      error: report.gateway.error ?? null,
    },
    capabilities: {
      ok: report.capabilities.ok,
      httpStatus: report.capabilities.httpStatus,
      requiredEndpoints: report.capabilities.requiredEndpoints,
      pollableRuns: report.capabilities.pollableRuns,
      error: report.capabilities.error ?? null,
    },
  };

  console.log(JSON.stringify(output, null, 2));
  exit(report.ok ? 0 : 1);
}

void main();
