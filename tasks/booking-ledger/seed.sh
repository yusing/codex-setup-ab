#!/usr/bin/env bash
set -euo pipefail

# All Git writes target a new private repository, never the benchmark checkout.
source_dir=$(mktemp -d /tmp/codex-ab-booking-ledger.XXXXXXXX)
trap 'printf "Seed preparation failed; retained directory: %s\n" "$source_dir" >&2' ERR
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR
export GIT_AUTHOR_NAME='codex-ab fixture' GIT_AUTHOR_EMAIL='fixture@invalid'
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export GIT_AUTHOR_DATE='2026-01-01T00:00:00Z'
export GIT_COMMITTER_DATE="$GIT_AUTHOR_DATE"

git_seed() {
  git -C "$source_dir" -c core.hooksPath=/dev/null -c commit.gpgSign=false \
    -c core.autocrlf=false "$@"
}

git_seed init --quiet --initial-branch=main --template=
printf '# Booking Ledger\n\nNew project. No application has been implemented.\n' > "$source_dir/README.md"
git_seed add -- README.md
git_seed commit --quiet -m 'New-project baseline'
git_seed tag benchmark-base
git_seed commit --quiet --allow-empty -m 'Excluded isolation sentinel, not a solution'
git_seed tag benchmark-excluded
git_seed checkout --quiet --detach benchmark-base
printf '%s\n' "$source_dir"
