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

/** What a tab remembers between loads; `sessionStorage` has exactly this shape. */
export interface LaunchMemory {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const REMEMBERED_SERVER_PREFIX = "octant:launch-server:";

function rememberedServerUrl(memory: LaunchMemory | undefined, origin: string): string | null {
  try {
    return memory?.getItem(REMEMBERED_SERVER_PREFIX + origin) ?? null;
  } catch {
    return null;
  }
}

function rememberServerUrl(memory: LaunchMemory | undefined, origin: string, serverUrl: string) {
  try {
    memory?.setItem(REMEMBERED_SERVER_PREFIX + origin, serverUrl);
  } catch {
    // The launch still works for this load; it just will not survive the next.
  }
}

/** The tab's own memory, when the browser gives it one. */
export function tabLaunchMemory(): LaunchMemory | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the Machine a page was launched against.
 *
 * `memory` carries the address across loads of one tab. A development renderer
 * is served by Vite while the host listens elsewhere, so the page's own origin
 * is not the host: a bare `http://localhost:<vite>/` — what a reload or an
 * in-tab navigation leaves once the `serverUrl` query is gone — was read as a
 * host that answers nothing, and the window reported its Machine authority
 * unavailable. A page launched with an address names it again and wins; one
 * that does not falls back to the address this tab was launched with, judged
 * again exactly like a typed one.
 */
export function launchFromLocation(href: string, memory?: LaunchMemory): ShellLaunchResolution {
  try {
    const url = new URL(href);
    const launchTokenFragment = url.hash.startsWith("#launchToken=");
    const windowIdParam = url.searchParams.get("windowId");
    const namedServerUrl = url.searchParams.get("serverUrl");
    const serverUrl =
      namedServerUrl ?? (launchTokenFragment ? null : rememberedServerUrl(memory, url.origin));
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
    // Only a split launch needs remembering: a host that serves its own
    // renderer is found again from the page origin alone.
    if (namedServerUrl !== null && parsedServerUrl.origin !== url.origin) {
      rememberServerUrl(memory, url.origin, parsedServerUrl.toString());
    }
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
