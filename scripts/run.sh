#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/run.sh --preset NAME [--task NAME] [--model NAME] [--reasoning-effort LEVEL] [--mentor-handoff]

Prepare, preflight, and run one pinned task with one comparison:

Tasks:

  nvm-download-no-eval  Harden NVM's curl-to-wget argument translation (default)
  session-retention     Add session-aware Mekugi replay storage retention

Comparisons:

  stock-current       Minimal stock Codex vs the current setup
  current-vs-current-mekugi
                      Direct Codex vs Mekugi with the same current setup
  stock-mekugi        Minimal stock Codex vs minimal stock Codex plus Mekugi
  codex-mekugi-grok   Stock Codex plus Mekugi vs the Grok CLI

Model options:
  --model NAME          gpt-6-astra or gpt-6-sol (Codex comparisons; default gpt-6-astra)
  --reasoning-effort LEVEL
                        medium, high, or xhigh (default: high for Grok; otherwise medium for NVM, xhigh for session retention)
  --mentor-handoff      Enable both Mekugi main-thread and subagent mentor handoff (default: off)

Optional environment overrides:
  CODEX_AB_SOURCE_DIR        NVM checkout (default: /tmp/codex-ab-nvm-source)
  CODEX_AB_IMAGE             Container image (default: codex-ab:0.1.0)
  CODEX_AB_DOCKER_BIN        Docker executable (default: docker)
  CODEX_AB_CODEX_BIN         Standalone Codex executable (default: $HOME/.local/bin/codex)
  CODEX_AB_MEKUGI_SOURCE     Mekugi checkout (default: $HOME/projects/mekugi)
  CODEX_AB_MEKUGI_BIN        Mekugi executable (default: $HOME/go/bin/mekugi)
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
task=
model=
reasoning_effort=
mentor_handoff=false
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
    --task)
      (($# >= 2)) || die "--task requires a value"
      [[ -z "$task" ]] || die "--task may be supplied only once"
      [[ -n "$2" ]] || die "--task requires a nonempty value"
      task=$2
      shift 2
      ;;
    --task=*)
      [[ -z "$task" ]] || die "--task may be supplied only once"
      task=${1#*=}
      [[ -n "$task" ]] || die "--task requires a nonempty value"
      shift
      ;;
    --model)
      (($# >= 2)) || die "--model requires a value"
      [[ -z "$model" ]] || die "--model may be supplied only once"
      [[ -n "$2" ]] || die "--model requires a nonempty value"
      model=$2
      shift 2
      ;;
    --model=*)
      [[ -z "$model" ]] || die "--model may be supplied only once"
      model=${1#*=}
      [[ -n "$model" ]] || die "--model requires a nonempty value"
      shift
      ;;
    --reasoning-effort)
      (($# >= 2)) || die "--reasoning-effort requires a value"
      [[ -z "$reasoning_effort" ]] || die "--reasoning-effort may be supplied only once"
      [[ -n "$2" ]] || die "--reasoning-effort requires a nonempty value"
      reasoning_effort=$2
      shift 2
      ;;
    --reasoning-effort=*)
      [[ -z "$reasoning_effort" ]] || die "--reasoning-effort may be supplied only once"
      reasoning_effort=${1#*=}
      [[ -n "$reasoning_effort" ]] || die "--reasoning-effort requires a nonempty value"
      shift
      ;;
    --mentor-handoff)
      [[ "$mentor_handoff" == false ]] || die "--mentor-handoff may be supplied only once"
      mentor_handoff=true
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
task=${task:-nvm-download-no-eval}
case "$task" in
  nvm-download-no-eval|session-retention) ;;
  *) die "unknown task '$task'; run with --help to list tasks" ;;
esac

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
grok_bin=${CODEX_AB_GROK_BIN:-$user_home/.grok/bin/grok}
auth_file=${CODEX_AB_AUTH_FILE:-$user_home/.codex/auth.json}
grok_auth_file=${CODEX_AB_GROK_AUTH_FILE:-$user_home/.grok/auth.json}

case "$preset" in
  stock-current|current-vs-current-mekugi|stock-mekugi|codex-mekugi-grok) ;;
  *) die "unknown preset '$preset'; run with --help to list presets" ;;
esac
if [[ "$mentor_handoff" == true && "$preset" == stock-current ]]; then
  die "--mentor-handoff requires a Mekugi preset"
fi

if [[ "$task" == nvm-download-no-eval ]]; then
  if [[ -e "$source_dir" && ! -d "$source_dir/.git" ]]; then
    die "source path exists but is not a Git checkout: $source_dir"
  fi
  if [[ ! -d "$source_dir/.git" ]]; then
    git clone https://github.com/nvm-sh/nvm.git "$source_dir"
  fi
elif ! git -C "$mekugi_source" rev-parse --git-dir >/dev/null 2>&1; then
  die "Mekugi source is not a Git checkout: $mekugi_source"
fi

image_build_reason=
if ! inspect_error="$("$docker_bin" image inspect --format '{{.Id}}' "$image" 2>&1)"; then
  case "$inspect_error" in
    *"No such image"*|*"not found"*) image_build_reason="missing" ;;
    *)
      printf 'Cannot inspect Docker image %s:\n%s\n' "$image" "$inspect_error" >&2
      exit 1
      ;;
  esac
else
  # The command substitutions intentionally run inside the container.
  # shellcheck disable=SC2016
  if ! container_identity="$("$docker_bin" run --rm --network none "$image" sh -lc 'printf "%s:%s\n" "$(id -u)" "$(id -g)"' 2>&1)"; then
    die "cannot verify operator identity in existing image $image: $container_identity"
  fi
  [[ "$container_identity" == "1000:1000" ]] || image_build_reason="operator identity is $container_identity"
fi

requested_codex_bin=$codex_bin
codex_bin="$(readlink -f -- "$requested_codex_bin" 2>/dev/null || true)"
[[ -n "$codex_bin" && -x "$codex_bin" ]] || die "Codex executable is missing or not executable: $requested_codex_bin"
codex_dir="$(dirname -- "$codex_bin")"
codex_host="$codex_dir/codex-code-mode-host"
[[ -x "$codex_host" ]] || die "Codex code-mode host is missing or not executable: $codex_host"
codex_sha="$(sha256sum "$codex_bin" | cut -d' ' -f1)"
codex_host_sha="$(sha256sum "$codex_host" | cut -d' ' -f1)"

if [[ -z "$image_build_reason" ]]; then
  if ! container_hashes="$("$docker_bin" run --rm --network none "$image" sha256sum /usr/local/bin/codex /usr/local/bin/codex-code-mode-host 2>&1)"; then
    die "cannot verify Codex binaries in existing image $image: $container_hashes"
  fi
  expected_hashes="$(printf '%s  %s\n%s  %s\n' "$codex_sha" /usr/local/bin/codex "$codex_host_sha" /usr/local/bin/codex-code-mode-host)"
  [[ "$container_hashes" == "$expected_hashes" ]] || image_build_reason="Codex binaries differ from the selected host pair"
fi

if [[ -n "$image_build_reason" ]]; then
  printf 'Building image %s (%s)\n' "$image" "$image_build_reason" >&2
  "$docker_bin" build \
    --build-context "codex_binary=$codex_dir" \
    --build-arg "CODEX_SHA256=$codex_sha" \
    --build-arg "CODEX_CODE_MODE_HOST_SHA256=$codex_host_sha" \
    --build-arg "BENCH_UID=1000" \
    --build-arg "BENCH_GID=1000" \
    -t "$image" .
fi
bun run build

comparison=$preset
if [[ "$preset" == current-vs-current-mekugi ]]; then
  comparison=same-setup
fi
if [[ "$preset" == codex-mekugi-grok && -z "$reasoning_effort" ]]; then
  reasoning_effort=high
fi

prepare_args=(
  ./dist/codex-ab prepare
  --comparison "$comparison"
  --codex-bin "$codex_bin"
  --image "$image"
)
if [[ -n "$model" ]]; then
  prepare_args+=(--model "$model")
fi
case "$task" in
  nvm-download-no-eval)
    prepare_args+=(
      --task-pack ./tasks/nvm-download-no-eval/manifest.json
      --source "$source_dir"
      --reasoning-effort "${reasoning_effort:-medium}"
    )
    ;;
  session-retention)
    prepare_args+=(
      --profile mekugi
      --source "$mekugi_source"
      --base 302ee2d6691b406f30fcbea38459c6ddc16f6935
      --forbidden d49862486236d8a507bc0986aa1d543481f8fb61
      --task ./tasks/session-retention/task.md
      --criteria ./tasks/session-retention/criteria.json
      --reasoning-effort "${reasoning_effort:-xhigh}"
      --timeout 3600
    )
    ;;
esac
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
      --mekugi-flags "[\"--main-mentor-handoff=$mentor_handoff\",\"--mentor-handoff=$mentor_handoff\"]"
    )
    ;;
  codex-mekugi-grok)
    prepare_args+=(
      --mekugi-source "$mekugi_source"
      --mekugi-bin "$mekugi_bin"
      --mekugi-flags "[\"--mode=mekugi\",\"--grok\",\"--main-mentor-handoff=$mentor_handoff\",\"--mentor-handoff=$mentor_handoff\"]"
      --grok-bin "$grok_bin"
    )
    run_args+=(--grok-auth-file "$grok_auth_file")
    ;;
esac

run_dir="$("${prepare_args[@]}")"
"${run_args[@]}" --run-dir "$run_dir"
