# Improve grouped subagent tool activity

Update Hpatch router subagent tool activity so consecutive pending tool calls from the same child are easier to scan without losing any observed information.

At each root delivery boundary, render eligible consecutive tool calls under one `In <canonical agent path>` heading. Use readable Markdown action bullets beneath that heading; each bullet contains a label such as `Read`, `Search`, `List`, `Inspect`, or `Run` and its corresponding call detail. Calls with different action labels may share the same group, and source-call order must remain unchanged.

Keep the existing delivery contracts:

- Group all eligible consecutive same-path calls that fit the response budget. Deliver even a single call immediately; do not wait for more calls to fill a group.
- A different child path, a non-tool notice, or the boundary between deferred and current activity ends the group.
- If the current response byte budget can render only the first action, deliver it and retain the next action for a later response. Rendered activity must never exceed the existing overall activity and publication byte limits.
- Each source call remains independently deduplicated. Router-authored root copies remain removable from provider-bound replay input without removing original history.
- Preserve multiline details, code fences, line breaks, and relative source indentation when nesting them in the list.

For recognized tool transformations, including `Read`, `Search`, `List`, `Inspect`, skill reads, web and file search, code execution, input, image, and edit displays, retain the complete transformed detail instead of applying the old per-preview 240-character or 4 KiB source-window truncation. Long whitespace must not hide a later operand, and every operation classified from a multi-command shell call must remain present. Existing overall activity admission and rendering budgets are still authoritative. Preserve existing bounded behavior for unsupported or unknown raw tool displays and leave unrelated tool-call, response, and replay behavior unchanged.

Update the owning router commentary specification to describe the grouped `In <path>` list format and full transformed details. Add focused tests for mixed action grouping, ordering and boundaries, multiline content, long classified details, byte-budget deferral, source deduplication and replay stripping, immediate delivery, and complete same-path groups.
