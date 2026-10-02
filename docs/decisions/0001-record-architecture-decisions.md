# Record architecture decisions

- Status: accepted
- Date: 2026-10-02

## Context and problem statement

ByteBureau makes many bleeding-edge technology choices whose rationale would otherwise live only in chat logs and research notes.

## Decision

We record every decision that changes architecture, tooling, licensing or external policy as an Architecture Decision Record in `docs/decisions/`, numbered sequentially, using the MADR 4.0 structure (status, date, context, decision, consequences). A decision takes effect when its ADR is merged. Superseded ADRs stay in place with status `superseded by NNNN`.

## Consequences

Contributors can read why things are the way they are; reversing a decision requires a new ADR, which keeps churn visible.

## Appendix: owner actions after the foundation lands

1. Run a name-clearance search for "ByteBureau" (TMview, BOIP, ÚPV) before investing in branding; a Belgian GitHub organisation and a parked `bytebureau.com` exist.
2. Create the GitHub organisation `getbytebureau` (fallbacks `bytebureauhq`, `bytebureau-dev`) and transfer the repository to enable the merge queue.
3. Enable 2FA, SSH commit signing and vigilant mode on the owner account.
4. Run `scripts/repo-settings.sh <owner>/<repo>` (repository features, security settings, GitHub Pages source, labels, rulesets); afterwards confirm that the `main` ruleset lists "Repository admin" as a bypass actor (the role id is undocumented in the REST reference).
5. In the GitHub UI: CodeQL default setup (JavaScript/TypeScript and Actions, extended queries), immutable releases, social preview image (1280×640), Actions policy (allow owner, GitHub and verified-creator actions plus the explicit list; require approval for first-time contributors; read-only default token), artifact retention 30 days, Discussions categories (Announcements, Q&A, Ideas, Show and tell).
6. Install the Renovate, DCO and all-contributors GitHub apps.
7. Reserve the npm organisation `@bytebureau`, Docker Hub `bytebureau`, domains `bytebureau.dev`, `bytebureau.app`, `bytebureau.cz`; create the `homebrew-tap` repository and the `HOMEBREW_TAP_TOKEN` secret when ready.
8. Optionally link Vercel for the Turborepo remote cache (`TURBO_TOKEN`, `TURBO_TEAM`) and set up GitHub Sponsors.
