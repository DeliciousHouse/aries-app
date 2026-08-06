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
  assert.match(workflow, /docker buildx imagetools create[\s\S]*?"\$\{IMAGE\}:\$\{RELEASE_VERSION\}"[\s\S]*?"\$\{IMAGE\}:latest"/);
  assert.match(workflow, /gh release create "\$\{RELEASE_TAG\}"[\s\S]*?release-assets\/\*/);

  const buildIndex = workflow.indexOf('id: build');
  const scanIndex = workflow.indexOf('name: Record vulnerability report');
  const signIndex = workflow.indexOf('name: Keyless-sign image and release artifacts');
  const promoteIndex = workflow.indexOf('name: Promote verified image tags');
  const releaseIndex = workflow.indexOf('name: Publish GitHub Release');
  assert.ok(
    buildIndex < scanIndex && scanIndex < signIndex && signIndex < promoteIndex && promoteIndex < releaseIndex,
    'build, scan, sign, promote, and release must remain fail-closed and ordered',
  );
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
