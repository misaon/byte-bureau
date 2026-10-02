# Release pipeline: changelogen, immutable releases, provenance, signatures, SBOM

- Status: accepted
- Date: 2026-10-02

## Context and problem statement

Releases must be reproducible, verifiable and friendly to read, for binaries on three operating systems and later npm packages.

## Decision

A release is a pull request, because the `main` ruleset has no bypass actor. On a branch `release/vX.Y.Z` the owner runs `bun run release -r X.Y.Z`, that is `changelogen --release --no-push --no-tag --no-github -r X.Y.Z`, which sets the root version, writes `CHANGELOG.md` with emoji sections and commits `chore(release): vX.Y.Z` without creating a tag or pushing. The rest is done by hand: sign the commit off for the DCO check (`git commit --amend --signoff --no-edit`), push the branch, open a pull request titled `chore(release): vX.Y.Z`, squash-merge it once CI is green, then tag the merge commit (`git tag vX.Y.Z <merge commit>`) and push the tag (`git push origin vX.Y.Z`). The tag ruleset only blocks updating and deleting `v*` tags, so creating one needs no bypass, and the release commit is verified by CI before it is tagged; the GitHub release itself is created by the workflow. The tag triggers `release.yml`: eight binaries are cross-compiled on one Linux runner, checksummed, attested with GitHub build provenance, accompanied by a CycloneDX SBOM with its own attestation, signed with cosign (Sigstore bundles), uploaded to a draft release with `gh release create` and then published; the owner enables immutable releases so published assets cannot change. npm packages (from sub-project 1) publish through trusted publishing with provenance.

## Consequences

Users can verify binaries with `gh attestation verify`; the single product version applies to every workspace package; independent SDK versioning would require moving to release-please manifests.
