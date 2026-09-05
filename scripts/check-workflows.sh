#!/usr/bin/env bash
# Validate GitHub Actions and first-party shell scripts with pinned actionlint,
# and keep the workflow's emsdk container literal equal to emsdk-image.txt.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

"$script_dir/install-ci-tool.sh" --tool actionlint --dest "$repo_root/.ci-tools"
"$script_dir/install-ci-tool.sh" --tool shellcheck --dest "$repo_root/.ci-tools"

cd "$repo_root"
.ci-tools/bin/actionlint -shellcheck .ci-tools/bin/shellcheck -color
git ls-files -z '*.sh' | xargs -0 .ci-tools/bin/shellcheck

# `container:` cannot be computed from a file, so ci.yml carries the literal and
# emsdk-image.txt stays the single source that Dependabot and the Nx runtime
# fingerprint read.
emsdk_image="$(tr -d '[:space:]' < emsdk-image.txt)"
grep -qF "image: $emsdk_image" .github/workflows/ci.yml || {
  echo "ERROR: .github/workflows/ci.yml does not pin the emsdk image from emsdk-image.txt" >&2
  exit 1
}

benchmark_policy="if (needs.preflight.outputs.kind === 'pull-request') required.push('benchmark');"
if ! grep -qF "if: github.event_name == 'pull_request'" .github/workflows/ci.yml ||
  ! grep -qF 'node bench/compare-backends.mjs' .github/workflows/ci.yml ||
  ! grep -qF "$benchmark_policy" .github/workflows/ci.yml; then
  echo "ERROR: implementation pull requests must run and require the dependency-heavy benchmark" >&2
  exit 1
fi
