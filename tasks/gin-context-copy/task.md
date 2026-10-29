Fix `Context.Copy` so a copied Gin context preserves the request's errors and accepted response formats without sharing either slice's mutable backing storage with the original context.

Keep the existing copy behavior for writer state, request data, keys, parameters, handlers, and paths. Preserve `nil` for an unset errors or accepted-formats slice.

Add focused regression tests for copied values, slice backing-storage isolation,
and nil preservation. Keep the change scoped to context copying and retain
unaffected behavior. Run the `TestContextCopy` tests.
