# Gin context copying

This pinned task fixes `Context.Copy` while retaining its existing copy behavior.
The [prompt](task.md) and [manifest](manifest.json) retain the original commits and
criteria. The upstream reference is
[293ad7e](https://github.com/gin-gonic/gin/commit/293ad7edebb3ae30369288bd6416ca0d78474727).

## Independent observation scope

The frozen existing-behavior gate runs an evaluator-authored package-local Go
observer against the real `Context.Copy`. It reports request and engine identity,
writer rebinding, detached underlying writer, writer status/size, abort state,
handlers, path, copied keys and parameters, and mutation isolation for keys and
parameters. The supervisor compares the returned JSON values outside the child;
a passing Go test summary is not the assertion. The observer uses a private Go
build overlay with a randomly named, nonexistent virtual test file in the
candidate package. It neither writes nor replaces candidate files or reserves
a candidate filename or test name. The live regression includes candidate-owned
files using the former observer filename and test symbol, with a declaration
dependency that detects silent replacement.

The model-free check additionally observes populated Errors and Accepted values,
replacement of existing slice elements, nil preservation, and empty slices.
Error objects need not be deep-cloned. The original `TestContextCopy` command is
executed separately as a non-gating diagnostic. These observations do not certify
all Gin tests or deliberately reflective implementations.

Frozen controls map to the two criteria as follows:

| Control | copy-isolation | existing-copy-behavior |
| --- | --- | --- |
| Actual upstream reference | pass | pass |
| Unchanged pinned baseline | fail, values are lost | pass |
| Reference with shallow Errors/Accepted aliases | fail, original elements change | not used |
| Reference with aliased Params | not used | fail, original parameter changes |
| Baseline with nil-preserving append copies | pass | pass |

Mutations are exact, hashed patches to the pinned source, not replacement Gin
implementations. The alternative preserves the specified behavior without
requiring the reference's `make` plus `copy` spelling.

## Model-free validation

With Docker, the repository's base image, and a source checkout containing both
pinned commits:

```sh
CODEX_AB_LIVE_DOCKER=1 CODEX_AB_GIN_SOURCE=/path/to/gin \
  bun test gin-express-qualification.live.test.ts
```

The check builds or reuses the task dependency image, warms the Go compiler cache,
and runs the real supervisor and every applicable control with networking disabled.
Initial dependency preparation may download modules. Set `CODEX_AB_VERIFIER_IMAGE`
to override the default `codex-ab:0.1.0` base image. Source checkouts are read-only;
fixture Git operations occur in temporary directories. This makes no model requests.
Without the opt-in variables the live check is skipped, not verified.

New runs freeze the migrated contract. Older prepared runs require fresh
preparation; see [verification guidance](../../doc/verification.md).
