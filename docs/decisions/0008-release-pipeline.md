# Release pipeline: changelogen, immutable releases, provenance, signatures, SBOM

- Status: accepted
- Date: 2026-10-02

## Context and problem statement

Releases must be reproducible, verifiable and friendly to read, for binaries on three operating systems and later npm packages.

## Decision

`changelogen --release --push --no-github` bumps the root version from Conventional Commits, writes `CHANGELOG.md` with emoji sections, commits and tags `vX.Y.Z`; the GitHub release itself is created by the workflow. The tag triggers `release.yml`: eight binaries are cross-compiled on one Linux runner, checksummed, attested with GitHub build provenance, accompanied by a CycloneDX SBOM with its own attestation, signed with cosign (Sigstore bundles), uploaded to a draft release with `gh release create` and then published; the owner enables immutable releases so published assets cannot change. npm packages (from sub-project 1) publish through trusted publishing with provenance.

## Consequences

Users can verify binaries with `gh attestation verify`; the single product version applies to every workspace package; independent SDK versioning would require moving to release-please manifests.
