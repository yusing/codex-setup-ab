# Express transfer encoding

This pinned task fixes `res.send` header conflicts without losing ETags or other
response behavior. The [prompt](task.md) and [manifest](manifest.json) retain the
original commits and criteria. Both upstream changes are required:
[18e5985](https://github.com/expressjs/express/commit/18e5985b8a9d5e8423db0a9121f22bdaecd5b120)
introduces the header guard, and
[9a34acf](https://github.com/expressjs/express/commit/9a34acf03cb818ff3f8bc40e44176e277a25cbb9)
restores ETag generation with Transfer-Encoding.

## Independent observation scope

The frozen existing-behavior gate invokes actual Express `res.send` with real
Node `ServerResponse` header methods and Express request freshness. Only `end`
is replaced by a recording transport sink. The supervisor compares emitted JSON
for body conversion, UTF-8 length/content type, Buffer and JSON bodies, null and
undefined, explicit content type, ETag defaults/overrides/disabled/strong/custom
settings, HEAD, freshness, HTTP 204/205/304, completion, and chaining. It includes
an ETag observation with Transfer-Encoding, without requiring the baseline to
already have the requested header fix.

The model-free transfer check covers chunked, compress, deflate, gzip and an
extension coding with empty and nonempty bodies, plus status-specific removal
and HTTP 205's Content-Length zero replacement. Recording the transport sink
avoids imposing a wire decoder's transfer-coding restrictions. It does not verify
TCP framing or the entire Express suite. The original scoped Mocha command runs
separately as a non-gating diagnostic; exit zero or printed counts cannot replace
the independent assertions.

| Frozen source control | transfer-encoding-length | send-regressions |
| --- | --- | --- |
| Actual upstream reference endpoint | pass | pass |
| Unchanged pinned baseline | fail, generated lengths conflict | pass |
| Reference guarding only chunked | fail, other codings conflict | not used |
| Reference with the original Transfer-Encoding ETag regression | not used | fail, Transfer-Encoding loses ETags |
| Baseline guarding assignment with native `hasHeader` | pass | pass |

Reference-based controls also carry a precise hashed `package.json` adapter
restoring baseline dependency specifications. The reference ancestry's hbs,
morgan, and body-parser upgrades are unrelated context, not task requirements.
The adapter changes no `res.send` implementation or tests and lets reference
controls use the same offline baseline dependency cache as candidates. The
model-free reference fixture applies the identical frozen adapter; ordinary
candidate preparation and baseline controls are unchanged.

Each mutation is a precise hashed patch. The alternative retains length
calculation for ETags while independently guarding only the header assignment.

## Model-free validation

With Docker, the repository's base image, and an Express source checkout containing
the pinned baseline and reference history:

```sh
CODEX_AB_LIVE_DOCKER=1 CODEX_AB_EXPRESS_SOURCE=/path/to/express \
  bun test gin-express-qualification.live.test.ts
```

The check builds or reuses a dependency image and runs the real supervisor and
all applicable source controls offline, without inference. Initial dependency
preparation can access the registry; grading uses the resolved Bun cache offline.
Set `CODEX_AB_VERIFIER_IMAGE` to override the default `codex-ab:0.1.0` base image.
Source checkouts remain read-only; fixture Git operations use temporary directories.
Without the opt-in variables the live check is skipped, not verified.

New runs freeze the migrated contract. Older prepared runs require fresh
preparation; see [verification guidance](../../doc/verification.md).
