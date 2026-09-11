Make subagent shell activity understandable in the user's activity feed.

An activity label like "Session 26369" or "stored script" does not explain what is happening. Display **Still Running** for an empty-input poll of a running shell command, and **Running stored script** for a retained shell-script invocation. Include a short excerpt of the actual command instead of the session number, opaque stored-script reference, entire program, or no detail.

Resolve running commands from visible call/result pairs carrying execution metadata in the same request. Match the correct call ID; program stdout alone is not trustworthy execution metadata. Resolve stored scripts through the existing retained-script storage. When source is unavailable, say **command unavailable** rather than guessing. A nonempty write_stdin input must remain a **Send input** activity.

Use the first command line for the excerpt and cap it at 120 Unicode characters, including an ellipsis when shortened or when additional lines are omitted. Shell directives and wrappers should not obscure the actual command.

Preserve JSON and SSE behavior, child-to-parent activity routing, delivery order and deduplication. This is a display change: do not alter command execution, validation, or replay payloads. Add focused tests and update the affected display documentation. Keep unrelated functionality unchanged.

