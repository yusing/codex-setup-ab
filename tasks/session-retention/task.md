Add automatic, session-aware retention for Mekugi's durable replay storage. Track stable-thread ownership for replay calls, journals, retained read output, change indexes, and commentary across forks and restarts. Shared records must remain while any retained session depends on them.

Remove inactive session data after 14 days and reclaim least-recently-active inactive sessions when managed storage would exceed its limit. Protect active turns, handoffs, workers, yielded operations, and ownership publication with cross-process leases. Cleanup must affect only Mekugi-managed replay state, never Codex transcripts, workspaces, exported metrics, or debug bundles.

Preserve monotonic change IDs when histories are retired. Adopt legacy records only when ownership is supported by visible evidence; protect recent unattributed records and expire old unattributed records by modification time. Missing references must explain expiry or storage pressure and must never rerun old operations.

When protected data prevents reclamation, return an actionable capacity error containing the required size and limiting budget. Report successful cleanup without changing provider responses or tool results. Remove obsolete lifetime thread/source/receipt caps while preserving bounded live queues and per-record limits. Update the owning documentation and add focused tests.
