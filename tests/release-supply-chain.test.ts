import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { resolveProjectRoot } from './helpers/project-root.js';

const PROJECT_ROOT = resolveProjectRoot(import.meta.url);

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

test('release workflow signs only the production-health-checked deploy artifact', () => {
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

  assert.match(workflow, /name: Validate deployed artifact and release state[\s\S]*?id: preflight/);
  assert.match(workflow, /node scripts\/release\/release-state\.mjs preflight/);
  assert.match(workflow, /IMAGE_DIGEST:\s*\$\{\{ steps\.preflight\.outputs\.image_digest \}\}/);
  assert.doesNotMatch(workflow, /docker\/build-push-action@/);
  assert.match(workflow, /package_version=.*package\.json/);
  assert.match(workflow, /"\$\{package_version\}" != "\$\{release_version\}"/);

  assert.match(workflow, /aquasecurity\/trivy-action@[0-9a-f]{40}[\s\S]*?format: json[\s\S]*?severity: HIGH,CRITICAL/);
  assert.match(workflow, /aquasecurity\/trivy-action@[0-9a-f]{40}[\s\S]*?exit-code: '1'[\s\S]*?severity: CRITICAL/);

  assert.match(workflow, /anchore\/sbom-action@[0-9a-f]{40}[\s\S]*?format: cyclonedx-json/);
  assert.match(workflow, /sbom-path:\s*\$\{\{ env\.SBOM_PATH \}\}/);

  const attestations = [...workflow.matchAll(/uses: actions\/attest@[0-9a-f]{40}/g)];
  assert.equal(attestations.length, 2, 'expected one SLSA provenance and one SBOM attestation');
  assert.match(workflow, /subject-digest:\s*\$\{\{ steps\.preflight\.outputs\.image_digest \}\}/);
  assert.match(workflow, /push-to-registry: true/);

  assert.match(workflow, /cosign sign --yes "\$\{IMAGE\}@\$\{IMAGE_DIGEST\}"/);
  assert.match(workflow, /cosign sign-blob --yes --bundle/);
  assert.match(workflow, /sha256sum \*\.json > SHA256SUMS/);
  const preflightIndex = workflow.indexOf('id: preflight');
  const prepareIndex = workflow.indexOf('name: Prepare staged GitHub Release');
  const scanIndex = workflow.indexOf('name: Record vulnerability report');
  const signIndex = workflow.indexOf('name: Keyless-sign image and release artifacts');
  const stageIndex = workflow.indexOf('name: Stage and verify GitHub Release evidence');
  const releaseIndex = workflow.indexOf('name: Publish GitHub Release');
  const promoteIndex = workflow.indexOf('name: Promote release aliases');
  assert.ok(
    preflightIndex < prepareIndex &&
      prepareIndex < scanIndex &&
      scanIndex < signIndex &&
      signIndex < stageIndex &&
      stageIndex < releaseIndex &&
      releaseIndex < promoteIndex,
    'validated deploy digest must precede draft mutation, evidence, publication, and alias promotion',
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

  assert.match(workflow, /name: Prepare staged GitHub Release[\s\S]*?release-state\.mjs prepare/);
  assert.match(workflow, /name: Stage and verify GitHub Release evidence[\s\S]*?release-state\.mjs assert-draft/);
  assert.match(workflow, /release_endpoint="repos\/\$\{GITHUB_REPOSITORY\}\/releases\/\$\{RELEASE_ID\}"/);
  assert.match(workflow, /gh release upload "\$\{RELEASE_TAG\}" release-assets\/\* --clobber/);
  assert.match(workflow, /releases\/assets\/\$\{existing_asset_id\}/);
  assert.match(workflow, /uploaded_size.*local_size/);
  assert.match(workflow, /name: Publish GitHub Release[\s\S]*?release-state\.mjs assert-published/);
  for (const step of ['Record vulnerability report', 'Stage and verify GitHub Release evidence', 'Publish GitHub Release']) {
    assert.match(
      workflow,
      new RegExp(`name: ${step}[\\s\\S]*?if: steps\\.preflight\\.outputs\\.release_state != 'published'`),
    );
  }
});

test('deploy is the sole immutable SHA writer and release owns public aliases', () => {
  const workflow = readRepoFile('.github/workflows/release.yml');
  const deploy = readRepoFile('.github/workflows/deploy.yml');
  const publisher = readRepoFile('scripts/release/publish-image.sh');

  assert.match(deploy, /name: Publish immutable deploy image[\s\S]*?\.\/scripts\/release\/publish-image\.sh/);
  assert.doesNotMatch(deploy, /Publishing .*latest aliases|PUBLISH_SHA_ONLY/);
  assert.match(publisher, /push-by-digest=true/);
  assert.match(publisher, /release-state\.mjs ensure-alias/);
  assert.doesNotMatch(publisher, /GHCR_IMAGE\}:latest|GHCR_IMAGE\}:\$\{DEFAULT_BRANCH\}/);
  assert.match(workflow, /name: Promote release aliases[\s\S]*?release-state\.mjs promote/);
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
