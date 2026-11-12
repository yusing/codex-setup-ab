# Fast skill acquisition under language and tooling conditions

In a large mixed-language checkout, reading a skill whose selection condition is
`lang rust` is slow: nine `skills-mgr get` calls for that skill's reference files
take about eight seconds, because every acquisition walks the entire project to
evaluate the condition. Make `get` and `run` fast in this situation.

- Output, exit status, and enabled/disabled decisions must stay exactly the same
  as before for every selection expression, including compound, dynamic, and
  glob-like expressions, and for `list`.
- Keep acquisition correct when project files change between calls and when the
  operation is canceled.
- Do not add a persistent or on-disk cache.

Add tests for the fast path and for expressions that must keep their current
evaluation. Go dependencies are prepared beforehand. Run `go test . -count=1` from the repository root.
