# URL import security

URL import is available to signed-in people, not agents. Imported content becomes
one page in a new private space. Failed fetches do not create spaces or pages.
Only HTTP and HTTPS URLs without embedded credentials are accepted.

Each hop resolves all available addresses once, rejects the entire answer set if
any address is non-public, then connects to the first validated address with a
pinned lookup. Connections are not pooled. The original hostname remains the
HTTP Host and HTTPS TLS identity; normal certificate validation stays enabled.
There is no fallback to another DNS lookup, proxy, or automatic redirect handler.
A public destination that cannot be reached at the selected address fails clearly;
retrying the import performs a new validation. Redirects (at most three) repeat
all checks, including same-host redirects. Bodies on redirects and errors are
closed without downloading them.

The address policy excludes private, loopback, shared carrier, link-local,
multicast, reserved, benchmarking and documentation IPv4 ranges. IPv6 is limited
to native global unicast (2000::/3), excluding 2001::/23 special-purpose space,
2001:db8::/32 and 3fff::/20 documentation, and 2002::/16 6to4. IPv4-mapped,
IPv4-compatible, well-known NAT64 prefixes, scoped and the listed transition
addresses are rejected even
when they embed a public IPv4 address. Local/localhost hostnames are rejected.
This deliberately conservative policy may exclude specialized public services.

One 15-second deadline covers resolution, connection/TLS, headers, all redirects
and streaming the body. Timed-out DNS results cannot initiate a connection.
Native OS DNS lookup may finish in the background after the deadline. Both wire
and decoded bodies are limited to 5 MiB, with streaming backpressure. gzip,
deflate and Brotli are supported; unknown or stacked encodings are rejected.
Content-Length is an early check, never a substitute for counting actual bytes.
Response headers are limited to 16 KiB. Errors close the request/response and
release the deadline timer. No private-network bypass setting exists.

This protects this importer, not operator-configured integrations or the whole
network. Network-specific translation using an otherwise global prefix cannot be
identified from the address alone. Operators should restrict service egress with
network policy.
On an air-gapped installation URL imports fail rather than bypassing the fence.

Run `npm run test:url-import` for synthetic DNS and HTTP stream regressions. Tests
substitute dependencies in an isolated module VM; they never contact third-party
sites, metadata services or internal networks, and add no test mode to production.
