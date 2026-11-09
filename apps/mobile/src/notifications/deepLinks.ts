export interface MobileDeepLinkTarget {
  readonly hostId: string;
  readonly threadId: string;
  readonly mode?: "chat" | "work" | "code";
}

/** The computer whose held moves a tapped notification asks the phone to show. */
export interface MobileMovesDeepLinkTarget {
  readonly hostId: string;
}

function octantLinkSegments(url: string): ReadonlyArray<string> | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "octant:") return undefined;
  // `octant://hosts/<id>/threads/...` puts "hosts" in hostname; absolute-path
  // forms (`octant:///hosts/...`) keep the full path in pathname.
  return [
    ...(parsed.hostname.length > 0 ? [parsed.hostname] : []),
    ...parsed.pathname.replace(/^\/+/, "").split("/"),
  ].filter(Boolean);
}

/**
 * Parse `octant://hosts/{hostId}/threads/{threadId}` and optional mode
 * `octant://hosts/{hostId}/threads/{mode}/{threadId}`.
 */
export function parseMobileThreadDeepLink(url: string): MobileDeepLinkTarget | undefined {
  const pathSegments = octantLinkSegments(url);
  if (pathSegments === undefined) return undefined;
  // hosts/<hostId>/threads/<threadId>
  // hosts/<hostId>/threads/<mode>/<threadId>
  if (pathSegments[0] !== "hosts" || pathSegments[2] !== "threads") return undefined;
  const hostId = pathSegments[1];
  if (hostId === undefined || hostId.length === 0) return undefined;
  if (pathSegments.length === 4) {
    const threadId = pathSegments[3];
    if (threadId === undefined || threadId.length === 0) return undefined;
    return { hostId, threadId };
  }
  if (pathSegments.length === 5) {
    const mode = pathSegments[3];
    const threadId = pathSegments[4];
    if (threadId === undefined || threadId.length === 0) return undefined;
    if (mode !== "chat" && mode !== "work" && mode !== "code") return undefined;
    return { hostId, threadId, mode };
  }
  return undefined;
}

/**
 * Parse `octant://hosts/{hostId}/moves`, the link a notification that a move
 * waits for this phone opens. It names no thread: the Computers screen's
 * Moves waiting for you list reads what waits from each computer itself.
 */
export function parseMobileMovesDeepLink(url: string): MobileMovesDeepLinkTarget | undefined {
  const pathSegments = octantLinkSegments(url);
  if (pathSegments === undefined || pathSegments.length !== 3) return undefined;
  const [hosts, hostId, moves] = pathSegments;
  if (hosts !== "hosts" || moves !== "moves") return undefined;
  if (hostId === undefined || hostId.length === 0) return undefined;
  return { hostId };
}

export function buildMobileMovesDeepLink(hostId: string): string {
  return `octant://hosts/${hostId}/moves`;
}

export function buildMobileThreadDeepLink(target: MobileDeepLinkTarget): string {
  if (target.mode === undefined) {
    return `octant://hosts/${target.hostId}/threads/${target.threadId}`;
  }
  return `octant://hosts/${target.hostId}/threads/${target.mode}/${target.threadId}`;
}
