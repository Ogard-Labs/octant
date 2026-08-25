import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export interface RendererNavigationPolicyOptions {
  readonly developmentUrl?: string | undefined;
  readonly packagedRendererPath: string;
}

export interface RendererNavigationPolicy {
  readonly allows: (url: string) => boolean;
}

export interface RendererNavigationWebContentsPort {
  readonly on: (
    event: "will-navigate" | "will-redirect",
    listener: (
      event: { readonly preventDefault: () => void },
      details: { readonly url: string },
    ) => void,
  ) => void;
  readonly setWindowOpenHandler: (
    handler: (details: { readonly url: string }) => WindowOpenDecision,
  ) => void;
}

export type WindowOpenDecision = Readonly<{ action: "allow" | "deny" }>;

export function createRendererNavigationPolicy(
  options: RendererNavigationPolicyOptions,
): RendererNavigationPolicy {
  const packagedRendererPath = resolve(options.packagedRendererPath);
  const configuredDevelopmentOrigin =
    options.developmentUrl === undefined ? undefined : parseOrigin(options.developmentUrl);

  return Object.freeze({
    allows: (value: string): boolean => {
      const url = parseUrl(value);
      if (url === undefined) return false;
      if (options.developmentUrl !== undefined) {
        return (
          configuredDevelopmentOrigin !== undefined && url.origin === configuredDevelopmentOrigin
        );
      }
      if (
        url.protocol !== "file:" ||
        url.hostname !== "" ||
        url.username !== "" ||
        url.password !== ""
      ) {
        return false;
      }
      try {
        return fileURLToPath(url) === packagedRendererPath;
      } catch {
        return false;
      }
    },
  });
}

export function installRendererNavigationGuards(
  webContents: RendererNavigationWebContentsPort,
  options: RendererNavigationPolicyOptions,
): void {
  const policy = createRendererNavigationPolicy(options);
  const guard = (
    event: { readonly preventDefault: () => void },
    details: { readonly url: string },
  ): void => {
    if (!policy.allows(details.url)) event.preventDefault();
  };
  webContents.on("will-navigate", guard);
  webContents.on("will-redirect", guard);
  // Allowing a popup hands Electron a child window this port cannot reach, so
  // the child carries none of the guards above and can navigate itself
  // anywhere afterwards. Nothing asks for one either: the app never calls
  // `window.open`, its `target="_blank"` links are external and travel through
  // the host's own validated open-external path, and secondary windows are
  // created by the host with these guards installed. Every popup is refused
  // rather than allowed and left unguarded.
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function parseOrigin(value: string): string | undefined {
  const url = parseUrl(value);
  if (url === undefined || (url.protocol !== "http:" && url.protocol !== "https:"))
    return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  return url.origin;
}
