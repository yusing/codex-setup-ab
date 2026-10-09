# Upgrade sqlite-utils schema fidelity and CLI behavior

Deliver the following integrated upgrade across the Python API and CLI while
preserving unaffected functionality. Implementation design is yours.

## Outcomes, in order

1. Transform tables referenced by views, including with `keep_table`, without
   redirecting the views to a backup table. Automatic view rewriting is optional.
2. Add `Table.checks`, `Table.column_checks`, and `Table.table_checks` for CHECK
   introspection. Expose expressions, constraint names, owning columns, literal
   choices where applicable, original SQL, and source spans. Handle real SQLite
   syntax, including comments and quoted identifiers.
3. Preserve CHECK constraints through transformations; rename their column
   references correctly and handle dropped columns without leaving broken checks.
4. Keep schema introspection compatible with older supported SQLite versions.
5. Preserve column comments through transformations, including rename and reorder.
6. Make FTS tokenizer arguments safe from SQL injection while retaining valid
   tokenizer configurations in the API and CLI.
7. Support offset without limit in row and search APIs and the rows CLI.
8. Make table/view tests unambiguous about which kind of object they exercise.
9. Improve affected type-checking interfaces without changing runtime behavior.
10. Treat empty or whitespace-only auto-detected file input as empty rows while
    preserving normal JSON, CSV, TSV, and explicit-format input behavior.
11. Make `convert --dry-run` work with identifiers containing closing brackets.
12. Make index introspection and transforms work with identifiers containing
    double quotes.
13. Decode unquoted TRUE, FALSE, and NULL defaults as `True`, `False`, and `None`
    while preserving other supported default forms.
14. Update the changelog for the completed changes.
15. Preserve explicit indexes when transforming renamed columns, including their
    uniqueness, collation, and sort order.
16. Add `sqlite_utils.ANY` and ANY type support across table creation, column
    addition, introspection, transform, extraction, and CLI type controls. Retain
    STRICT ANY values, including numeric-looking text, subject to SQLite's normal
    extraction equality/deduplication; keep ordinary-table affinity behavior.
17. Preserve AUTOINCREMENT behavior through transforms, including the high-water
    mark when the highest row has been deleted.
18. Preserve column and composite UNIQUE constraints through transforms, including
    names, collations, sort order, conflict behavior, and column renames/drops.
19. Convert exact empty TEXT values to NULL when transforming to INTEGER, FLOAT,
    or REAL. Leave other values to SQLite's normal conversion behavior.

Keep existing transaction, foreign-key, and connection-setting protections
intact. Handle unsupported transformations safely. Safe support for additional
cases is welcome.

## Delivery

Make one corresponding commit for each numbered outcome, in that order, with
subjects beginning `upgrade-01:` through `upgrade-19:`. Include relevant tests
and API/CLI documentation with each change. Collect initial changelog entries
in step 14 and update them with subsequent changes. Keep these commits separate
and independently reviewable; do not create empty marker commits.
Report any unfinished steps rather than claiming them complete.

Update affected API/CLI documentation, generated reference, and the Unreleased
changelog. Preserve meaningful existing coverage and add regression tests for
the changes and their interactions. Run the full suite and the repository's
black, flake8, mypy, and cog checks.

## Environment

Runtime and development dependencies are preinstalled in
`/opt/task-deps/python`; there is no network access. Use that environment
with `PYTHONPATH=.` from the repository root. For example:

```sh
PYTHONPATH=. PYTHONDONTWRITEBYTECODE=1 /opt/task-deps/python/bin/python -m pytest -p no:cacheprovider -q
```

Run the CLI with the same Python interpreter using `-m sqlite_utils`.
