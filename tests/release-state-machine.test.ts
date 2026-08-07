import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertDraftRelease,
  ensureImmutableAlias,
  inspectReleaseState,
  prepareRelease,
  promoteRelease,
  snapshotEntries,
  type CommandResult,
  type ReleaseEnvironment,
} from '../scripts/release/release-state.mjs';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const DIGEST = `sha256:${'1'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'2'.repeat(64)}`;

const environment: ReleaseEnvironment = {
  defaultSha: SHA,
  image: 'ghcr.io/delicioushouse/aries-app',
  releaseSha: SHA,
  releaseTag: 'v0.1.52.0',
  releaseVersion: '0.1.52.0',
  repository: 'DeliciousHouse/aries-app',
};

type ReleaseRecord = {
  id: number;
  tag_name: string;
  target_commitish: string;
  draft: boolean;
};

type FakeState = {
  deployEvent: 'push' | 'workflow_dispatch';
  deploySucceeded: boolean;
  latestDigest: string | null;
  mutations: string[];
  release: ReleaseRecord | null;
  shaDigest: string | null;
  tagSha: string | null;
  versionDigest: string | null;
  faults?: Partial<Record<'deploy' | 'release' | 'shaDigest' | 'tag' | 'versionDigest', CommandResult>>;
};

function result(status: number, stdout = '', stderr = ''): CommandResult {
  return { status, stdout, stderr };
}

function makeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    deployEvent: 'push',
    deploySucceeded: true,
    latestDigest: null,
    mutations: [],
    release: null,
    shaDigest: DIGEST,
    tagSha: null,
    versionDigest: null,
    ...overrides,
  };
}

function makeRunner(state: FakeState) {
  return (command: string, args: string[]): CommandResult => {
    const joined = `${command} ${args.join(' ')}`;

    if (command === 'git' && args[0] === 'ls-remote') {
      if (state.faults?.tag) return state.faults.tag;
      return state.tagSha ? result(0, `${state.tagSha}\trefs/tags/${environment.releaseTag}\n`) : result(2);
    }
    if (command === 'git' && args[0] === 'fetch') return result(0);
    if (command === 'git' && args[0] === 'rev-parse') return result(0, `${state.tagSha}\n`);

    if (command === 'gh' && args[0] === 'api' && joined.includes('/actions/workflows/deploy.yml/runs')) {
      if (state.faults?.deploy) return state.faults.deploy;
      return result(
        0,
        JSON.stringify({
          workflow_runs: state.deploySucceeded
            ? [{ conclusion: 'success', event: state.deployEvent, head_sha: SHA }]
            : [],
        }),
      );
    }
    if (command === 'gh' && args[0] === 'api' && joined.includes('/releases/tags/')) {
      if (state.faults?.release) return state.faults.release;
      return state.release
        ? result(0, JSON.stringify(state.release))
        : result(1, '', 'gh: Not Found (HTTP 404)\n');
    }
    if (command === 'gh' && args[0] === 'release' && args[1] === 'create') {
      state.mutations.push('create-draft');
      state.release = {
        id: 52,
        tag_name: environment.releaseTag,
        target_commitish: SHA,
        draft: true,
      };
      state.tagSha = SHA;
      return result(0);
    }
    if (command === 'gh' && args[0] === 'release' && args[1] === 'edit') {
      state.mutations.push('mark-latest');
      return result(0);
    }

    if (command === 'docker' && args.slice(0, 3).join(' ') === 'buildx imagetools inspect') {
      const reference = args[3];
      const isSha = reference.endsWith(`:${SHA}`);
      const isVersion = reference.endsWith(`:${environment.releaseVersion}`);
      const fault = isSha ? state.faults?.shaDigest : isVersion ? state.faults?.versionDigest : undefined;
      if (fault) return fault;
      const digest = isSha ? state.shaDigest : isVersion ? state.versionDigest : state.latestDigest;
      return digest ? result(0, `Name: ${reference}\nDigest: ${digest}\n`) : result(1, '', 'manifest unknown\n');
    }
    if (command === 'docker' && args.slice(0, 3).join(' ') === 'buildx imagetools create') {
      const target = args[4];
      const sourceDigest = args[5].split('@')[1];
      state.mutations.push(
        target.endsWith(':latest')
          ? 'promote-latest'
          : target.endsWith(`:${SHA}`)
            ? 'promote-sha'
            : 'promote-version',
      );
      if (target.endsWith(':latest')) state.latestDigest = sourceDigest;
      else if (target.endsWith(`:${SHA}`)) state.shaDigest = sourceDigest;
      else state.versionDigest = sourceDigest;
      return result(0);
    }

    throw new Error(`Unexpected command: ${joined}`);
  };
}

test('true not-found is recoverable while lookup failures fail closed', () => {
  const absent = makeState();
  const snapshot = inspectReleaseState(environment, makeRunner(absent));
  assert.equal(snapshot.releaseState, 'absent');
  assert.equal(snapshot.tagState, 'absent');
  assert.equal(snapshot.imageDigest, DIGEST);
  assert.ok(snapshotEntries(snapshot).some(([key]) => key === 'IMAGE_DIGEST'));
  assert.ok(snapshotEntries(snapshot, true).some(([key]) => key === 'image_digest'));

  for (const [lookup, failure] of [
    ['tag', result(128, '', 'fatal: unable to access repository')],
    ['tag', result(2, '', 'transport closed unexpectedly')],
    ['release', result(1, '', 'gh: API rate limit exceeded (HTTP 403)')],
    ['shaDigest', result(1, '', 'dial tcp: network is unreachable')],
    ['versionDigest', result(1, '', 'unauthorized: authentication required')],
    ['deploy', result(1, '', 'gh: authentication failed (HTTP 401)')],
  ] as const) {
    const failed = makeState({ faults: { [lookup]: failure } });
    assert.throws(() => inspectReleaseState(environment, makeRunner(failed)), /lookup failed/i);
    assert.deepEqual(failed.mutations, []);
  }
});

test('only a push deploy proves the exact commit image passed production health', () => {
  const manuallyDispatched = makeState({ deployEvent: 'workflow_dispatch' });

  assert.throws(
    () => inspectReleaseState(environment, makeRunner(manuallyDispatched)),
    /No successful Deploy workflow run exists/,
  );
  assert.deepEqual(manuallyDispatched.mutations, []);
});

test('mismatched tag and Release targets are rejected before mutation', () => {
  const mismatchedTag = makeState({ tagSha: OTHER_SHA });
  assert.throws(() => inspectReleaseState(environment, makeRunner(mismatchedTag)), /tag .* targets/i);
  assert.deepEqual(mismatchedTag.mutations, []);

  const mismatchedRelease = makeState({
    release: {
      id: 52,
      tag_name: environment.releaseTag,
      target_commitish: OTHER_SHA,
      draft: true,
    },
  });
  assert.throws(() => inspectReleaseState(environment, makeRunner(mismatchedRelease)), /Release .* targets/i);
  assert.deepEqual(mismatchedRelease.mutations, []);
});

test('draft recovery reuses the validated draft without recreating public state', () => {
  const state = makeState({
    release: {
      id: 52,
      tag_name: environment.releaseTag,
      target_commitish: SHA,
      draft: true,
    },
  });
  const runner = makeRunner(state);
  const snapshot = inspectReleaseState(environment, runner);

  const prepared = prepareRelease(environment, snapshot, runner);
  assert.equal(prepared.releaseState, 'draft');
  assert.equal(prepared.releaseId, 52);
  assertDraftRelease(environment, prepared, runner);
  assert.deepEqual(state.mutations, []);
});

test('first attempt creates only a private draft after every immutable gate passes', () => {
  const state = makeState({ release: null, tagSha: null });
  const runner = makeRunner(state);
  const snapshot = inspectReleaseState(environment, runner);

  const prepared = prepareRelease(environment, snapshot, runner);
  assert.equal(prepared.releaseState, 'draft');
  assert.equal(prepared.tagSha, SHA);
  assert.deepEqual(state.mutations, ['create-draft']);
});

test('published retry never edits notes or assets and promotes only after digest gates', () => {
  const state = makeState({
    latestDigest: OTHER_DIGEST,
    release: {
      id: 52,
      tag_name: environment.releaseTag,
      target_commitish: SHA,
      draft: false,
    },
    tagSha: SHA,
    versionDigest: DIGEST,
  });
  const runner = makeRunner(state);
  const snapshot = inspectReleaseState(environment, runner);

  const prepared = prepareRelease(environment, snapshot, runner);
  assert.equal(prepared.releaseState, 'published');
  promoteRelease(environment, prepared, runner);

  assert.deepEqual(state.mutations, ['promote-latest', 'mark-latest']);
  assert.equal(state.latestDigest, DIGEST);
});

test('digest divergence rejects every public mutation', () => {
  const state = makeState({
    release: {
      id: 52,
      tag_name: environment.releaseTag,
      target_commitish: SHA,
      draft: false,
    },
    tagSha: SHA,
    versionDigest: OTHER_DIGEST,
  });

  assert.throws(() => inspectReleaseState(environment, makeRunner(state)), /immutable version tag/i);
  assert.deepEqual(state.mutations, []);
});

test('deploy SHA alias is created once and rejects a different rebuild digest', () => {
  const firstDeploy = makeState({ shaDigest: null });
  ensureImmutableAlias(
    `${environment.image}:${SHA}`,
    `${environment.image}@${DIGEST}`,
    DIGEST,
    'Deploy SHA tag',
    makeRunner(firstDeploy),
  );
  assert.deepEqual(firstDeploy.mutations, ['promote-sha']);
  assert.equal(firstDeploy.shaDigest, DIGEST);

  const divergentRetry = makeState({ shaDigest: OTHER_DIGEST });
  assert.throws(
    () =>
      ensureImmutableAlias(
        `${environment.image}:${SHA}`,
        `${environment.image}@${DIGEST}`,
        DIGEST,
        'Deploy SHA tag',
        makeRunner(divergentRetry),
      ),
    /Deploy SHA tag .* targets/i,
  );
  assert.deepEqual(divergentRetry.mutations, []);
});

test('a changed snapshot is rejected before draft creation or alias promotion', () => {
  const state = makeState();
  const runner = makeRunner(state);
  const snapshot = inspectReleaseState(environment, runner);

  state.release = {
    id: 99,
    tag_name: environment.releaseTag,
    target_commitish: SHA,
    draft: true,
  };
  assert.throws(() => prepareRelease(environment, snapshot, runner), /state changed/i);
  assert.deepEqual(state.mutations, []);

  state.release.draft = false;
  state.tagSha = SHA;
  const published = inspectReleaseState(environment, runner);
  state.versionDigest = OTHER_DIGEST;
  assert.throws(() => promoteRelease(environment, published, runner), /immutable version tag/i);
  assert.deepEqual(state.mutations, []);
});
