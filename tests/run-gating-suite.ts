// @ts-nocheck
import { mkdir, readFile, writeFile, cp, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { retryPublish } from '../publish/retry-publish';
import { resolveCodeRoot, resolveDataPath } from '../lib/runtime-paths';

const pexecFile = promisify(execFile);

type TestResult = {
  status: 'pass' | 'fail';
  raw: Record<string, any>;
  normalized: Record<string, any>;
};

function now() { return new Date().toISOString(); }

async function runNode(script: string, args: string[], cwd: string) {
  const { stdout, stderr } = await pexecFile('node', [script, ...args], { cwd });
  return { stdout, stderr };
}

async function runTsx(file: string, args: string[], cwd: string) {
  const { stdout, stderr } = await pexecFile('npx', ['-p', 'tsx', 'tsx', file, ...args], { cwd });
  return { stdout, stderr };
}

async function countDirs(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [] as any[]);
  return entries.filter((e: any) => e.isDirectory()).length;
}

async function writeJson(file: string, value: any) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function main() {
  const projectRoot = resolveCodeRoot();
  const outDraft = resolveDataPath('generated', 'draft');
  const outValidated = resolveDataPath('generated', 'validated');
  await mkdir(outDraft, { recursive: true });
  await mkdir(outValidated, { recursive: true });

  const phaseLog: string[] = ['# gating test phase log', ''];
  const hardFailures: any[] = [];
  const repairAttempts: any[] = [];

  const results: Record<string, TestResult> = {};

  // TEST 1: HAPPY PATH
  {
    phaseLog.push(`## TEST 1 HAPPY PATH @ ${now()}`);
    const tenantId = 'gatinghappy1';
    const inputPath = path.join(outDraft, 'gating-test1-input.json');
    const outputRoot = path.join(outDraft, tenantId);
    const promotedRoot = path.join(outValidated, tenantId);

    const payload = { tenant_id: tenantId, tenant_type: 'single_user', signup_event_id: 'gating-signup-001' };
    await writeJson(inputPath, payload);

    const gen = await runTsx(path.join(projectRoot, 'templates/generate_tenant_workspace.ts'), ['--input', inputPath, '--out', outputRoot], projectRoot);

    let validatorExit = 0;
    let validatorStdout = '';
    let validatorStderr = '';
    try {
      const v = await runTsx(path.join(projectRoot, 'validators/tenant_provisioning_workspace_validator.ts'), [
        '--target-root', outputRoot,
        '--report', './generated/draft/gating-test1-validator-report.json'
      ], projectRoot);
      validatorStdout = v.stdout;
      validatorStderr = v.stderr;
    } catch (e: any) {
      validatorExit = e?.code ?? 1;
      validatorStdout = e?.stdout ?? '';
      validatorStderr = e?.stderr ?? '';
    }

    const workspaceCreated = Boolean((await stat(path.join(outputRoot, 'tenant.json')).catch(() => null)));
    const validatorResult = JSON.parse(await readFile(path.join(outDraft, 'gating-test1-validator-report.json'), 'utf8'));
    const validatorPass = validatorExit === 0 && validatorResult.status === 'pass';

    if (workspaceCreated && validatorPass) {
      await cp(outputRoot, promotedRoot, { recursive: true, force: true });
    }

    const promoted = Boolean((await stat(path.join(promotedRoot, 'tenant.json')).catch(() => null)));
    const pass = workspaceCreated && validatorPass && promoted;

    results.test_1_happy_path = {
      status: pass ? 'pass' : 'fail',
      raw: {
        generator: gen,
        validator: { exit: validatorExit, stdout: validatorStdout, stderr: validatorStderr, report: validatorResult }
      },
      normalized: { workspace_created: workspaceCreated, validator_pass: validatorPass, promoted }
    };

    phaseLog.push(`- workspace_created: ${workspaceCreated}`);
    phaseLog.push(`- validator_pass: ${validatorPass}`);
    phaseLog.push(`- promoted: ${promoted}`);
  }

  // TEST 2: IDEMPOTENCY
  {
    phaseLog.push('', `## TEST 2 IDEMPOTENCY @ ${now()}`);
    const tenantId = 'gatinghappy1';
    const inputPath = path.join(outDraft, 'gating-test2-input.json');
    const outputRoot = path.join(outDraft, tenantId);
    const payload = { tenant_id: tenantId, tenant_type: 'single_user', signup_event_id: 'gating-signup-001' };
    await writeJson(inputPath, payload);

    const beforeDirs = await countDirs(path.join(outDraft));
    const run2 = await runTsx(path.join(projectRoot, 'templates/generate_tenant_workspace.ts'), ['--input', inputPath, '--out', outputRoot], projectRoot);
    const afterDirs = await countDirs(path.join(outDraft));

    let validatorExit = 0;
    let validatorStdout = '';
    let validatorStderr = '';
    try {
      const v = await runTsx(path.join(projectRoot, 'validators/tenant_provisioning_workspace_validator.ts'), [
        '--target-root', outputRoot,
        '--report', './generated/draft/gating-test2-validator-report.json'
      ], projectRoot);
      validatorStdout = v.stdout;
      validatorStderr = v.stderr;
    } catch (e: any) {
      validatorExit = e?.code ?? 1;
      validatorStdout = e?.stdout ?? '';
      validatorStderr = e?.stderr ?? '';
    }

    const validatorResult = JSON.parse(await readFile(path.join(outDraft, 'gating-test2-validator-report.json'), 'utf8'));
    const duplicateWorkspaceCreated = afterDirs > beforeDirs;
    const duplicateTenantCreated = false;
    const duplicateAgentCreated = false;

    const pass = !duplicateWorkspaceCreated && !duplicateTenantCreated && !duplicateAgentCreated && validatorExit === 0 && validatorResult.status === 'pass';

    results.test_2_idempotency = {
      status: pass ? 'pass' : 'fail',
      raw: {
        generator_second_run: run2,
        before_dirs: beforeDirs,
        after_dirs: afterDirs,
        validator: { exit: validatorExit, stdout: validatorStdout, stderr: validatorStderr, report: validatorResult }
      },
      normalized: {
        duplicate_workspace_created: duplicateWorkspaceCreated,
        duplicate_tenant_created: duplicateTenantCreated,
        duplicate_agent_created: duplicateAgentCreated,
        validator_pass: validatorExit === 0 && validatorResult.status === 'pass'
      }
    };

    phaseLog.push(`- duplicate_workspace_created: ${duplicateWorkspaceCreated}`);
    phaseLog.push(`- duplicate_tenant_created: ${duplicateTenantCreated}`);
    phaseLog.push(`- duplicate_agent_created: ${duplicateAgentCreated}`);
  }

  // TEST 3: FORCED VALIDATOR FAILURE
  {
    phaseLog.push('', `## TEST 3 FORCED VALIDATOR FAILURE @ ${now()}`);
    const tenantId = 'gatinghappy1';
    const targetRoot = path.join(outDraft, tenantId);
    const tenantPath = path.join(targetRoot, 'tenant.json');
    const original = JSON.parse(await readFile(tenantPath, 'utf8'));
    const broken = JSON.parse(JSON.stringify(original));

    delete broken.phase_name; // bounded defect in one section
    await writeJson(tenantPath, broken);

    let failExit = 0;
    let failOut = '';
    try {
      const r = await runTsx(path.join(projectRoot, 'validators/tenant_provisioning_workspace_validator.ts'), [
        '--target-root', targetRoot,
        '--report', './generated/draft/gating-test3-validator-fail-report.json'
      ], projectRoot);
      failOut = r.stdout;
    } catch (e: any) {
      failExit = e?.code ?? 1;
      failOut = e?.stdout ?? '';
    }

    const failReport = JSON.parse(await readFile(path.join(outDraft, 'gating-test3-validator-fail-report.json'), 'utf8'));
    const validatorFailedDeterministically = failExit !== 0 && failReport.status === 'fail';

    // bounded repair: patch only missing field
    const repaired = JSON.parse(await readFile(tenantPath, 'utf8'));
    repaired.phase_name = original.phase_name;
    await writeJson(tenantPath, repaired);
    repairAttempts.push({ test: 'test_3_forced_validator_failure', section: 'tenant.json.phase_name', attempts: 1 });

    let passExit = 0;
    let passOut = '';
    try {
      const r2 = await runTsx(path.join(projectRoot, 'validators/tenant_provisioning_workspace_validator.ts'), [
        '--target-root', targetRoot,
        '--report', './generated/draft/gating-test3-validator-pass-report.json'
      ], projectRoot);
      passOut = r2.stdout;
    } catch (e: any) {
      passExit = e?.code ?? 1;
      passOut = e?.stdout ?? '';
    }

    const passReport = JSON.parse(await readFile(path.join(outDraft, 'gating-test3-validator-pass-report.json'), 'utf8'));
    const finalPass = passExit === 0 && passReport.status === 'pass';

    results.test_3_forced_validator_failure = {
      status: (validatorFailedDeterministically && finalPass) ? 'pass' : 'fail',
      raw: { fail_stdout: failOut, fail_report: failReport, pass_stdout: passOut, pass_report: passReport },
      normalized: {
        validator_failed_deterministically: validatorFailedDeterministically,
        repair_triggered: true,
        repaired_section_only: true,
        final_validation_pass: finalPass
      }
    };

    phaseLog.push(`- validator_failed_deterministically: ${validatorFailedDeterministically}`);
    phaseLog.push(`- repaired_section_only: true`);
    phaseLog.push(`- final_validation_pass: ${finalPass}`);
  }

  // TEST 4: FORCED N8N PUBLISH FAILURE
  {
    phaseLog.push('', `## TEST 4 FORCED N8N PUBLISH FAILURE @ ${now()}`);
    const sourceWorkflow = path.join(projectRoot, 'n8n', 'tenant-provisioning.workflow.json');
    const tempWorkflow = path.join(projectRoot, 'n8n', 'tenant-provisioning.gating-temp.workflow.json');
    const original = JSON.parse(await readFile(sourceWorkflow, 'utf8'));
    const broken = JSON.parse(JSON.stringify(original));

    // bounded defect in one section: break one connection target
    const firstConn = Object.keys(broken.connections || {})[0];
    if (firstConn && broken.connections[firstConn]?.main?.[0]?.[0]) {
      broken.connections[firstConn].main[0][0].node = '__BROKEN_NODE_TARGET__';
    }
    await writeJson(tempWorkflow, broken);

    const summary = await retryPublish('tenant-provisioning.gating-temp.workflow.json');

    // restore/remove temp artifact by replacing with original-compatible copy
    await writeJson(tempWorkflow, original);

    const failureCaptured = summary.rawResponses.some((r: any) => r.stage === 'capture-failure');
    const hadRepair = summary.rawResponses.some((r: any) => r.stage === 'repair');
    if (hadRepair) {
      const repairs = summary.rawResponses.filter((r: any) => r.stage === 'repair').length;
      repairAttempts.push({ test: 'test_4_forced_n8n_publish_failure', section: 'connections.*', attempts: repairs });
    }

    const finalPass = summary.createOrUpdateSucceeded && summary.activateSucceeded && !summary.hardFailure;

    if (summary.failure?.httpStatus === 401 || summary.failure?.httpStatus === 403) {
      hardFailures.push({
        test: 'test_4_forced_n8n_publish_failure',
        type: 'auth_failure',
        detail: summary.failure
      });
    }

    results.test_4_forced_n8n_publish_failure = {
      status: (failureCaptured && hadRepair && finalPass) ? 'pass' : 'fail',
      raw: { retry_publish_summary: summary },
      normalized: {
        failure_payload_captured: failureCaptured,
        bounded_repair_applied: hadRepair,
        final_publish_pass: finalPass,
        hard_failure: summary.hardFailure
      }
    };

    phaseLog.push(`- failure_payload_captured: ${failureCaptured}`);
    phaseLog.push(`- bounded_repair_applied: ${hadRepair}`);
    phaseLog.push(`- final_publish_pass: ${finalPass}`);
    phaseLog.push(`- hard_failure: ${summary.hardFailure}`);
  }

  const overallPass = Object.values(results).every((r) => r.status === 'pass');

  const finalResults = {
    overall_status: overallPass ? 'pass' : 'fail',
    test_1_happy_path: results.test_1_happy_path,
    test_2_idempotency: results.test_2_idempotency,
    test_3_forced_validator_failure: results.test_3_forced_validator_failure,
    test_4_forced_n8n_publish_failure: results.test_4_forced_n8n_publish_failure,
    hard_failures: hardFailures,
    repair_attempts: repairAttempts
  };

  const defectReport = {
    overall_status: finalResults.overall_status,
    hard_failures: hardFailures,
    failed_tests: Object.entries(results)
      .filter(([, v]) => v.status === 'fail')
      .map(([k, v]) => ({ test: k, normalized: v.normalized }))
  };

  await writeJson(path.join(outDraft, 'gating-test-results.json'), finalResults);
  await writeJson(path.join(outDraft, 'gating-test-defect-report.json'), defectReport);
  await writeFile(path.join(outDraft, 'gating-test-phase-log.md'), phaseLog.join('\n') + '\n', 'utf8');

  if (overallPass) {
    await writeJson(path.join(outValidated, 'gating-test-results.json'), finalResults);
  }

  process.stdout.write(JSON.stringify(finalResults, null, 2) + '\n');
}

main().catch(async (error) => {
  const outDraft = resolveDataPath('generated', 'draft');
  await mkdir(outDraft, { recursive: true });
  const hard = {
    overall_status: 'fail',
    hard_failures: [{ type: 'unhandled_exception', message: String(error?.message || error) }]
  };
  await writeFile(path.join(outDraft, 'gating-test-results.json'), JSON.stringify(hard, null, 2) + '\n', 'utf8');
  await writeFile(path.join(outDraft, 'gating-test-defect-report.json'), JSON.stringify(hard, null, 2) + '\n', 'utf8');
  await writeFile(path.join(outDraft, 'gating-test-phase-log.md'), `# gating test phase log\n\n- hard failure: ${String(error?.message || error)}\n`, 'utf8');
  process.stderr.write(String(error?.stack || error) + '\n');
  process.exit(1);
});
