/**
 * Validate the actual Host header against the listener before dispatch.
 *
 * Loopback transport must not let a caller pick the origin the handler sees.
 * Node and Bun share this matcher so a Host that would be 400 on one adapter
 * cannot slip through on the other.
 */
export function parseListenerRequestHost(
  hostHeader: string | null | undefined,
  listenerUrl: URL,
  configuredHostname: string,
): URL | undefined {
  if (
    typeof hostHeader !== "string" ||
    hostHeader.length === 0 ||
    hostHeader.trim() !== hostHeader
  ) {
    return undefined;
  }

  let hostUrl: URL;
  try {
    hostUrl = new URL(`${listenerUrl.protocol}//${hostHeader}/`);
  } catch {
    return undefined;
  }
  if (
    hostUrl.username !== "" ||
    hostUrl.password !== "" ||
    hostUrl.pathname !== "/" ||
    hostUrl.search !== "" ||
    hostUrl.hash !== "" ||
    !hostMatchesListener(hostUrl.hostname, hostUrl.port, listenerUrl, configuredHostname)
  ) {
    return undefined;
  }
  return hostUrl;
}

export function requestUrlStaysOnHost(resolved: URL, hostUrl: URL): boolean {
  return resolved.origin === hostUrl.origin;
}

function hostMatchesListener(
  hostname: string,
  port: string,
  listenerUrl: URL,
  configuredHostname: string,
): boolean {
  const listenerHostname = normalizeHostname(listenerUrl.hostname);
  const configured = normalizeHostname(configuredHostname);
  const requestHostname = normalizeHostname(hostname);
  const hostMatches =
    requestHostname === listenerHostname ||
    requestHostname === configured ||
    (isLoopbackHostname(requestHostname) &&
      (isLoopbackHostname(listenerHostname) || isLoopbackHostname(configured)));
  if (!hostMatches) return false;
  const listenerPort =
    listenerUrl.port === "" ? defaultPort(listenerUrl.protocol) : listenerUrl.port;
  const requestPort = port === "" ? defaultPort(listenerUrl.protocol) : port;
  return requestPort === listenerPort;
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

function defaultPort(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}
