#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/run.sh --preset NAME

Prepare, preflight, and run the pinned medium NVM task with one comparison:

  stock-current       Minimal stock Codex vs the current setup
  current-vs-current-mekugi
                      Direct Codex vs Mekugi with the same current setup
  stock-mekugi        Minimal stock Codex vs minimal stock Codex plus Mekugi
  codex-mekugi-grok   Stock Codex plus Mekugi vs the Grok CLI

Optional environment overrides:
  CODEX_AB_SOURCE_DIR        NVM checkout (default: /tmp/codex-ab-nvm-source)
  CODEX_AB_IMAGE             Container image (default: codex-ab:0.1.0)
  CODEX_AB_MEKUGI_SOURCE     Mekugi checkout (default: $HOME/projects/mekugi)
  CODEX_AB_MEKUGI_BIN        Mekugi executable (default: $HOME/go/bin/mekugi)
  CODEX_AB_MEKUGI_SHELL_BIN  Shell helper (default: $HOME/go/bin/shell)
  CODEX_AB_GROK_BIN          Grok executable (default: $HOME/.grok/bin/grok)
  CODEX_AB_AUTH_FILE         Codex auth file (default: $HOME/.codex/auth.json)
  CODEX_AB_GROK_AUTH_FILE    Grok auth file (default: $HOME/.grok/auth.json)
EOF
}

die() {
  printf 'scripts/run.sh: %s\n' "$*" >&2
  exit 2
}

preset=
while (($#)); do
  case "$1" in
    --preset)
      (($# >= 2)) || die "--preset requires a value"
      [[ -z "$preset" ]] || die "--preset may be supplied only once"
      preset=$2
      shift 2
      ;;
    --preset=*)
      [[ -z "$preset" ]] || die "--preset may be supplied only once"
      preset=${1#*=}
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done
[[ -n "$preset" ]] || { usage >&2; exit 2; }

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
cd "$repo_root"

user_home=${HOME:?HOME must be set}
source_dir=${CODEX_AB_SOURCE_DIR:-${TMPDIR:-/tmp}/codex-ab-nvm-source}
image=${CODEX_AB_IMAGE:-codex-ab:0.1.0}
mekugi_source=${CODEX_AB_MEKUGI_SOURCE:-$user_home/projects/mekugi}
mekugi_bin=${CODEX_AB_MEKUGI_BIN:-$user_home/go/bin/mekugi}
mekugi_shell_bin=${CODEX_AB_MEKUGI_SHELL_BIN:-$user_home/go/bin/shell}
grok_bin=${CODEX_AB_GROK_BIN:-$user_home/.grok/bin/grok}
auth_file=${CODEX_AB_AUTH_FILE:-$user_home/.codex/auth.json}
grok_auth_file=${CODEX_AB_GROK_AUTH_FILE:-$user_home/.grok/auth.json}

case "$preset" in
  stock-current|current-vs-current-mekugi|stock-mekugi|codex-mekugi-grok) ;;
  *) die "unknown preset '$preset'; run with --help to list presets" ;;
esac

if [[ -e "$source_dir" && ! -d "$source_dir/.git" ]]; then
  die "source path exists but is not a Git checkout: $source_dir"
fi
if [[ ! -d "$source_dir/.git" ]]; then
  git clone https://github.com/nvm-sh/nvm.git "$source_dir"
fi

bun run build

comparison=$preset
if [[ "$preset" == current-vs-current-mekugi ]]; then
  comparison=same-setup
fi

prepare_args=(
  ./dist/codex-ab prepare
  --task-pack ./tasks/nvm-download-no-eval/manifest.json
  --source "$source_dir"
  --comparison "$comparison"
  --reasoning-effort medium
  --image "$image"
)
run_args=(
  ./dist/codex-ab run
  --auth-file "$auth_file"
  --confirm-paid-inference
)

case "$preset" in
  current-vs-current-mekugi|stock-mekugi)
    prepare_args+=(
      --mekugi-source "$mekugi_source"
      --mekugi-bin "$mekugi_bin"
      --mekugi-shell-bin "$mekugi_shell_bin"
    )
    ;;
  codex-mekugi-grok)
    prepare_args+=(
      --mekugi-source "$mekugi_source"
      --mekugi-bin "$mekugi_bin"
      --mekugi-shell-bin "$mekugi_shell_bin"
      --mekugi-flags '["--mode=mekugi","--model-protocol=native","--grok"]'
      --grok-bin "$grok_bin"
    )
    run_args+=(--grok-auth-file "$grok_auth_file")
    ;;
esac

run_dir="$("${prepare_args[@]}")"
printf 'Prepared run: %s\n' "$run_dir" >&2
./dist/codex-ab preflight --run-dir "$run_dir"
"${run_args[@]}" --run-dir "$run_dir"
