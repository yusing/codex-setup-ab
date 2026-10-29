Fix `res.send` so an application-provided `Transfer-Encoding` response header is not combined with a generated `Content-Length` header.

Keep normal body conversion, content type, ETag generation (including responses
with Transfer-Encoding), freshness, status-specific header removal or replacement,
HEAD handling, and response completion behavior unchanged. In particular, HTTP 205
still removes Transfer-Encoding and sets Content-Length to zero. The check must
work for any retained transfer-coding value.

Add focused regression tests for transfer-coding values and retained ETag behavior,
and update the changelog. Keep unrelated response behavior unchanged.
