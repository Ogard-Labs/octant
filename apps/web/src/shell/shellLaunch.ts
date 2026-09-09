import { decodeWindowId, type WindowId } from "@octant/contracts/shell";
import {
  capabilityTransportFor,
  isLoopbackHostname,
  type CapabilityTransportRefusal,
} from "./capabilityTransport";

export interface ShellLaunch {
  readonly serverUrl: string;
  readonly windowId?: WindowId;
}

/**
 * `absent` is a page nothing launched: there is no Machine address to speak to,
 * so the renderer asks to be opened from the desktop application or, on a
 * remote origin, offers pairing. `refused` is a page that did name a Machine
 * address, one the window capability must not travel to; it carries the
 * explanation the renderer shows instead of sending anything.
 */
export type ShellLaunchResolution =
  | { readonly status: "accepted"; readonly launch: ShellLaunch }
  | CapabilityTransportRefusal
  | { readonly status: "absent" };

export function launchFromLocation(href: string): ShellLaunchResolution {
  try {
    const url = new URL(href);
    const launchTokenFragment = url.hash.startsWith("#launchToken=");
    const windowIdParam = url.searchParams.get("windowId");
    const serverUrl = url.searchParams.get("serverUrl");
    const directCanonicalHost =
      serverUrl === null &&
      !launchTokenFragment &&
      url.protocol === "http:" &&
      isLoopbackHostname(url.hostname);
    if (serverUrl === null && !launchTokenFragment && !directCanonicalHost) {
      return { status: "absent" };
    }
    const resolvedServerUrl =
      serverUrl === null ? `${url.origin}${url.pathname === "/" ? "" : url.pathname}` : serverUrl;
    const parsedServerUrl = new URL(resolvedServerUrl);
    // Judged before anything else about the launch is read, so a refused
    // address is reported as refused even when the rest of the URL is broken.
    const transport = capabilityTransportFor(parsedServerUrl);
    if (transport.status === "refused") return transport;
    const windowId = windowIdParam === null ? undefined : decodeWindowId(windowIdParam);
    return {
      status: "accepted",
      launch: {
        serverUrl: parsedServerUrl.toString(),
        ...(windowId === undefined ? {} : { windowId }),
      },
    };
  } catch {
    return { status: "absent" };
  }
}

export function clearLaunchTokenFragment(): void {
  if (window.location.hash === "") return;
  const url = new URL(window.location.href);
  if (url.hash === "" || !url.hash.startsWith("#launchToken=")) return;
  url.hash = "";
  window.history.replaceState(null, "", url.toString());
}

export function isProjectWindowCapability(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9_-]{43}$/.test(value);
}
