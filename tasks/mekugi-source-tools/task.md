# Preserve source reads and outlines in Mekugi's native helpers

Native `mcat` output is often piped into another tool. Reading a whole file
without options should reproduce its UTF-8 bytes exactly, including mixed line
endings and the presence or absence of a final newline. Stream large files
without holding their full contents in memory. Keep UTF-8 validation and avoid
adding framing or generated-file advice to a plain single-file read. Explicit
ranges, line-numbering, head/tail selections and bundles keep their existing
semantics, including generated-file advice for selections.

Make `mfinspect` recover useful outlines from source spellings it currently
mishandles:

- List top-level flow-style YAML frontmatter keys in Markdown, including
  quoted Unicode keys and keys following a plain value with an apostrophe.
  Preserve their source ranges and the outline of the Markdown body.
- Preserve lone UTF-16 surrogates in JSON key pointers and JavaScript or
  TypeScript import names using escapes, without substituting a replacement
  character or double-escaping. Preserve valid keys when a later JSON value
  needs parser recovery.
- Decode raw and escaped Go import literals. If a malformed escape contains
  multibyte input, report incomplete parsing and retain later declarations
  rather than panicking.

At the native command entry points, reject non-UTF-8 arguments instead of
silently opening a different pathname. A stdout write or flush failure must
produce a diagnostic and a nonzero exit status. Keep existing option parsing
and ordinary successful output stable.

Add focused regression coverage. From `codex-rs`, format the affected crate
with `cargo fmt -p codex-mekugi-tools` and run
`cargo test --locked -p codex-mekugi-tools --lib`. The full app-server build
and unrelated native runtime changes are out of scope.
