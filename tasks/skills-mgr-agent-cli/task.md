# Repository installation and non-interactive skill management

Make repository skills usable end to end without opening the interactive UI.
Deliver these connected outcomes while preserving unaffected behavior. Command
names, output formats, and implementation design are yours.

## Installation and recovery

- Install a selected skill from an HTTPS Git repository, an `owner/repo`
  shorthand, or a GitHub tree or SKILL.md URL. Support repository-root and
  nested skills, explicit skill selection, and branch names containing slashes.
  Explain ambiguous choices and reject invalid addresses without changing the
  selection. Preserve the skill's resources and executable scripts.
- Enable installed skills for the project or globally. Persist the normalized
  repository locator, including any explicitly supplied ref and path, and the
  declared skill identity in the remote selection, including schema support, so
  sync can restore missing cached content. Retain selections and
  local patches across cache loss and failed recovery; unrelated skills must
  remain usable. Preserve existing remote-content trust boundaries.

## Non-interactive management

- Expose available and active skills, their resolved owner and alternatives,
  effective selection layer, and content problems. Diagnose disabled owners,
  missing remote caches, broken local patches, and native fallbacks consistently
  with normal serving. Explain how to recover missing content.
- Check served skill bodies and their Markdown references, rejecting unreadable,
  empty, or frontmatter-only content and failed remote patches. Also accept
  explicitly named resources, including scripts, for reading without executing
  them. Report individual successes and failures and fail the command when a
  check fails.
- Set Boolean or conditional selections and remove overrides to restore
  inheritance. Preserve project-over-global precedence and native harness
  ownership. Create manager state on the first global write. Running from the
  user's home directory must use the global layer consistently for the interface,
  installation, sync, and management commands.
- Replace a complete skill manifest from a file or stdin, with an optional
  content-digest guard against stale edits. Validate changes before publication
  and preserve prior state on rejection or failed publication. Local edits retain
  file modes and update selection and placeholder identities after a rename.
  Remote edits retain fetched content unchanged, store local patches, and preserve
  remote identity and invocation metadata. Management scope must not select a
  different content owner.
- A failed background refresh must observe the normal retry interval instead of
  immediately respawning on subsequent commands.

## Tests and documentation

Preserve existing serving, ownership, selection, and interactive behavior except
for the changes above. Add tests for the installation-to-management workflow,
rejected mutations, missing-cache recovery, and refresh failures. Update affected
usage, sync help, and selection/remote-store documentation. Keep tests local with
isolated state and repository fixtures; Go dependencies are prepared beforehand.
Run `go test . -count=1` from the repository root.
