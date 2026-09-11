Implement portable, reproducible skill bundles in skills-mgr. This is a new feature, not the existing info/help work.

CLI:
  skills-mgr bundle create <skill-directory> <archive.tar.gz>
  skills-mgr bundle verify <archive.tar.gz>
  skills-mgr bundle extract <archive.tar.gz> <new-directory>

A bundle transports one complete local skill, including references, scripts, binary assets, and executable permissions. It must be deterministic, self-verifying, and safe to inspect or extract when the archive is untrusted. Support Linux; no new third-party dependency is needed.

Format v1:
- A gzip-compressed tar archive containing one regular `manifest.json` and regular payload entries named `files/<relative-path>`. No directory entries are necessary.
- The manifest JSON is {"version":1,"files":[{"path":"SKILL.md","size":123,"sha256":"<lowercase hex>","mode":420}, ...]}. File paths are unique and lexicographically sorted. Mode is decimal 420 (0644) or 493 (0755); normalize any source file with an execute bit to 0755, other files to 0644.
- A nonempty, regular root SKILL.md is mandatory. Include every regular file under the source, including dotfiles and binary data. Reject symlinks and special files anywhere in the source rather than following or silently dropping them.
- Canonical paths are nonempty slash-separated relative paths. Reject absolute paths, backslashes, empty components, "." and ".." components, Windows drive prefixes, and file/directory prefix conflicts. The manifest itself is not a payload file.
- Create must produce byte-identical archives for identical paths, contents, and normalized modes regardless of source directory name, filesystem iteration order, ownership, and timestamps.
- Limits: at most 1024 payload files, at most 16 MiB per payload, at most 64 MiB total payload bytes, and at most 1 MiB manifest bytes. Enforce limits while reading untrusted data, not after unbounded buffering.

Verify:
- Validate the gzip trailer/checksum and tar structure, supported version, required SKILL.md, manifest paths/order/uniqueness/modes/sizes/digests, and exact one-to-one manifest/payload correspondence.
- Reject missing, extra, duplicate, truncated, digest-mismatched, oversized, or nonregular entries (including symlinks/hardlinks), and unsafe names. Do not trust tar size fields or manifest claims as a substitute for enforcing limits.
- Verification must not write files, migrate metadata, start a background refresh, or use the network.

Publication and failures:
- Create and extract never overwrite an existing destination, even an empty directory or symlink. Competing publishers to the same destination must not clobber the winner.
- Build in a temporary sibling and publish only after complete success. On any error, retain the original destination state, remove your temporary files, and leave no partially extracted destination.
- Reject create output paths inside the source tree so the archive cannot include itself. Reject missing/invalid sources and incorrect argument counts with useful errors.
- Extract must validate the entire bundle before publication, restore normalized executable permissions, and keep every write confined to its temporary destination.
- These commands are local and read-only with respect to the source, user home, and project metadata. Only explicitly requested archive/extraction destinations and temporary siblings may be written. Preserve existing commands.

Update command help and README with a usable round-trip example, format/limits, and overwrite behavior. Add focused tests covering determinism, round trip, integrity/hostile inputs, read-only behavior, and concurrent publication. Run the affected package suite and fix change-caused failures. Do not implement unrelated remote fetching, installation, or skill-selection changes.

