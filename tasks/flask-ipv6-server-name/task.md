Fix Flask's development server address selection when `SERVER_NAME` contains a bracketed IPv6 address, with or without an explicit port.

The configured hostname and port must be parsed without treating IPv6 colons as
the host-port separator. Retain support for DNS names and IPv4 addresses, existing
host/port defaults, explicit `host` or `port` overrides including port zero, debug
options, and server shutdown cleanup. URL-parser hostname normalization and
validation are acceptable.

Add focused regression tests for IPv6 address selection and retained override and
cleanup behavior. Keep the change scoped to development-server address selection.
