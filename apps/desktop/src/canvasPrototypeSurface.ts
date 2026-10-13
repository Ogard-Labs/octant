import { CANVAS_DESIGN_PAGE_PATH } from "@octant/contracts/canvas";
import type { Protocol, Session, WebContents, WebPreferences } from "electron";

/**
 * Where a running Canvas prototype runs on the desktop: a surface of its own
 * with no route out.
 *
 * A prototype is agent-written script. In a sandboxed frame of the app window
 * the page's content policy stops fetch, sockets, images, and forms, but not
 * WebRTC, and the renderer's WebRTC policy stops UDP only: on Electron 43.1.0 a
 * peer connection naming a TURN server over TCP still reached a local listener
 * (see the Canvas frames threat model). So a running prototype is drawn in a
 * `<webview>` whose guest lives in a session of its own:
 *
 * - every connection goes to a SOCKS proxy that is never a proxy, loopback
 *   included, so there is no TCP or UDP route out. The WebRTC policy also
 *   refuses non-proxied UDP;
 * - the one page it may load is the host's design page for a ticket. A custom
 *   scheme answers it from this process, which asks the host for the page, so
 *   the guest needs no route to the host's address. Nothing else is served;
 * - the main process, not the renderer, decides what the guest is: a
 *   `<webview>` is attached only when it names a ticketed design page on this
 *   host, in the surface's own partition and with the guest's preferences set
 *   here. A renderer cannot choose another address, partition, or preload;
 * - the session shares no cookies, storage, or permissions with the app's, and
 *   refuses every permission, download, new window, and navigation away from
 *   the page.
 *
 * What it does not close: Electron has no per-session resolver rule, so a name
 * lookup the page asks for (a `dns-prefetch` link, a WebRTC server name) is
 * still made by the app's resolver.
 */

/** The scheme the guest's one page is served under, to the surface's session only. */
export const CANVAS_PROTOTYPE_SCHEME = "octant-prototype";
/** In memory: not prefixed `persist:`, so nothing a page does outlives the app. */
export const CANVAS_PROTOTYPE_PARTITION = "octant-canvas-prototype";
/** What the guest's preload sends its embedder for each bridge message. */
export const CANVAS_PROTOTYPE_BRIDGE_EVENT = "octant-canvas-prototype-bridge";
export const CANVAS_FRAME_FOCUS_ESCAPE_CHANNEL = "octant:canvas:frame-focus-escape";

/**
 * Port 1 on this machine is never a proxy. Connections and name lookups sent
 * here fail; `<-loopback>` keeps the proxy rule from exempting loopback.
 */
const NO_ROUTE_PROXY = "socks5://127.0.0.1:1";
const NO_ROUTE_BYPASS = "<-loopback>";

const TICKET = /^[A-Za-z0-9_-]{43}$/;
/** What of the host's answer the guest keeps: the page and the policy it came with. */
const PAGE_HEADERS = [
  "content-type",
  "content-security-policy",
  "referrer-policy",
  "cache-control",
];

export type CanvasPrototypeSurfacePreparation =
  | { readonly status: "ready" }
  | { readonly status: "unavailable"; readonly reason: string };

export interface CanvasPrototypeSessionPort {
  readonly setProxy: (config: {
    readonly proxyRules: string;
    readonly proxyBypassRules: string;
  }) => Promise<void>;
  readonly resolveProxy: (url: string) => Promise<string>;
  /** Refuses every permission, device, screen-capture, and download request. */
  readonly refuseEverythingAsked: () => void;
  readonly serve: (handler: (request: Request) => Promise<Response>) => void;
}

export interface CanvasPrototypeCancellable {
  readonly preventDefault: () => void;
}

export interface CanvasPrototypeKeyInput {
  readonly type: string;
  readonly key: string;
  readonly meta: boolean;
  readonly control: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

export interface CanvasPrototypeHostPort {
  readonly onWillAttachWebview: (
    listener: (
      event: CanvasPrototypeCancellable,
      webPreferences: WebPreferences,
      params: Record<string, string>,
    ) => void,
  ) => void;
}

export interface CanvasPrototypeGuestPort {
  /** Whether the guest lives in the surface's own session. */
  readonly inSurfaceSession: () => boolean;
  readonly onNavigation: (listener: (event: CanvasPrototypeCancellable) => void) => void;
  readonly onKeyInput: (
    listener: (event: CanvasPrototypeCancellable, input: CanvasPrototypeKeyInput) => void,
  ) => void;
  readonly refuseNewWindows: () => void;
  readonly refuseNonProxiedUdp: () => void;
  /** Tells the window that embeds the guest; a no-op until it is attached. */
  readonly sendToHost: (channel: string) => void;
}

export interface CanvasPrototypeSurfaceOptions {
  readonly session: CanvasPrototypeSessionPort;
  /** The host the renderer reaches now; it can change when the host restarts. */
  readonly serverUrl: () => string | undefined;
  readonly fetch: typeof fetch;
  /** The guest's preload: it forwards the page's bridge messages and nothing else. */
  readonly preloadPath: string;
  readonly platform: NodeJS.Platform;
}

/**
 * The ticket in a design page address on this host, or `undefined` for any
 * other address: another origin, another path, another query, or a ticket the
 * host would not have issued.
 */
export function designPageTicket(
  address: string,
  serverUrl: string | undefined,
): string | undefined {
  if (serverUrl === undefined) return undefined;
  try {
    const url = new URL(address);
    if (url.origin !== new URL(serverUrl).origin || url.pathname !== CANVAS_DESIGN_PAGE_PATH) {
      return undefined;
    }
    if (url.username !== "" || url.password !== "" || url.hash !== "") return undefined;
    const keys = [...url.searchParams.keys()];
    const ticket = url.searchParams.get("ticket");
    return keys.length === 1 && ticket !== null && TICKET.test(ticket) ? ticket : undefined;
  } catch {
    return undefined;
  }
}

function surfaceAddress(ticket: string): string {
  return `${CANVAS_PROTOTYPE_SCHEME}://page/?ticket=${ticket}`;
}

/** The ticket in an address under the surface's scheme, or `undefined`. */
function surfaceTicket(address: string): string | undefined {
  try {
    const url = new URL(address);
    if (url.protocol !== `${CANVAS_PROTOTYPE_SCHEME}:` || url.hostname !== "page") return undefined;
    if (url.pathname !== "/" || url.hash !== "") return undefined;
    const keys = [...url.searchParams.keys()];
    const ticket = url.searchParams.get("ticket");
    return keys.length === 1 && ticket !== null && TICKET.test(ticket) ? ticket : undefined;
  } catch {
    return undefined;
  }
}

/** The preferences every guest gets, whatever its element asked for. */
function containedWebPreferences(
  webPreferences: WebPreferences,
  preloadPath: string,
): WebPreferences {
  const kept = new Set<string>(["zoomFactor"]);
  for (const key of Object.keys(webPreferences)) {
    if (!kept.has(key)) Reflect.deleteProperty(webPreferences, key);
  }
  return Object.assign(webPreferences, {
    contextIsolation: true,
    disableBlinkFeatures: "",
    disablePopups: true,
    enableBlinkFeatures: "",
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    partition: CANVAS_PROTOTYPE_PARTITION,
    plugins: false,
    preload: preloadPath,
    sandbox: true,
    webSecurity: true,
  } satisfies WebPreferences);
}

export function createCanvasPrototypeSurface(options: CanvasPrototypeSurfaceOptions) {
  let ready = false;
  let serving = false;
  let preparing: Promise<CanvasPrototypeSurfacePreparation> | undefined;

  const answerPage = async (request: Request): Promise<Response> => {
    const refuse = (status: number) => new Response(null, { status });
    if (request.method !== "GET") return refuse(405);
    const ticket = surfaceTicket(request.url);
    const server = options.serverUrl();
    if (ticket === undefined) return refuse(404);
    if (server === undefined) return refuse(503);
    try {
      const page = await options.fetch(
        new URL(`${CANVAS_DESIGN_PAGE_PATH}?ticket=${ticket}`, server),
        { redirect: "error" },
      );
      const headers = new Headers();
      for (const name of PAGE_HEADERS) {
        const value = page.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      return new Response(await page.arrayBuffer(), { status: page.status, headers });
    } catch {
      return refuse(502);
    }
  };

  const configure = async (): Promise<CanvasPrototypeSurfacePreparation> => {
    try {
      await options.session.setProxy({
        proxyRules: NO_ROUTE_PROXY,
        proxyBypassRules: NO_ROUTE_BYPASS,
      });
      // The proxy rule is the whole boundary, so read back what the session
      // will do rather than trusting that it took: a public address and a
      // loopback one must both go to the dead proxy and neither direct.
      for (const probe of ["https://example.com/", "http://127.0.0.1:9/"]) {
        const route = await options.session.resolveProxy(probe);
        if (!/^SOCKS5 127\.0\.0\.1:1$/.test(route.trim())) {
          return {
            status: "unavailable",
            reason: "Octant could not close the prototype surface's network, so it does not run.",
          };
        }
      }
      options.session.refuseEverythingAsked();
      if (!serving) {
        options.session.serve(answerPage);
        serving = true;
      }
      ready = true;
      return { status: "ready" };
    } catch {
      return {
        status: "unavailable",
        reason: "Octant could not start the prototype surface, so it does not run.",
      };
    }
  };

  return Object.freeze({
    /**
     * Closes the surface's network and starts serving its one page. Settles
     * once; a failure is returned, not remembered, so the next try starts over.
     * Nothing attaches before this is ready.
     */
    prepare: (): Promise<CanvasPrototypeSurfacePreparation> => {
      preparing ??= configure().then((result) => {
        if (result.status !== "ready") preparing = undefined;
        return result;
      });
      return preparing;
    },

    /**
     * Lets a window attach a prototype surface, and nothing else: an element
     * naming another address, or arriving before the surface is ready, is
     * cancelled, and the attributes the renderer set are replaced.
     */
    admitWebview: (host: CanvasPrototypeHostPort): void => {
      host.onWillAttachWebview((event, webPreferences, params) => {
        const ticket = designPageTicket(params.src ?? "", options.serverUrl());
        if (!ready || ticket === undefined) {
          event.preventDefault();
          return;
        }
        containedWebPreferences(webPreferences, options.preloadPath);
        // Only the element's identity survives; every attribute that chooses
        // what the guest may do is replaced with its inert value.
        const instanceId = params.instanceId;
        for (const key of Object.keys(params)) Reflect.deleteProperty(params, key);
        Object.assign(params, {
          ...(instanceId === undefined ? {} : { instanceId }),
          allowpopups: "false",
          blinkfeatures: "",
          disableblinkfeatures: "",
          disablewebsecurity: "false",
          httpreferrer: "",
          nodeintegration: "false",
          nodeintegrationinsubframes: "false",
          partition: CANVAS_PROTOTYPE_PARTITION,
          plugins: "false",
          preload: "",
          src: surfaceAddress(ticket),
          useragent: "",
          webpreferences: "",
        });
      });
    },

    /**
     * Holds a guest that lives in the surface's session to the page it
     * opened with. Call it as the guest is created, before it loads.
     */
    guardGuest: (guest: CanvasPrototypeGuestPort): void => {
      if (!guest.inSurfaceSession()) return;
      guest.refuseNonProxiedUdp();
      guest.refuseNewWindows();
      // A page that moves itself, or is redirected, loads nothing: the first
      // load is the host's page and every later one is cancelled.
      guest.onNavigation((event) => event.preventDefault());
      // The reserved shortcut is read before the page sees the key, so a page
      // that swallows Tab cannot keep the keyboard.
      guest.onKeyInput((event, input) => {
        if (input.type !== "keyDown" || input.key !== "Escape" || input.alt || input.shift) return;
        const reserved =
          options.platform === "darwin"
            ? input.meta && !input.control
            : input.control && !input.meta;
        if (!reserved) return;
        event.preventDefault();
        guest.sendToHost(CANVAS_FRAME_FOCUS_ESCAPE_CHANNEL);
      });
    },
  });
}

export type CanvasPrototypeSurface = ReturnType<typeof createCanvasPrototypeSurface>;

/** The scheme must be known to Chromium before the app is ready. */
export function registerCanvasPrototypeScheme(
  protocol: Pick<Protocol, "registerSchemesAsPrivileged">,
): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: CANVAS_PROTOTYPE_SCHEME, privileges: { standard: true, secure: true } },
  ]);
}

export function canvasPrototypeSessionPort(session: Session): CanvasPrototypeSessionPort {
  return {
    setProxy: (config) => session.setProxy(config),
    resolveProxy: (url) => session.resolveProxy(url),
    refuseEverythingAsked: () => {
      session.setPermissionCheckHandler(() => false);
      session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      session.setDevicePermissionHandler(() => false);
      session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
      session.on("will-download", (event) => event.preventDefault());
    },
    serve: (handler) => session.protocol.handle(CANVAS_PROTOTYPE_SCHEME, handler),
  };
}

export function canvasPrototypeHostPort(contents: WebContents): CanvasPrototypeHostPort {
  return {
    onWillAttachWebview: (listener) => {
      contents.on("will-attach-webview", (event, webPreferences, params) =>
        listener(event, webPreferences, params),
      );
    },
  };
}

export function canvasPrototypeGuestPort(
  contents: WebContents,
  surfaceSession: Session,
): CanvasPrototypeGuestPort {
  return {
    inSurfaceSession: () => contents.session === surfaceSession,
    onNavigation: (listener) => {
      for (const name of ["will-navigate", "will-redirect", "will-frame-navigate"] as const) {
        contents.on(name, (event) => listener(event));
      }
    },
    onKeyInput: (listener) => {
      contents.on("before-input-event", (event, input) => listener(event, input));
    },
    refuseNewWindows: () => contents.setWindowOpenHandler(() => ({ action: "deny" })),
    refuseNonProxiedUdp: () => contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp"),
    sendToHost: (channel) => contents.hostWebContents?.send(channel),
  };
}
