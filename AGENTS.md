# Repository navigation

- Start with the [source ownership and focused checks](README.md#source-ownership-and-focused-checks).
- Use the [CLI inspection guide](doc/cli.md#find-and-inspect-retained-evidence) for result IDs and retained evidence.
- Reader behavior lives in the [specification](doc/spec.md) and [contract](doc/contract.md).

# Benchmark task selection

When creating or updating a task pack:

- Give implementation agents only the repository task and neutral environment
  context. Keep comparison identifiers out of their instructions, paths, Git
  branches, and environment. Judges retain the comparison context they need.

- Pin a baseline commit dated after the documented knowledge cutoff of every model
  being compared. Record the model IDs, cutoff sources, and baseline date. Resolve an
  unknown cutoff before claiming that the task is post-cutoff.
- Derive realistic tasks, requirements, and expected outcomes from the repository's
  actual commits after that baseline. Record the reference commits and map each
  criterion to their behavior. Keep the reference solution out of candidate workspaces.
- Require behavior at least as good as the reference commits for the selected scope,
  while retaining unaffected repository behavior. Use upstream tests and documentation
  to establish the reference outcome; do not invent stricter compatibility rules.
- For a long-session comparison, select a substantial, integrated multi-commit change
  whose implementation needs sustained source inspection, tests, and documentation.
  Record observed journal resets separately from the intended workload; task size or
  compaction settings alone do not establish a reset.
