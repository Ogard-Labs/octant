/**
 * Where this window's capability may travel.
 *
 * The capability is a bearer secret carried in a request header, so it may
 * only go over TLS or to the Machine itself on loopback; plain HTTP to any
 * other host would show it to whoever sits on the path. The server refuses
 * non-loopback HTTP on its side too, but that refusal arrives after the header
 * has already left the browser, so the renderer judges the address before its
 * first request. The launch parser is the only place that judges the address.
 * Fetches that carry the capability still set `redirect: "error"` so a later
 * hop cannot take the header to a host this function never saw — an HTTPS
 * endpoint that 302s to non-loopback HTTP would otherwise forward it in
 * plaintext.
 */
export type CapabilityTransport =
  | { readonly status: "accepted"; readonly transport: "https" | "loopback-http" }
  | CapabilityTransportRefusal;

export interface CapabilityTransportRefusal {
  readonly status: "refused";
  readonly reason: "plain-http-off-loopback" | "unsupported-scheme";
  /** Host and port as the address named them, so the explanation can say where. */
  readonly host: string;
  readonly message: string;
}

/**
 * Judged on the parsed hostname. The URL parser has already lower-cased it,
 * expanded shorthand such as `127.1`, and compressed long IPv6 forms such as
 * `[0:0:0:0:0:0:0:1]`, so every spelling of one address arrives here the same
 * way. IPv4-mapped IPv6 (`[::ffff:127.0.0.1]`) is deliberately not loopback:
 * the host's own listener does not treat it as loopback either.
 */
export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

export function capabilityTransportFor(serverUrl: URL): CapabilityTransport {
  if (serverUrl.protocol === "https:") return { status: "accepted", transport: "https" };
  if (serverUrl.protocol === "http:") {
    if (isLoopbackHostname(serverUrl.hostname)) {
      return { status: "accepted", transport: "loopback-http" };
    }
    return {
      status: "refused",
      reason: "plain-http-off-loopback",
      host: serverUrl.host,
      message: `Octant refuses to send this window's capability over plain HTTP to ${serverUrl.host}. Open the Machine over https://, or on its loopback address.`,
    };
  }
  const scheme = serverUrl.protocol.slice(0, -1);
  return {
    status: "refused",
    reason: "unsupported-scheme",
    host: serverUrl.host,
    message: `Octant refuses to send this window's capability over ${scheme}. A Machine address uses https://, or http:// on its loopback address.`,
  };
}
