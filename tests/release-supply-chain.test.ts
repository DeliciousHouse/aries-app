import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

test('release workflow publishes only scanned, attested, keyless-signed artifacts', () => {
  const workflow = readRepoFile('.github/workflows/release.yml');

  for (const permission of [
    'contents: write',
    'packages: write',
    'id-token: write',
    'attestations: write',
    'artifact-metadata: write',
  ]) {
    assert.match(workflow, new RegExp(`^  ${permission}$`, 'm'), `missing ${permission}`);
  }

  const externalActions = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)(?:\s+#\s*(\S+))?$/gm)];
  assert.ok(externalActions.length >= 8, 'expected the release workflow to use the supply-chain actions');
  for (const [, actionRef, versionComment] of externalActions) {
    assert.match(actionRef, /^[^@]+@[0-9a-f]{40}$/, `${actionRef} must be pinned to a full commit SHA`);
    assert.match(versionComment ?? '', /^v\d/, `${actionRef} must retain its human-readable version`);
  }

  assert.match(workflow, /id: build[\s\S]*?docker\/build-push-action@[0-9a-f]{40}/);
  assert.match(workflow, /IMAGE_DIGEST:\s*\$\{\{ steps\.build\.outputs\.digest \}\}/);
  assert.match(workflow, /package_version=.*package\.json/);
  assert.match(workflow, /"\$\{package_version\}" != "\$\{release_version\}"/);

  assert.match(workflow, /aquasecurity\/trivy-action@[0-9a-f]{40}[\s\S]*?format: json[\s\S]*?severity: HIGH,CRITICAL/);
  assert.match(workflow, /aquasecurity\/trivy-action@[0-9a-f]{40}[\s\S]*?exit-code: '1'[\s\S]*?severity: CRITICAL/);

  assert.match(workflow, /anchore\/sbom-action@[0-9a-f]{40}[\s\S]*?format: cyclonedx-json/);
  assert.match(workflow, /sbom-path:\s*\$\{\{ env\.SBOM_PATH \}\}/);

  const attestations = [...workflow.matchAll(/uses: actions\/attest@[0-9a-f]{40}/g)];
  assert.equal(attestations.length, 2, 'expected one SLSA provenance and one SBOM attestation');
  assert.match(workflow, /subject-digest:\s*\$\{\{ steps\.build\.outputs\.digest \}\}/);
  assert.match(workflow, /push-to-registry: true/);

  assert.match(workflow, /cosign sign --yes "\$\{IMAGE\}@\$\{IMAGE_DIGEST\}"/);
  assert.match(workflow, /cosign sign-blob --yes --bundle/);
  assert.match(workflow, /sha256sum \*\.json > SHA256SUMS/);
  const buildIndex = workflow.indexOf('id: build');
  const scanIndex = workflow.indexOf('name: Record vulnerability report');
  const signIndex = workflow.indexOf('name: Keyless-sign image and release artifacts');
  const stageIndex = workflow.indexOf('name: Stage and verify GitHub Release evidence');
  const releaseIndex = workflow.indexOf('name: Publish GitHub Release');
  const versionIndex = workflow.indexOf('name: Promote immutable version tag');
  const latestIndex = workflow.indexOf('name: Promote latest tag');
  assert.ok(
    buildIndex < scanIndex &&
      scanIndex < signIndex &&
      signIndex < stageIndex &&
      stageIndex < releaseIndex &&
      releaseIndex < versionIndex &&
      versionIndex < latestIndex,
    'evidence must be durable before release publication, with immutable version and latest aliases last',
  );
});

test('release entry points serialize on the same canonical v-prefixed key', () => {
  const workflow = readRepoFile('.github/workflows/release.yml');
  const concurrencyExpression = workflow.match(/^  group: release-(\$\{\{.+\}\})$/m)?.[1];
  const releaseTagExpression = workflow.match(/^  RELEASE_TAG: (\$\{\{.+\}\})$/m)?.[1];

  assert.ok(concurrencyExpression, 'missing release concurrency expression');
  assert.equal(concurrencyExpression, releaseTagExpression);
  assert.match(concurrencyExpression, /format\('v\{0\}', inputs\.version\)/);
});

test('release recovery is pinned, staged, complete, and mismatch-closed', () => {
  const workflow = readRepoFile('.github/workflows/release.yml');

  assert.match(workflow, /existing_release=false/);
  assert.match(workflow, /gh release view "\$\{RELEASE_TAG\}"[\s\S]*?--json targetCommitish/);
  assert.match(workflow, /existing GitHub Release \$\{RELEASE_TAG\} targets \$\{release_target_sha\}, not \$\{checkout_sha\}/);
  assert.match(workflow, /"\$\{checkout_sha\}" != "\$\{default_sha\}" && "\$\{existing_release\}" != true/);
  assert.doesNotMatch(workflow, /GitHub Release \$\{RELEASE_TAG\} already exists/);

  assert.match(workflow, /name: Prepare staged GitHub Release[\s\S]*?gh release create "\$\{RELEASE_TAG\}"[\s\S]*?--draft/);
  assert.match(workflow, /name: Stage and verify GitHub Release evidence[\s\S]*?gh release upload "\$\{RELEASE_TAG\}" release-assets\/\* --clobber/);
  assert.match(workflow, /gh release delete-asset "\$\{RELEASE_TAG\}" "\$\{existing_asset\}" --yes/);
  assert.match(workflow, /uploaded_size.*local_size/);
  assert.match(workflow, /name: Publish GitHub Release[\s\S]*?gh release edit "\$\{RELEASE_TAG\}"[\s\S]*?--draft=false/);
});

test('version alias is absent or already pinned to the built digest', () => {
  const workflow = readRepoFile('.github/workflows/release.yml');
  const versionStep = workflow.slice(
    workflow.indexOf('name: Promote immutable version tag'),
    workflow.indexOf('name: Promote latest tag'),
  );

  assert.match(versionStep, /docker buildx imagetools inspect "\$\{reference\}"/);
  assert.match(versionStep, /resolve_registry_digest "\$\{IMAGE\}:\$\{RELEASE_VERSION\}"/);
  assert.match(versionStep, /existing_version_digest/);
  assert.match(versionStep, /"\$\{existing_version_digest\}" != "\$\{IMAGE_DIGEST\}"/);
  assert.match(versionStep, /manifest unknown\|not found/);
  assert.match(versionStep, /docker buildx imagetools create[\s\S]*?--tag "\$\{IMAGE\}:\$\{RELEASE_VERSION\}"/);
  assert.match(versionStep, /published_version_digest.*IMAGE_DIGEST/);
});

test('release policy documents versioning, cadence, release gates, and verification', () => {
  const policy = readRepoFile('docs/RELEASES.md');
  const readme = readRepoFile('README.md');

  assert.match(policy, /MAJOR\.MINOR\.TRAIN\.PATCH/);
  assert.match(policy, /v\$VERSION/);
  assert.match(policy, /monthly/i);
  assert.match(policy, /out-of-band/i);
  assert.match(policy, /production health/i);
  assert.match(policy, /workflow_dispatch/);
  assert.match(policy, /CycloneDX/);
  assert.match(policy, /SLSA/);
  assert.match(policy, /Trivy/);
  assert.match(policy, /Dependabot/);
  assert.match(policy, /cosign verify/);
  assert.match(policy, /gh attestation verify/);
  assert.match(policy, /sha256sum --check SHA256SUMS/);
  assert.match(readme, /\[docs\/RELEASES\.md\]\(docs\/RELEASES\.md\)/);
});
