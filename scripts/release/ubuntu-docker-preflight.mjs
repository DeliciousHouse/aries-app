import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Evidence references must be reviewed by the operator; completeness is not
// authenticity, permission to mutate production, or proof of deployment.
export const requiredCheckpoints = [
  'launchOwnership',
  'storageIdentity',
  'appAndWorkerSettings',
  'restoredCopyCompatibility',
  'backupAndRollback',
  'reviewedReplacement',
];

export function preflightRelease(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new Error('A sanitized release plan is required; see docs/runbooks/ubuntu-docker-release.md');
  }
  if (plan.host !== 'ubuntu-docker') throw new Error('Invalid host');
  if (plan.origin !== 'https://aries.deliciouswines.org') throw new Error('Invalid origin');
  if (typeof plan.sha !== 'string' || !/^[a-f0-9]{40}$/.test(plan.sha)) throw new Error('Invalid sha');
  if (typeof plan.image !== 'string' || !/^ghcr\.io\/delicioushouse\/aries-app@sha256:[a-f0-9]{64}$/.test(plan.image)) {
    throw new Error('Invalid image: a registry digest is required');
  }
  if (!plan.checkpoints || typeof plan.checkpoints !== 'object' || Array.isArray(plan.checkpoints)) {
    throw new Error('Missing checkpoints');
  }
  for (const name of requiredCheckpoints) {
    const checkpoint = plan.checkpoints[name];
    if (!checkpoint || checkpoint.sha !== plan.sha || checkpoint.image !== plan.image
      || typeof checkpoint.evidence !== 'string' || !checkpoint.evidence.trim()) {
      throw new Error(`Missing or mismatched checkpoint: ${name}`);
    }
  }
  return { status: 'prepared_not_deployed', deployed: false, sha: plan.sha, image: plan.image };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let plan;
    if (process.argv[2]) {
      try {
        plan = JSON.parse(readFileSync(process.argv[2], 'utf8'));
      } catch {
        // Do not echo file contents or parser excerpts: input may be sensitive.
        throw new Error('Unreadable or invalid JSON release plan');
      }
    }
    console.log(JSON.stringify(preflightRelease(plan)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
