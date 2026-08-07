# Releases

Aries publishes versioned source releases and the matching public Linux/amd64 container through `.github/workflows/release.yml`. The workflow is the only supported release path; do not create tags or GitHub Releases manually.

## Version policy

Until the public API is declared stable, Aries uses the existing four-component project version:

`MAJOR.MINOR.TRAIN.PATCH`

- `MAJOR` remains `0` during the pre-stable period.
- `MINOR` identifies the current product line.
- `TRAIN` advances for a planned feature/release train and resets `PATCH` to `0`.
- `PATCH` advances for a backwards-compatible correction within a train.

`VERSION` and `package.json` carry the version without a prefix. The release tag is exactly `v$VERSION`; for example, `VERSION=0.1.48.0` produces GitHub Release `v0.1.48.0` and image tag `ghcr.io/delicioushouse/aries-app:0.1.48.0`. Tags and versioned image aliases are immutable. `latest` is the only mutable release alias.

The workflow rejects a release whose requested tag does not match `VERSION`. A first attempt must target the current `origin/master`; a retry may use an existing staged or published Release only when its tag/target is pinned to the identical commit. Existing tag, Release, or version-image digest mismatches fail closed. API, authentication, rate-limit, registry, and transport errors are never treated as absence.

## Cadence

- Routine releases are monthly while Aries is under active development, normally by the second Tuesday after that month's production changes pass the release gates.
- A critical security correction is an out-of-band release: ship as soon as the fix is reviewed, deployed, and verified, with a target of no more than two business days after the fix is ready.
- Do not publish an empty release in a month with no releasable source changes.

Each release is cut only after the exact `master` commit has passed required CI, has deployed through `deploy.yml`, and has a successful production health check. Deploy builds once by digest, creates the commit-SHA alias only when absent or identical, and health-checks that exact alias. Release requires a successful push-triggered Deploy run for the commit and signs the digest resolved from that immutable alias; it never rebuilds or overwrites it. The first attempt creates a draft Release pinned to that commit only after those immutable checks, so a failed workflow can be rerun for the same version and commit even if `master` advances. It is never worked around by moving a version tag or uploading unsigned assets; mismatched recovery state aborts the retry.

## Release procedure

1. Merge the release-bearing draft PR through its assigned reviewer lane after required CI is green.
2. Confirm the merged `master` commit deployed successfully and the production health check passed.
3. Record reviewer confirmation on the implementation card, then dispatch the workflow from `master` with the exact value in `VERSION`:

   ```bash
   VERSION="$(node -p "require('fs').readFileSync('VERSION','utf8').trim()")"
   gh workflow run release.yml --repo DeliciousHouse/aries-app --ref master -f version="${VERSION}"
   gh run watch --repo DeliciousHouse/aries-app --exit-status
   ```

4. Confirm the run created `v$VERSION`, that the release assets are present, and that the versioned image resolves to the digest recorded in the release notes.

A `v*` tag push enters the same serialized, fail-closed pipeline for recovery/automation, but the normal operator path is `workflow_dispatch`. The workflow validates the tag, Release, deployed digest, successful Deploy run, and immutable version alias before preparing a private draft. It uploads and verifies the complete evidence set, publishes the Release and tag, and only then exposes image aliases. A retry of an already-published Release never edits its notes or assets; it only resumes alias promotion after revalidating the same immutable state.

## Supply-chain controls

Every external action in `release.yml` is pinned to a full commit SHA with its readable release version retained in a comment. Application dependencies resolve through the committed `package-lock.json` and `npm ci`; weekly Dependabot updates cover both npm and GitHub Actions dependencies.

For every release, the workflow:

1. consumes the immutable commit-SHA image built, deployed, and health-checked by `deploy.yml`;
2. records a Trivy HIGH/CRITICAL vulnerability report and blocks release promotion on fixable CRITICAL findings;
3. generates a CycloneDX JSON SBOM from the built image and submits the dependency snapshot;
4. creates signed SLSA build provenance and a signed SBOM attestation with GitHub artifact attestations, publishing both against the image digest and to GHCR;
5. uses Cosign keyless OIDC signing for the image, the SBOM, and the checksum manifest covering all attached JSON evidence;
6. uploads and verifies the complete evidence set on a commit-pinned draft, then publishes the GitHub Release with generated notes;
7. creates the version image alias only when it is absent or already points to the same digest; and
8. moves `latest` last.

Release assets include:

- `aries-app-v*.cdx.json` — CycloneDX SBOM;
- `aries-app-v*.trivy.json` — vulnerability report;
- `aries-app-v*.provenance.sigstore.json` — GitHub SLSA provenance bundle;
- `aries-app-v*.sbom-attestation.sigstore.json` — GitHub SBOM attestation bundle;
- `aries-app-v*.cdx.json.sigstore.json` — direct Cosign signature bundle for the SBOM;
- `SHA256SUMS` and `SHA256SUMS.sigstore.json` — checksums and their Cosign signature bundle.

## Verification

Download one release's evidence into an empty directory:

```bash
gh release download "v${VERSION}" --repo DeliciousHouse/aries-app
```

Verify the GitHub SLSA provenance and CycloneDX SBOM attestations for the released image:

```bash
gh attestation verify "oci://ghcr.io/delicioushouse/aries-app:${VERSION}" \
  --repo DeliciousHouse/aries-app \
  --signer-workflow DeliciousHouse/aries-app/.github/workflows/release.yml
gh attestation verify "oci://ghcr.io/delicioushouse/aries-app:${VERSION}" \
  --repo DeliciousHouse/aries-app \
  --signer-workflow DeliciousHouse/aries-app/.github/workflows/release.yml \
  --predicate-type https://cyclonedx.org/bom
```

Verify the Cosign image signature. A normal manual release is signed from `refs/heads/master`; a tag-triggered retry is signed from `refs/tags/v...`, so the identity expression accepts only those two release workflow refs:

```bash
cosign verify "ghcr.io/delicioushouse/aries-app:${VERSION}" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  --certificate-identity-regexp '^https://github.com/DeliciousHouse/aries-app/.github/workflows/release.yml@refs/(heads/master|tags/v[0-9].*)$'
```

Verify the signed checksum manifest, then every attached JSON file it covers:

```bash
cosign verify-blob SHA256SUMS \
  --bundle SHA256SUMS.sigstore.json \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  --certificate-identity-regexp '^https://github.com/DeliciousHouse/aries-app/.github/workflows/release.yml@refs/(heads/master|tags/v[0-9].*)$'
sha256sum --check SHA256SUMS
```

Verification must fail closed: a missing bundle, identity mismatch, digest mismatch, or checksum failure means the artifact is not an accepted Aries release.
