// @ts-nocheck
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { retryPublish } from './retry-publish';

async function main() {
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const workflowFile = process.env.N8N_WORKFLOW_FILE || 'tenant-provisioning.workflow.json';
  const workflowPath = path.join(projectRoot, 'n8n', workflowFile);
  const outDir = path.join(projectRoot, 'generated', 'draft');

  await mkdir(outDir, { recursive: true });

  const original = JSON.parse(await readFile(workflowPath, 'utf8'));
  const broken = JSON.parse(JSON.stringify(original));

  // Intentionally break a single section: first outgoing connection target.
  const connEntries = Object.entries(broken.connections || {});
  if (connEntries.length > 0) {
    const [src, cfg]: any = connEntries[0];
    if (Array.isArray(cfg?.main) && Array.isArray(cfg.main[0]) && cfg.main[0][0]) {
      cfg.main[0][0].node = '__BROKEN_NODE_TARGET__';
      broken.connections[src] = cfg;
    }
  }

  await writeFile(workflowPath, JSON.stringify(broken, null, 2), 'utf8');

  let summary: any;
  try {
    summary = await retryPublish(workflowFile);
  } finally {
    // restore source artifact after simulation run
    await writeFile(workflowPath, JSON.stringify(original, null, 2), 'utf8');
  }

  const proof = {
    simulatedFailureInjected: true,
    failureCaptureWorked: Boolean(summary?.failure || summary?.rawResponses?.some((r: any) => r.stage === 'capture-failure')),
    boundedRepairSucceeded: Boolean(summary?.repairLoopSucceeded),
    summary
  };

  await writeFile(path.join(outDir, 'n8n-publish-results.json'), JSON.stringify(proof, null, 2), 'utf8');

  console.log(JSON.stringify(proof, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (error) => {
    const projectRoot = process.env.PROJECT_ROOT || process.cwd();
    const outDir = path.join(projectRoot, 'generated', 'draft');
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'n8n-publish-results.json'), JSON.stringify({
      simulatedFailureInjected: true,
      failureCaptureWorked: false,
      boundedRepairSucceeded: false,
      hardFailure: true,
      error: String(error?.message || error)
    }, null, 2), 'utf8');
    console.error(error);
    process.exit(1);
  });
}
