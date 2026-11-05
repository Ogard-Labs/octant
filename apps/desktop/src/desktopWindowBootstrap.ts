import type { BrowserWindowConstructorOptions } from "electron";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WindowBounds } from "./nativeWindowState";
import type { WindowPresentation } from "./windowPresentation";
import { createRendererNavigationPolicy } from "./rendererNavigationPolicy";

const RENDERER_IDENTITY_HEADER = "x-octant-renderer-identity";

export interface TrustedRendererRequestContext {
  readonly serverOrigin: string;
  readonly rendererIdentity: string;
  readonly developmentOrigin?: string;
}

export function decorateTrustedRendererHeaders(input: {
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly requestUrl: string;
  readonly frameUrl?: string;
  readonly context?: TrustedRendererRequestContext;
}): Record<string, string> {
  const requestHeaders = { ...input.requestHeaders };
  for (const name of Object.keys(requestHeaders)) {
    if (
      name.toLowerCase() === RENDERER_IDENTITY_HEADER ||
      name.toLowerCase() === "x-octant-human-presentation"
    )
      delete requestHeaders[name];
  }
  if (
    input.context !== undefined &&
    isTrustedRendererShellRequest(input.requestUrl, input.frameUrl, input.context)
  ) {
    requestHeaders[RENDERER_IDENTITY_HEADER] = input.context.rendererIdentity;
  }
  return requestHeaders;
}

export function createTrustedRendererRequestRegistry() {
  const contexts = new Map<number, TrustedRendererRequestContext>();
  return Object.freeze({
    get: (webContentsId: number): TrustedRendererRequestContext | undefined =>
      contexts.get(webContentsId),
    set: (webContentsId: number, context: TrustedRendererRequestContext): void => {
      contexts.set(webContentsId, context);
    },
    remove: (webContentsId: number): void => {
      contexts.delete(webContentsId);
    },
  });
}

function isTrustedRendererShellRequest(
  requestUrl: string,
  frameUrl: string | undefined,
  context: TrustedRendererRequestContext,
): boolean {
  let parsedRequest: URL;
  try {
    parsedRequest = new URL(requestUrl);
  } catch {
    return false;
  }
  if (
    parsedRequest.origin !== context.serverOrigin ||
    (!parsedRequest.pathname.startsWith("/api/shell/") && parsedRequest.pathname !== "/api/shell")
  ) {
    return false;
  }
  if (frameUrl === undefined) return false;
  if (context.developmentOrigin !== undefined) {
    return safeOrigin(frameUrl) === context.developmentOrigin;
  }
  return isPackagedRendererUrl(frameUrl);
}

export function createMainBrowserWindowOptions(options: {
  readonly bounds: WindowBounds;
  readonly productName?: string;
  readonly capability: string;
  readonly windowId: string;
  readonly initialProjectId?: string;
  readonly initialThreadMode?: "code" | "work";
  readonly initialThreadId?: string;
  readonly localUpdatePreferences?: boolean;
  readonly preloadPath: string;
  readonly browserWindow: WindowPresentation["browserWindow"];
}): BrowserWindowConstructorOptions {
  if ((options.initialThreadMode === undefined) !== (options.initialThreadId === undefined)) {
    throw new Error("Octant received an incomplete initial thread target.");
  }
  if (options.initialThreadMode !== undefined && options.initialProjectId === undefined) {
    throw new Error("Octant initial thread target requires a Project.");
  }
  return {
    ...options.bounds,
    minWidth: 900,
    minHeight: 600,
    ...options.browserWindow,
    show: false,
    title: options.productName ?? "Octant",
    // The glass stays lit when the window is not in front. Following the
    // window let macOS swap in its inactive material, and behind the nearly
    // clear sheet a thread then read as solid black beside a grey sidebar.
    visualEffectState: "active",
    webPreferences: {
      contextIsolation: true,
      additionalArguments: [
        ...(options.localUpdatePreferences === true ? ["--octant-local-update-preferences"] : []),
        `--octant-project-capability=${options.capability}`,
        `--octant-window-id=${options.windowId}`,
        ...(options.initialProjectId === undefined
          ? []
          : [`--octant-initial-project-id=${options.initialProjectId}`]),
        ...(options.initialThreadMode === undefined || options.initialThreadId === undefined
          ? []
          : [
              `--octant-initial-thread-mode=${options.initialThreadMode}`,
              `--octant-initial-thread-id=${options.initialThreadId}`,
            ]),
      ],
      nodeIntegration: false,
      preload: options.preloadPath,
      sandbox: true,
      webSecurity: true,
    },
  };
}

function safeOrigin(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}
function isPackagedRendererUrl(value: string): boolean {
  return createRendererNavigationPolicy({
    packagedRendererPath: resolve(
      fileURLToPath(new URL("../../../apps/web/dist/index.html", import.meta.url)),
    ),
  }).allows(value);
}
