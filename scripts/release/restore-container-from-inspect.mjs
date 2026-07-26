#!/usr/bin/env node
import fs from 'node:fs/promises';
import http from 'node:http';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function buildContainerCreateRequest(snapshot) {
  const inspected = Array.isArray(snapshot) ? snapshot[0] : snapshot;
  if (!inspected || typeof inspected !== 'object') {
    throw new Error('container inspect snapshot is empty');
  }
  if (typeof inspected.Image !== 'string' || inspected.Image.length === 0) {
    throw new Error('container inspect snapshot has no immutable image id');
  }
  const name = typeof inspected.Name === 'string' ? inspected.Name.replace(/^\//, '') : '';
  if (!name) {
    throw new Error('container inspect snapshot has no container name');
  }

  const request = clone(inspected.Config) ?? {};
  request.Image = inspected.Image;
  request.HostConfig = clone(inspected.HostConfig) ?? {};

  const endpoints = {};
  for (const [networkName, network] of Object.entries(inspected.NetworkSettings?.Networks ?? {})) {
    endpoints[networkName] = {
      Aliases: clone(network?.Aliases) ?? undefined,
      Links: clone(network?.Links) ?? undefined,
      DriverOpts: clone(network?.DriverOpts) ?? undefined,
      MacAddress: network?.MacAddress || undefined,
      IPAMConfig: clone(network?.IPAMConfig) ?? undefined,
    };
    for (const [key, value] of Object.entries(endpoints[networkName])) {
      if (value === undefined || value === null || value === '') delete endpoints[networkName][key];
    }
  }
  if (Object.keys(endpoints).length > 0) {
    request.NetworkingConfig = { EndpointsConfig: endpoints };
  }

  return { name, request };
}

function dockerSocketPath() {
  const dockerHost = process.env.DOCKER_HOST;
  if (!dockerHost) return '/var/run/docker.sock';
  if (!dockerHost.startsWith('unix://')) {
    throw new Error(`unsupported DOCKER_HOST for exact restore: ${dockerHost}`);
  }
  return dockerHost.slice('unix://'.length);
}

function dockerRequest(socketPath, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = http.request(
      {
        socketPath,
        method,
        path,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': String(payload.length) }
          : undefined,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            reject(new Error(`Docker API ${method} ${path} returned ${response.statusCode}: ${text}`));
            return;
          }
          resolve(parsed);
        });
      },
    );
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

export async function restoreContainerFromInspect(snapshotPath) {
  const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
  const { name, request } = buildContainerCreateRequest(snapshot);
  const socketPath = dockerSocketPath();
  const version = await dockerRequest(socketPath, 'GET', '/version');
  const apiVersion = version?.ApiVersion;
  if (typeof apiVersion !== 'string' || apiVersion.length === 0) {
    throw new Error('Docker API did not return an API version');
  }
  const created = await dockerRequest(
    socketPath,
    'POST',
    `/v${apiVersion}/containers/create?name=${encodeURIComponent(name)}`,
    request,
  );
  if (typeof created?.Id !== 'string' || created.Id.length === 0) {
    throw new Error('Docker API did not return the restored container id');
  }
  return created.Id;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const snapshotPath = process.argv[2];
  if (!snapshotPath) {
    console.error('usage: restore-container-from-inspect.mjs <docker-inspect-snapshot.json>');
    process.exit(2);
  }
  restoreContainerFromInspect(snapshotPath)
    .then((containerId) => process.stdout.write(`${containerId}\n`))
    .catch((error) => {
      console.error(`Exact container restore failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
