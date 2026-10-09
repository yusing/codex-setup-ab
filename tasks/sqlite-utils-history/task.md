# Add row change history to sqlite-utils

Add opt-in, trigger-based row change history to sqlite-utils, in both the Python
API and the `sqlite-utils` CLI. Work in this repository as a contributor would:
the change must be complete, documented, tested, and consistent with the
existing code base. Where this request fixes a name, signature, or value, use it
exactly.

## Environment

The runtime and development dependencies are preinstalled in
`/opt/codex-ab-deps/python`; there is no network access. Run tools from the
repository root with `PYTHONPATH=.`, for example
`PYTHONPATH=. /opt/codex-ab-deps/python/bin/python -m pytest -p no:cacheprovider -q`.
The same `bin` directory provides `cog`, `black`, `flake8`, and `mypy`.

## Project rules

These rules apply to every part of the change, including work done late in the
task.

1. **Compatibility.** A table without history behaves exactly as before: no
   new tables, triggers, SQL statements, or output. The existing test suite
   passes, and existing tests are not edited or removed.
2. **Quality gates.** Add no runtime dependencies. `black --check .`, `flake8`,
   and `mypy sqlite_utils tests` pass. New public methods have type hints and
   docstrings in the existing `:param name:` style.
3. **Documentation.** Document every Python API addition in
   `docs/python-api.rst` and every CLI addition in `docs/cli.rst`, with runnable
   examples and cross-references between the two, as existing features do.
   Regenerate cog-managed content so that
   `cog --check README.md docs/*.rst` passes.
4. **Changelog.** Add an "Unreleased" section at the top of
   `docs/changelog.rst` that lists every user-visible change.
5. **Identifiers.** Every SQL statement you generate quotes identifiers, so
   tables and columns whose names contain spaces, quotes, brackets, reserved
   words, or non-ASCII characters work everywhere history does.
6. **Atomicity.** An operation that fails leaves the data, schema, triggers,
   and history unchanged.
7. **Determinism.** History never records wall-clock time.
8. **CLI conventions.** New commands follow the existing CLI: the database path
   is the first argument, `--load-extension` is supported, expected errors exit
   nonzero with an `Error:` message and no traceback, and commands that print
   rows accept the same output options as `sqlite-utils rows`.
9. **Tests.** Add tests for every requirement below, for both the API and the
   CLI, in new test files.

## History model

1. **Storage.** History for table `T` lives in a table named `_history_T` (for
   example `_history_dogs`) with exactly these columns:
   - `seq`: integer primary key, increasing with each recorded change and never
     reused, even after pruning.
   - `row_id`: the rowid of the changed row.
   - `version`: 1 for the first recorded version of that rowid, then increasing
     by 1 with each later version of that rowid. Versions never restart, even
     after a delete and re-insert of the same rowid or after pruning.
   - `op`: `snapshot`, `insert`, `update`, or `delete`.
   - `data`: a JSON object with every column of the table at that moment: the
     values after an insert, update, or snapshot, and the values before a
     delete. A BLOB value is stored as `{"$hex": "<lowercase hex>"}`.
2. **Recording.** An insert records `insert`. An update that changes at least
   one value records `update`; an update that changes nothing records nothing.
   An update that changes a row's rowid records a `delete` for the old rowid,
   then an `insert` for the new one. A delete records `delete`. With the
   default connection settings, replacing an existing row (`insert` or
   `insert_all` with `replace=True`, or `INSERT OR REPLACE`) records a `delete`
   followed by an `insert`. Upserts record `insert` or `update` as appropriate.
3. **Eligibility.** Only ordinary rowid tables can have history. Views,
   virtual tables, `WITHOUT ROWID` tables, missing tables, and history tables
   themselves are rejected with a clear error.

## Python API

Add these to `sqlite_utils.db.Table`:

1. `enable_history() -> Table` creates the history table and triggers, then
   records a `snapshot` version of every existing row. Calling it on a table
   whose history is already enabled changes nothing. If a history table remains
   from an earlier `disable_history()`, it is kept and reconciled: every
   current row with no recorded version, whose latest version is a `delete`, or
   whose current data differs from its latest version gets a `snapshot`; every
   recorded rowid whose latest version is not a `delete` and whose row no longer
   exists gets a `delete` carrying the data of that latest version.
2. `disable_history(drop: bool = False) -> Table` removes the history triggers
   and keeps the history table unless `drop` is true. It does nothing for a
   table without history.
3. `has_history` is a property that is true while history triggers are
   enabled.
4. `history(rowid: int | None = None) -> list[dict]` returns history entries in
   `seq` order, optionally for one rowid. Each dictionary has the keys `seq`,
   `row_id`, `version`, `op`, and `data`, with `data` decoded to a dictionary
   and `$hex` values decoded to `bytes`.
5. `restore(rowid: int, version: int) -> Table` makes the row match a recorded
   version. Restoring a `delete` version deletes the row if it exists.
   Otherwise the row is updated, or inserted with that rowid if it no longer
   exists. Only keys that are current columns are applied; current columns
   missing from the version keep their value when updating and use their
   default when inserting. The restore is recorded like any other change. An
   unknown rowid or version raises `sqlite_utils.db.NotFoundError`.
6. `prune_history(keep: int) -> int` deletes all but the latest `keep` versions
   of each rowid and returns the number of entries deleted. `keep` must be at
   least 1.

## Schema changes

History must keep working when a table changes:

1. **`transform()`** (and therefore `extract()` and the matching CLI commands):
   the history triggers are recreated for the new schema in the same
   transaction, so later versions use the new column names. Existing history
   entries are not rewritten. A table kept with `keep_table` has no history
   triggers. `transform_sql()` includes the trigger statements that
   `transform()` runs.
2. **`add_column()`**: later versions include the new column.
3. **`Database.rename_table()`**: the history table is renamed to match, and
   recording continues with the same version numbers. If the new history table
   name is already taken, the rename fails.
4. **`drop()`**: dropping a table also drops its history table.
5. **`duplicate()`**: the copy has no history.
6. History coexists with cached counts and full-text search triggers.

## CLI

Add these commands, each mirroring the Python API:

- `sqlite-utils enable-history DB TABLE [TABLE ...]`
- `sqlite-utils disable-history DB TABLE [--drop]`
- `sqlite-utils history DB TABLE [--rowid N]`, printing the columns `seq`,
  `row_id`, `version`, `op`, and `data` (as JSON text)
- `sqlite-utils restore DB TABLE ROWID VERSION`
- `sqlite-utils prune-history DB TABLE --keep N`, reporting how many entries it
  deleted

## Acceptance examples

- Table `dogs` has `id INTEGER PRIMARY KEY`, `name TEXT`, and `age INTEGER`,
  with rows `(1, "Cleo", 5)` and `(2, "Pancakes", 3)`. Enabling history records
  `seq` 1 and 2 as `snapshot` version 1 of rowids 1 and 2. Setting Cleo's age to
  6 records `seq` 3, rowid 1, version 2, `update`, with data
  `{"id": 1, "name": "Cleo", "age": 6}`. Setting it to 6 again records nothing.
  Deleting Pancakes records `seq` 4, rowid 2, version 2, `delete`, with age 3.
  `restore(2, 1)` re-inserts Pancakes and records `seq` 5, rowid 2, version 3,
  `insert`.
- After `transform(rename={"age": "years"})`, the next update records data with
  a `years` key, while earlier entries still have `age`.
- After renaming `dogs` to `pets`, `_history_pets` exists, `_history_dogs` does
  not, and the next change to rowid 1 records the next version of rowid 1.
- `prune_history(keep=1)` leaves one entry per rowid with its original `seq`;
  the next change gets a `seq` greater than any `seq` used before.
- `sqlite-utils history data.db dogs --rowid 1 --csv` prints a CSV header
  `seq,row_id,version,op,data` and one line per version of rowid 1.
- A table named `my "odd" table` with a column named `select` and a BLOB column
  works with every command above.
- For a table without history, `transform_sql()`, `rename_table()`, and `drop()`
  run exactly the SQL they ran before this change.

## Scope

Do not add history to other commands, change existing output formats, add a
history web UI, or record which user or time made a change. Deliver the complete
feature rather than a partial or demonstration version, and report anything
left unfinished accurately.
