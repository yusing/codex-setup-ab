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
  CODEX_AB_DOCKER_BIN        Docker executable (default: docker)
  CODEX_AB_CODEX_BIN         Standalone Codex executable (default: $HOME/.local/bin/codex)
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
docker_bin=${CODEX_AB_DOCKER_BIN:-docker}
codex_bin=${CODEX_AB_CODEX_BIN:-$user_home/.local/bin/codex}
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

inspect_error=
if ! inspect_error="$("$docker_bin" image inspect --format '{{.Id}}' "$image" 2>&1)"; then
  case "$inspect_error" in
    *"No such image"*|*"not found"*)
      requested_codex_bin=$codex_bin
      codex_bin="$(readlink -f -- "$requested_codex_bin" 2>/dev/null || true)"
      [[ -n "$codex_bin" && -x "$codex_bin" ]] || die "Codex executable is missing or not executable: $requested_codex_bin"
      codex_dir="$(dirname -- "$codex_bin")"
      codex_host="$codex_dir/codex-code-mode-host"
      [[ -x "$codex_host" ]] || die "Codex code-mode host is missing or not executable: $codex_host"
      codex_sha="$(sha256sum "$codex_bin" | cut -d' ' -f1)"
      codex_host_sha="$(sha256sum "$codex_host" | cut -d' ' -f1)"
      printf 'Building missing image %s\n' "$image" >&2
      "$docker_bin" build \
        --build-context "codex_binary=$codex_dir" \
        --build-arg "CODEX_SHA256=$codex_sha" \
        --build-arg "CODEX_CODE_MODE_HOST_SHA256=$codex_host_sha" \
        --build-arg "BENCH_UID=$(id -u)" \
        --build-arg "BENCH_GID=$(id -g)" \
        -t "$image" .
      ;;
    *)
      printf 'Cannot inspect Docker image %s:\n%s\n' "$image" "$inspect_error" >&2
      exit 1
      ;;
  esac
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
  --codex-bin "$codex_bin"
  --image "$image"
)
run_args=(
  ./dist/codex-ab run
  --auth-file "$auth_file"
  --docker-bin "$docker_bin"
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
./dist/codex-ab preflight --run-dir "$run_dir" --docker-bin "$docker_bin"
"${run_args[@]}" --run-dir "$run_dir"
