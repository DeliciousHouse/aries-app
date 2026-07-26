import assert from 'node:assert/strict';
import test from 'node:test';

import { buildContainerCreateRequest } from '../scripts/release/restore-container-from-inspect.mjs';

test('exact worker restore request preserves immutable image and container configuration', () => {
  const snapshot = [{
    Name: '/aries-scheduled-posts-worker-1',
    Image: 'sha256:old-image-id',
    Config: {
      Image: 'ghcr.io/example/aries:mutable-old-tag',
      Env: ['A=1', 'B=2'],
      Cmd: ['node', 'scripts/automations/scheduled-posts-worker.mjs'],
      Entrypoint: ['/usr/bin/tini', '--'],
      WorkingDir: '/app',
      Labels: {
        'com.docker.compose.project': 'aries',
        'com.docker.compose.service': 'aries-scheduled-posts-worker',
      },
    },
    HostConfig: {
      Binds: ['/srv/aries/.env:/app/.env:ro'],
      RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 },
      NetworkMode: 'aries_default',
      ReadonlyRootfs: true,
    },
    NetworkSettings: {
      Networks: {
        aries_default: {
          Aliases: ['aries-scheduled-posts-worker', 'worker'],
          Links: null,
          DriverOpts: null,
          MacAddress: '',
          IPAMConfig: null,
          IPAddress: '172.20.0.9',
        },
      },
    },
  }];

  const restored = buildContainerCreateRequest(snapshot);
  assert.equal(restored.name, 'aries-scheduled-posts-worker-1');
  assert.equal(restored.request.Image, 'sha256:old-image-id');
  assert.deepEqual(restored.request.Env, ['A=1', 'B=2']);
  assert.deepEqual(restored.request.Cmd, ['node', 'scripts/automations/scheduled-posts-worker.mjs']);
  assert.deepEqual(restored.request.Entrypoint, ['/usr/bin/tini', '--']);
  assert.equal(restored.request.WorkingDir, '/app');
  assert.deepEqual(restored.request.HostConfig.Binds, ['/srv/aries/.env:/app/.env:ro']);
  assert.deepEqual(restored.request.HostConfig.RestartPolicy, {
    Name: 'unless-stopped',
    MaximumRetryCount: 0,
  });
  assert.equal(restored.request.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(
    restored.request.NetworkingConfig.EndpointsConfig.aries_default,
    { Aliases: ['aries-scheduled-posts-worker', 'worker'] },
  );
  assert.equal(
    'IPAddress' in restored.request.NetworkingConfig.EndpointsConfig.aries_default,
    false,
    'runtime-assigned addresses are not valid create configuration',
  );
});

test('exact worker restore rejects snapshots without an immutable image identity', () => {
  assert.throws(
    () => buildContainerCreateRequest([{ Name: '/worker', Config: {}, HostConfig: {} }]),
    /immutable image id/,
  );
});
