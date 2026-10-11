import { randomBytes, randomUUID } from "node:crypto";

type FetchPort = (input: string, init: RequestInit) => Promise<Response>;

export interface BrowserLaunchLinkOptions {
  readonly hostUrl: string;
  readonly desktopBridgeSecret: string;
  readonly fetch?: FetchPort;
}

/**
 * The address "Open in browser" hands the system browser. The host gives a
 * browser a session only for a one-time launch token minted with the bridge
 * secret, so a typed address or another OS user on the same loopback gets
 * nothing. The token is bound to the host's own origin, rides in the fragment
 * so no server log sees it, and the renderer strips it as soon as it reads it.
 */
export async function createBrowserLaunchLink(options: BrowserLaunchLinkOptions): Promise<string> {
  const fetch = options.fetch ?? globalThis.fetch;
  const hostUrl = new URL(options.hostUrl);
  let response: Response;
  try {
    response = await fetch(new URL("/api/desktop/launch-sessions", hostUrl).toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-desktop-secret": options.desktopBridgeSecret,
      },
      body: JSON.stringify({
        windowId: randomUUID(),
        capability: randomBytes(32).toString("base64url"),
        origin: hostUrl.origin,
      }),
    });
  } catch {
    throw new Error("Octant could not reach its host to open the browser.");
  }
  if (response.status !== 201) {
    throw new Error("Octant could not create a browser launch link.");
  }
  let launchToken: unknown;
  try {
    launchToken = ((await response.json()) as { readonly launchToken?: unknown }).launchToken;
  } catch {
    launchToken = undefined;
  }
  if (
    typeof launchToken !== "string" ||
    !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(launchToken)
  ) {
    throw new Error("Octant could not create a browser launch link.");
  }
  const url = new URL(hostUrl);
  url.hash = `launchToken=${launchToken}`;
  return url.toString();
}
