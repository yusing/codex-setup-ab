# Session-aware replay retention benchmark

This benchmark asks both arms to add automatic, session-aware retention to Mekugi's durable replay state. It is a cross-cutting storage and lifecycle task selected from an existing sibling-project change.

- Source repository: Mekugi.
- Base: `302ee2d6691b406f30fcbea38459c6ddc16f6935`.
- Excluded solution: `d49862486236d8a507bc0986aa1d543481f8fb61`.
- Task: [task.md](task.md).
- Behavioral contract: [criteria.json](criteria.json).
- Reference-change scale: 41 files, 1,888 additions, and 241 deletions.

The task covers the ownership, retention, lease, legacy-record, change-ID, capacity-error, compatibility, documentation, and test outcomes stated in the prompt. The evaluator should assess those observable outcomes rather than requiring the excluded solution's internal structure.

## Prepare an isolated launcher comparison

Use `stock-mekugi` to isolate the Mekugi launcher and tool treatment. Both arms receive the same minimal generated Codex configuration; the stock arm launches Codex directly and the current arm launches it through the selected Mekugi executable.

```sh
mekugi_source="${MEKUGI_SOURCE:-$HOME/projects/mekugi}"
mekugi_bin="${MEKUGI_BIN:-$HOME/go/bin/mekugi}"

run_dir="$(./dist/codex-ab prepare \
  --profile mekugi \
  --source "$mekugi_source" \
  --base 302ee2d6691b406f30fcbea38459c6ddc16f6935 \
  --forbidden d49862486236d8a507bc0986aa1d543481f8fb61 \
  --task tasks/session-retention/task.md \
  --criteria tasks/session-retention/criteria.json \
  --comparison stock-mekugi \
  --mekugi-source "$mekugi_source" \
  --current-launcher mekugi \
  --mekugi-bin "$mekugi_bin" \
  --reasoning-effort xhigh \
  --timeout 3600 \
  --image codex-ab:0.154.0)"
./dist/codex-ab preflight --run-dir "$run_dir"
```

Review the frozen task, criteria, identities, and setup recorded in `run.json` before starting paid inference.

## Run repeated pairs

A single pair is descriptive and is especially sensitive to first-turn cache state. Prepare at least four fresh pairs from the preflighted prototype:

```sh
trial_set="$(./dist/codex-ab prepare-trials \
  --run-dir "$run_dir" \
  --count 4)"
./dist/codex-ab run-trials \
  --trial-set "$trial_set" \
  --auth-file "$HOME/.codex/auth.json" \
  --confirm-paid-inference
```

Keep the default concurrent arm schedule for this trial set. Do not pool these results with sequential or alternating-order trials.

Compare correctness and completion first. For performance, separate first-turn cache behavior from later requests and inspect provider-reported usage, request count, model-visible tool-result sizes, and Mekugi's provider-call versus delivered-carrier diagnostics. Carrier expansion is executor-facing and must not be attributed to provider token usage.
