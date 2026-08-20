import { decodeWindowId, type WindowId } from "@octant/contracts/shell";

export interface ShellLaunch {
  readonly serverUrl: string;
  readonly windowId?: WindowId;
  readonly developmentWebBootstrap?: true;
}

export function launchFromLocation(href: string): ShellLaunch | undefined {
  try {
    const url = new URL(href);
    const launchTokenFragment = url.hash.startsWith("#launchToken=");
    const windowIdParam = url.searchParams.get("windowId");
    const serverUrl = url.searchParams.get("serverUrl");
    const developmentWebBootstrap = url.searchParams.get("developmentWebBootstrap") === "1";
    if (serverUrl === null && !launchTokenFragment) return undefined;
    const resolvedServerUrl =
      serverUrl === null ? `${url.origin}${url.pathname === "/" ? "" : url.pathname}` : serverUrl;
    const parsedServerUrl = new URL(resolvedServerUrl);
    if (parsedServerUrl.protocol !== "http:" && parsedServerUrl.protocol !== "https:") {
      return undefined;
    }
    const windowId = windowIdParam === null ? undefined : decodeWindowId(windowIdParam);
    return {
      serverUrl: parsedServerUrl.toString(),
      ...(windowId === undefined ? {} : { windowId }),
      ...(developmentWebBootstrap ? { developmentWebBootstrap: true as const } : {}),
    };
  } catch {
    return undefined;
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
