# Uninstall remote skills without the interactive UI

Agents can install a remote skill with `skills-mgr install` and manage it with
the other non-interactive commands, but removing one still requires opening the
interactive UI. Let agents uninstall an installed remote skill from the command
line. The command name is `uninstall`; its output wording and implementation
design are yours.

- Uninstalling removes the same state as uninstalling that skill from the
  interactive UI in the same scope: the installed remote skill and its local
  patch and sidecar files, its selection in the active layer, and its managed
  placeholders. Print a confirmation on success.
- Uninstall is also how agents recover broken installations. It must work when
  the skill is disabled, has a conditional selection (uninstalling must not run
  that condition), its cached content is missing, or its local override file is
  malformed or unreadable.
- Never delete local or harness-owned skills, including a local skill that
  shadows a remote skill of the same name. Reject unknown and invalid skill names
  and canceled operations without changing anything. Other projects' selection
  files stay unchanged; they can restore the skill later with `sync`.
- Global scope follows the existing management commands: `-g`, and running from
  the home directory. When a project-scope uninstall is refused because the skill
  is configured globally, the error tells the agent the non-interactive way to
  remove it.
- Update usage help, the fish completion script, and the README.

Preserve existing interactive, installation, selection, and serving behavior.
Add tests that exercise the command end to end with isolated state. Go
dependencies are prepared beforehand. Run `go test . -count=1` from the
repository root.
