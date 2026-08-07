#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function required(value, name) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function parseJson(value, description) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${description} returned invalid JSON.`);
  }
}

function checked(run, command, args, description) {
  const commandResult = run(command, args);
  if (commandResult.status !== 0) {
    throw new Error(`${description} failed: ${commandResult.stderr.trim() || `exit ${commandResult.status}`}`);
  }
  return commandResult;
}

function lookupTag(environment, run) {
  const reference = `refs/tags/${environment.releaseTag}`;
  const lookup = run('git', ['ls-remote', '--exit-code', '--refs', '--tags', 'origin', reference]);
  if (lookup.status === 2 && lookup.stdout.trim() === '' && lookup.stderr.trim() === '') {
    return { state: 'absent', sha: null };
  }
  if (lookup.status !== 0) {
    throw new Error(`Tag lookup failed: ${lookup.stderr.trim() || `exit ${lookup.status}`}`);
  }

  checked(
    run,
    'git',
    ['fetch', '--force', 'origin', `${reference}:${reference}`],
    `Fetching ${environment.releaseTag}`,
  );
  const resolved = checked(
    run,
    'git',
    ['rev-parse', `${environment.releaseTag}^{commit}`],
    `Resolving ${environment.releaseTag}`,
  ).stdout.trim();
  if (!SHA_PATTERN.test(resolved)) throw new Error(`Tag lookup failed: invalid commit SHA ${resolved}.`);
  return { state: 'found', sha: resolved };
}

function lookupRelease(environment, run) {
  const response = run('gh', [
    'api',
    `repos/${environment.repository}/releases/tags/${environment.releaseTag}`,
  ]);
  if (response.status !== 0) {
    if (/\(HTTP 404\)\s*$/m.test(response.stderr)) return { state: 'absent', release: null };
    throw new Error(`Release lookup failed: ${response.stderr.trim() || `exit ${response.status}`}`);
  }

  const release = parseJson(response.stdout, 'Release lookup');
  if (!Number.isInteger(release.id) || release.id <= 0) throw new Error('Release lookup failed: missing release id.');
  if (release.tag_name !== environment.releaseTag) {
    throw new Error(`Release lookup failed: expected tag ${environment.releaseTag}, got ${release.tag_name}.`);
  }
  if (!SHA_PATTERN.test(release.target_commitish)) {
    throw new Error(`GitHub Release ${environment.releaseTag} is not pinned to a commit SHA.`);
  }
  return { state: 'found', release };
}

function registryReferenceIsAbsent(stderr) {
  return /manifest unknown|no such manifest|not found: manifest|failed to resolve reference .*: not found/i.test(stderr);
}

function lookupDigest(reference, description, run) {
  const response = run('docker', ['buildx', 'imagetools', 'inspect', reference]);
  if (response.status !== 0) {
    if (registryReferenceIsAbsent(response.stderr)) return { state: 'absent', digest: null };
    throw new Error(`${description} lookup failed: ${response.stderr.trim() || `exit ${response.status}`}`);
  }

  const digest = response.stdout.match(/^Digest:\s*(sha256:[0-9a-f]{64})\s*$/m)?.[1];
  if (!digest) throw new Error(`${description} lookup failed: response did not contain a valid digest.`);
  return { state: 'found', digest };
}

function lookupSuccessfulDeploy(environment, run) {
  const response = run('gh', [
    'api',
    '--method',
    'GET',
    `repos/${environment.repository}/actions/workflows/deploy.yml/runs`,
    '-f',
    `head_sha=${environment.releaseSha}`,
    '-f',
    'status=success',
    '-f',
    'per_page=100',
  ]);
  if (response.status !== 0) {
    throw new Error(`Deploy lookup failed: ${response.stderr.trim() || `exit ${response.status}`}`);
  }

  const runs = parseJson(response.stdout, 'Deploy lookup').workflow_runs;
  if (!Array.isArray(runs)) throw new Error('Deploy lookup failed: missing workflow_runs.');
  const successful = runs.find(
    (workflowRun) =>
      workflowRun?.event === 'push' &&
      workflowRun?.head_sha === environment.releaseSha &&
      workflowRun?.conclusion === 'success',
  );
  if (!successful) {
    throw new Error(`No successful Deploy workflow run exists for ${environment.releaseSha}.`);
  }
  return successful.id ?? null;
}

export function ensureImmutableAlias(target, source, expectedDigest, description, run) {
  if (!DIGEST_PATTERN.test(expectedDigest)) throw new Error(`${description} expected digest is invalid.`);
  const existing = lookupDigest(target, description, run);
  if (existing.digest && existing.digest !== expectedDigest) {
    throw new Error(`${description} ${target} targets ${existing.digest}, not ${expectedDigest}.`);
  }
  if (existing.state === 'absent') {
    checked(
      run,
      'docker',
      ['buildx', 'imagetools', 'create', '--tag', target, source],
      `Creating ${description}`,
    );
  }
  const published = lookupDigest(target, description, run);
  if (published.digest !== expectedDigest) {
    throw new Error(`${description} ${target} targets ${published.digest}, not ${expectedDigest}.`);
  }
  return published.digest;
}

function validateEnvironment(environment) {
  for (const [name, value] of [
    ['DEFAULT_SHA', environment.defaultSha],
    ['RELEASE_SHA', environment.releaseSha],
  ]) {
    if (!SHA_PATTERN.test(value)) throw new Error(`${name} must be a full lowercase commit SHA.`);
  }
  required(environment.image, 'IMAGE');
  required(environment.releaseTag, 'RELEASE_TAG');
  required(environment.releaseVersion, 'RELEASE_VERSION');
  required(environment.repository, 'GITHUB_REPOSITORY');
}

export function inspectReleaseState(environment, run) {
  validateEnvironment(environment);

  const tag = lookupTag(environment, run);
  if (tag.state === 'found' && tag.sha !== environment.releaseSha) {
    throw new Error(`Existing tag ${environment.releaseTag} targets ${tag.sha}, not ${environment.releaseSha}.`);
  }

  const releaseLookup = lookupRelease(environment, run);
  const release = releaseLookup.release;
  if (release && release.target_commitish !== environment.releaseSha) {
    throw new Error(
      `Existing GitHub Release ${environment.releaseTag} targets ${release.target_commitish}, not ${environment.releaseSha}.`,
    );
  }
  if (release && !release.draft && tag.state !== 'found') {
    throw new Error(`Published GitHub Release ${environment.releaseTag} has no matching Git tag.`);
  }
  if (!release && environment.releaseSha !== environment.defaultSha) {
    throw new Error(
      `First release attempt must target current default branch ${environment.defaultSha}, not ${environment.releaseSha}.`,
    );
  }

  const shaImage = lookupDigest(
    `${environment.image}:${environment.releaseSha}`,
    'Deployed commit image',
    run,
  );
  if (shaImage.state !== 'found') {
    throw new Error(`Deployed commit image ${environment.image}:${environment.releaseSha} was not found.`);
  }

  const versionImage = lookupDigest(
    `${environment.image}:${environment.releaseVersion}`,
    'Immutable version tag',
    run,
  );
  if (versionImage.digest && versionImage.digest !== shaImage.digest) {
    throw new Error(
      `Immutable version tag ${environment.image}:${environment.releaseVersion} targets ${versionImage.digest}, not ${shaImage.digest}.`,
    );
  }

  const deployRunId = lookupSuccessfulDeploy(environment, run);
  return {
    deployRunId,
    imageDigest: shaImage.digest,
    releaseId: release?.id ?? null,
    releaseState: release ? (release.draft ? 'draft' : 'published') : 'absent',
    tagSha: tag.sha,
    tagState: tag.state,
    versionDigest: versionImage.digest,
    versionState: versionImage.state,
  };
}

function assertSameSnapshot(expected, actual) {
  for (const key of [
    'imageDigest',
    'releaseId',
    'releaseState',
    'tagSha',
    'tagState',
    'versionDigest',
    'versionState',
  ]) {
    if (expected[key] !== actual[key]) {
      throw new Error(`Validated release state changed at ${key}: expected ${expected[key]}, got ${actual[key]}.`);
    }
  }
}

export function prepareRelease(environment, snapshot, run) {
  const live = inspectReleaseState(environment, run);
  assertSameSnapshot(snapshot, live);
  if (live.releaseState !== 'absent') return live;

  checked(
    run,
    'gh',
    [
      'release',
      'create',
      environment.releaseTag,
      '--repo',
      environment.repository,
      '--target',
      environment.releaseSha,
      '--title',
      environment.releaseTag,
      '--notes',
      'Supply-chain evidence is being staged.',
      '--draft',
    ],
    `Creating draft Release ${environment.releaseTag}`,
  );

  const prepared = inspectReleaseState(environment, run);
  if (prepared.releaseState !== 'draft' || !prepared.releaseId) {
    throw new Error(`Draft Release ${environment.releaseTag} was not created in the expected state.`);
  }
  if (prepared.imageDigest !== snapshot.imageDigest || prepared.versionDigest !== snapshot.versionDigest) {
    throw new Error('Validated release digest state changed while creating the draft.');
  }
  return prepared;
}

export function assertDraftRelease(environment, snapshot, run) {
  const live = inspectReleaseState(environment, run);
  assertSameSnapshot(snapshot, live);
  if (live.releaseState !== 'draft' || !live.releaseId) {
    throw new Error(`GitHub Release ${environment.releaseTag} is not the validated draft.`);
  }
  return live;
}

export function assertPublishedRelease(environment, snapshot, run) {
  const live = inspectReleaseState(environment, run);
  if (
    live.releaseState !== 'published' ||
    live.releaseId !== snapshot.releaseId ||
    live.tagState !== 'found' ||
    live.tagSha !== environment.releaseSha ||
    live.imageDigest !== snapshot.imageDigest ||
    live.versionDigest !== snapshot.versionDigest ||
    live.versionState !== snapshot.versionState
  ) {
    throw new Error(`GitHub Release ${environment.releaseTag} was not published in the validated state.`);
  }
  return live;
}

export function promoteRelease(environment, snapshot, run) {
  let live = inspectReleaseState(environment, run);
  assertSameSnapshot(snapshot, live);
  if (live.releaseState !== 'published' || live.tagState !== 'found') {
    throw new Error(`GitHub Release ${environment.releaseTag} must be published before alias promotion.`);
  }

  if (live.versionState === 'absent') {
    ensureImmutableAlias(
      `${environment.image}:${environment.releaseVersion}`,
      `${environment.image}@${live.imageDigest}`,
      live.imageDigest,
      'Immutable version tag',
      run,
    );
    live = inspectReleaseState(environment, run);
    if (live.versionDigest !== snapshot.imageDigest) {
      throw new Error(`Published version tag does not target ${snapshot.imageDigest}.`);
    }
  }

  live = inspectReleaseState(environment, run);
  if (
    live.releaseState !== 'published' ||
    live.releaseId !== snapshot.releaseId ||
    live.imageDigest !== snapshot.imageDigest ||
    live.versionDigest !== snapshot.imageDigest
  ) {
    throw new Error('Release state changed before latest promotion.');
  }

  checked(
    run,
    'docker',
    [
      'buildx',
      'imagetools',
      'create',
      '--tag',
      `${environment.image}:latest`,
      `${environment.image}@${snapshot.imageDigest}`,
    ],
    'Promoting latest tag',
  );
  const latest = lookupDigest(`${environment.image}:latest`, 'Latest tag', run);
  if (latest.digest !== snapshot.imageDigest) {
    throw new Error(`Published latest tag does not target ${snapshot.imageDigest}.`);
  }

  live = inspectReleaseState(environment, run);
  if (
    live.releaseState !== 'published' ||
    live.releaseId !== snapshot.releaseId ||
    live.imageDigest !== snapshot.imageDigest ||
    live.versionDigest !== snapshot.imageDigest
  ) {
    throw new Error('Release state changed before marking the Release latest.');
  }
  checked(
    run,
    'gh',
    ['release', 'edit', environment.releaseTag, '--repo', environment.repository, '--latest'],
    `Marking ${environment.releaseTag} latest`,
  );
  return live;
}

export function commandRunner(command, args) {
  const commandResult = spawnSync(command, args, { encoding: 'utf8', env: process.env });
  if (commandResult.error) throw commandResult.error;
  return {
    status: commandResult.status ?? 1,
    stderr: commandResult.stderr ?? '',
    stdout: commandResult.stdout ?? '',
  };
}

function environmentFromProcess() {
  return {
    defaultSha: required(process.env.DEFAULT_SHA, 'DEFAULT_SHA'),
    image: required(process.env.IMAGE, 'IMAGE'),
    releaseSha: required(process.env.RELEASE_SHA, 'RELEASE_SHA'),
    releaseTag: required(process.env.RELEASE_TAG, 'RELEASE_TAG'),
    releaseVersion: required(process.env.RELEASE_VERSION, 'RELEASE_VERSION'),
    repository: required(process.env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY'),
  };
}

function snapshotFromProcess() {
  return {
    deployRunId: process.env.DEPLOY_RUN_ID ? Number(process.env.DEPLOY_RUN_ID) : null,
    imageDigest: required(process.env.IMAGE_DIGEST, 'IMAGE_DIGEST'),
    releaseId: process.env.RELEASE_ID ? Number(process.env.RELEASE_ID) : null,
    releaseState: required(process.env.RELEASE_STATE, 'RELEASE_STATE'),
    tagSha: process.env.RELEASE_TAG_SHA || null,
    tagState: required(process.env.RELEASE_TAG_STATE, 'RELEASE_TAG_STATE'),
    versionDigest: process.env.VERSION_DIGEST || null,
    versionState: required(process.env.VERSION_STATE, 'VERSION_STATE'),
  };
}

export function snapshotEntries(snapshot, lowercase = false) {
  const entries = Object.entries({
    DEPLOY_RUN_ID: snapshot.deployRunId ?? '',
    IMAGE_DIGEST: snapshot.imageDigest,
    RELEASE_ID: snapshot.releaseId ?? '',
    RELEASE_STATE: snapshot.releaseState,
    RELEASE_TAG_SHA: snapshot.tagSha ?? '',
    RELEASE_TAG_STATE: snapshot.tagState,
    VERSION_DIGEST: snapshot.versionDigest ?? '',
    VERSION_STATE: snapshot.versionState,
  });
  return entries.map(([key, value]) => [lowercase ? key.toLowerCase() : key, value]);
}

function writeSnapshot(snapshot) {
  if (process.env.GITHUB_ENV) {
    appendFileSync(process.env.GITHUB_ENV, `${snapshotEntries(snapshot).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${snapshotEntries(snapshot, true).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
  }
  for (const [key, value] of snapshotEntries(snapshot)) console.log(`${key}=${value}`);
}

async function main() {
  const command = process.argv[2];
  if (command === 'ensure-alias') {
    ensureImmutableAlias(
      required(process.env.IMAGE_ALIAS, 'IMAGE_ALIAS'),
      required(process.env.IMAGE_SOURCE, 'IMAGE_SOURCE'),
      required(process.env.IMAGE_DIGEST, 'IMAGE_DIGEST'),
      process.env.ALIAS_DESCRIPTION?.trim() || 'Immutable image alias',
      commandRunner,
    );
    return;
  }
  const environment = environmentFromProcess();
  let snapshot;
  switch (command) {
    case 'preflight':
      snapshot = inspectReleaseState(environment, commandRunner);
      break;
    case 'prepare':
      snapshot = prepareRelease(environment, snapshotFromProcess(), commandRunner);
      break;
    case 'assert-draft':
      snapshot = assertDraftRelease(environment, snapshotFromProcess(), commandRunner);
      break;
    case 'assert-published':
      snapshot = assertPublishedRelease(environment, snapshotFromProcess(), commandRunner);
      break;
    case 'promote':
      snapshot = promoteRelease(environment, snapshotFromProcess(), commandRunner);
      break;
    default:
      throw new Error(
        'Usage: release-state.mjs preflight|prepare|assert-draft|assert-published|promote|ensure-alias',
      );
  }
  writeSnapshot(snapshot);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exit(1);
  });
}
