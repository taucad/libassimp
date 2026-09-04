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

Before the first native release, an authenticated npm 11.15+ operator with
account-level 2FA must reserve `libassimp-darwin-arm64`,
`libassimp-linux-x64-gnu`, and `libassimp-win32-x64-msvc` from a workstation as
manifest-only `0.0.0` packages under a non-default `bootstrap` tag. The
workstation publishes no native binaries and stops after this one-time package
name reservation.

For the existing root and exactly three platform packages, run `npm trust
github <package> --repo taucad/libassimp --file ci.yml --allow-publish`, set
publishing access to require 2FA and disallow tokens, and confirm each binding
with `npm trust list <package>`. Do not merge the first native release pull
request until all four bindings name `taucad/libassimp` and `ci.yml` exactly.

Manual fallback when the bot is broken: on a fresh branch off `main`, run
`pnpm release:prepare -- <version> --dry-run` and then the real run, commit
only generated release files as `chore(release): libassimp v<version>`, and
open the pull request yourself.

## Repository operations

Repository rules, secret scanning, push protection, and private vulnerability
reporting are managed through the `tau-cloud` stack. The npm Trusted
Publishers for the root and three platform packages are bound to
`taucad/libassimp` and workflow filename `ci.yml` at
`.github/workflows/ci.yml`. npm allows one publisher per package and matches
the filename exactly, so never add an `NPM_TOKEN`.

## Toolchain

The Emscripten image is digest-pinned in `emsdk-image.txt` and repeated as the
`container:` literal in `ci.yml` and `bench.yml`, because a container image
cannot be computed from a file. Dependabot's `docker` ecosystem proposes the
bump; move the literal in `emsdk-image.txt` in the same pull request, then
re-anchor the byte and timing budgets from the first build on the new
toolchain.
