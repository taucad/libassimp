#!/usr/bin/env bash

set -euo pipefail

fail() {
  echo "::error::artifact '$ARTIFACT' did not land in '$ARTIFACT_PATH': $1"
  exit 1
}

[[ -d "$ARTIFACT_PATH" ]] || fail 'the download created no directory'
shopt -s nullglob dotglob
landed=("$ARTIFACT_PATH"/*)
[[ ${#landed[@]} -gt 0 ]] || fail 'the directory is empty'
read -r -a expected_entries <<< "${EXPECT:-}"
for entry in "${expected_entries[@]}"; do [[ -e "$ARTIFACT_PATH/$entry" ]] || fail "$entry is missing"; done
echo "artifact '$ARTIFACT' landed in '$ARTIFACT_PATH' (${#landed[@]} top-level entries)"
