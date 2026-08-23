# Maintainer Guide

## Pull requests

Require `ci-gate`, a Version Plan for shipped changes, and reviewable admission
edits for byte or timing regressions. Zero approvals is the solo-maintainer
ruleset; revisit it when a second maintainer joins.

## Release

Version Plans drive releases. `release-pr.yml` maintains a standing release
pull request on `release/next`: every push to `main` with pending plans
regenerates the release commit through `release:prepare --from-plans` and
force-updates the pull request; with none pending it closes the pull request.
Review the standing pull request and merge it — that is the entire release
act. Prefer a squash merge with the title unchanged.

GitHub Actions owns npm OIDC publication, provenance, registry verification,
tags, GitHub Releases, and Vercel deployment. Do not publish from a
workstation, push to `release/next`, or enable auto-merge on the release pull
request.

Manual fallback when the bot is broken: on a fresh branch off `main`, run
`pnpm release:prepare -- <version> --dry-run` and then the real run, commit
only generated release files as `chore(release): libassimp v<version>`, and
open the pull request yourself.

## Repository operations

Repository rules, secret scanning, push protection, and private vulnerability
reporting are managed through the `cloud-infra` stack. The npm Trusted
Publisher is bound to `taucad/libassimp` and `.github/workflows/ci.yml`. npm
allows one publisher per package and matches the workflow filename exactly, so
never re-register it and never add an `NPM_TOKEN`.

## Toolchain

The Emscripten image is digest-pinned in `emsdk-image.txt` and repeated as the
`container:` literal in `ci.yml` and `bench.yml`, because a container image
cannot be computed from a file. Dependabot's `docker` ecosystem proposes the
bump; move the literal in `emsdk-image.txt` in the same pull request, then
re-anchor the byte and timing budgets from the first build on the new
toolchain.
