import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  KeyboardInputEvent,
  MouseInputEvent,
  MouseWheelInputEvent,
  NativeImage,
  Rectangle,
  Session,
  WebContents,
} from "electron";
import { CANVAS_PROTOTYPE_NETWORK_RELAY_PREFIX } from "@octant/contracts/canvas-network";
import {
  CANVAS_NETWORK_MAX_REQUEST_BODY_BYTES,
  type CanvasNetworkResource,
} from "@octant/domain/canvas-network-policy";
import { canvasPrototypeRelayRequest } from "./canvasPrototypeNetwork";
import { CANVAS_PROTOTYPE_PRELOAD_FILENAME } from "./runtimePaths";

/**
 * The prototype host: the process a running Canvas prototype is drawn in on
 * the desktop.
 *
 * A prototype is agent-written script. A page in a session of the app's own
 * process could be kept off the network by a proxy that is never a proxy, but
 * not off the app's resolver: Electron has no resolver rule for one session,
 * the app's other sessions need to resolve names, and a `dns-prefetch` link or
 * a peer connection's server name made the app look up a name the page chose.
 * So the page runs here, in a process of its own started with the same no-route
 * switches as the agent's preview browser, which include a resolver rule that
 * answers every name with not-found. Nothing in this process needs a name.
 *
 * The page is drawn offscreen. This process sends its pixels to the desktop
 * app, which draws them in the window, and plays back the pointer and keys the
 * app forwards. It reaches nothing but the app: the page arrives in the `open`
 * message, already fetched by the app from the host, and is served once under
 * a private scheme.
 *
 * A page whose Canvas has "Allow network" on is given no route either. It may
 * ask one address of that private scheme for a fetch, and this process hands
 * the question to the app, which asks the host's proxy. Nothing here connects
 * anywhere, with the switch on or off (see `canvasPrototypeNetwork.ts`).
 */

/** The argument the desktop executable is started with to run as the prototype host. */
export const CANVAS_PROTOTYPE_HOST_SWITCH = "--octant-canvas-prototype-host";

/**
 * No route out, for everything in this process. The same switches as the
 * agent's preview browser (`CANVAS_PREVIEW_BROWSER_ARGS` in the server), which
 * measured nothing arriving with all four. Port 1 is never a proxy; the bypass
 * rule keeps loopback behind it; the resolver rule answers every name, IP
 * literals and `localhost` included, with not-found; and WebRTC sends no UDP
 * outside the proxy.
 */
export const CANVAS_PROTOTYPE_HOST_CHROMIUM_SWITCHES: ReadonlyArray<
  readonly [name: string, value: string]
> = [
  ["proxy-server", "socks5://127.0.0.1:1"],
  ["proxy-bypass-list", "<-loopback>"],
  ["host-resolver-rules", "MAP * ~NOTFOUND"],
  ["webrtc-ip-handling-policy", "disable_non_proxied_udp"],
];

const NO_ROUTE_PROXY = "socks5://127.0.0.1:1";
const NO_ROUTE_BYPASS = "<-loopback>";

/** The scheme the page is served under, to this process's one session. */
export const CANVAS_PROTOTYPE_SCHEME = "octant-prototype";
/** In memory: not prefixed `persist:`, so nothing a page does outlives the process. */
const CANVAS_PROTOTYPE_PARTITION = "octant-canvas-prototype";
/**
 * What the page's preload sends its bridge messages on. It repeats the string
 * in `canvasPrototypePreload.ts`, which a test holds equal.
 */
export const CANVAS_PROTOTYPE_PAGE_BRIDGE_CHANNEL = "octant-canvas-prototype-bridge";

const SURFACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A prototype paints at most this often; each paint crosses two processes. */
const FRAME_RATE = 30;
/**
 * The pixel bytes one prototype may send the app in a second. A frame is raw
 * RGBA and crosses two processes, and the tallest page at twice its pixels is
 * about 370 MB, so a page that repaints all of itself would otherwise flood
 * both. This allows a full phone-sized repaint (5 MB at 2x) about 25 times a
 * second; a frame larger than what is left is sent, and the next one waits
 * until the budget is paid back.
 */
export const MAX_FRAME_BYTES_PER_SECOND = 128 * 1024 * 1024;
/**
 * The bridge messages one page may pass on in a second: the renderer stops a
 * page past 250, so one more still shows it the flood, and the rest of that
 * second is dropped here rather than crossing two processes.
 */
export const MAX_BRIDGE_MESSAGES_PER_SECOND = 251;
/**
 * The questions one page may have waiting on the app at a time. The host's
 * proxy fetches 4 at once for a Canvas and refuses the rest, so twice that is
 * room for a page's own queue and no more is carried across two processes.
 */
export const MAX_RELAYS_PER_PAGE = 8;

export type CanvasPrototypeModifier = "shift" | "control" | "alt" | "meta";
export type CanvasPrototypeEditCommand = "copy" | "cut" | "paste" | "selectAll" | "undo" | "redo";
const EDIT_COMMANDS: ReadonlySet<string> = new Set<CanvasPrototypeEditCommand>([
  "copy",
  "cut",
  "paste",
  "selectAll",
  "undo",
  "redo",
]);

/** What the app forwards for a page: a person's pointer, wheel, keys, focus, and edit commands. */
export type CanvasPrototypeInput =
  | {
      readonly type: "mouseDown" | "mouseUp" | "mouseMove" | "mouseEnter" | "mouseLeave";
      readonly x: number;
      readonly y: number;
      readonly button: "left" | "middle" | "right";
      readonly clickCount: number;
      readonly modifiers: ReadonlyArray<CanvasPrototypeModifier>;
    }
  | {
      readonly type: "mouseWheel";
      readonly x: number;
      readonly y: number;
      readonly deltaX: number;
      readonly deltaY: number;
      readonly modifiers: ReadonlyArray<CanvasPrototypeModifier>;
    }
  | {
      readonly type: "keyDown" | "keyUp" | "char";
      readonly keyCode: string;
      readonly modifiers: ReadonlyArray<CanvasPrototypeModifier>;
    }
  | { readonly type: "focus" | "blur" }
  | { readonly type: "edit"; readonly command: CanvasPrototypeEditCommand };

/** The design page as the app fetched it from the host. */
export interface CanvasPrototypeHostPage {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

/** What the app brings back for a page's question: the host's answer, or its own refusal. */
export interface CanvasPrototypeRelayAnswer {
  readonly status: number;
  readonly contentType: string;
  readonly body: Uint8Array;
}

export type CanvasPrototypeHostCommand =
  | {
      readonly kind: "open";
      readonly surfaceId: string;
      readonly page: CanvasPrototypeHostPage;
      readonly width: number;
      readonly height: number;
      readonly scaleFactor: number;
      /**
       * The app holds a network token for this page, so the page's questions
       * are handed to it. The token itself never comes here.
       */
      readonly network?: true;
    }
  | {
      readonly kind: "relayed";
      readonly surfaceId: string;
      readonly requestId: number;
      readonly answer: CanvasPrototypeRelayAnswer;
    }
  | {
      readonly kind: "resize";
      readonly surfaceId: string;
      readonly width: number;
      readonly height: number;
    }
  | { readonly kind: "input"; readonly surfaceId: string; readonly input: CanvasPrototypeInput }
  /** The window drew the last frame it was sent, so the next may go. */
  | { readonly kind: "drawn"; readonly surfaceId: string }
  | { readonly kind: "close"; readonly surfaceId: string };

/** A rectangle of a page, in device pixels. */
export interface CanvasPrototypeRectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * One paint of a page: the whole frame's size, the rectangle that changed, and
 * a way to read any rectangle of this paint as RGBA. Reading is the costly
 * part, so it happens only for what is sent.
 */
export interface CanvasPrototypePaint {
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly dirty: CanvasPrototypeRectangle;
  readonly read: (rectangle: CanvasPrototypeRectangle) => Uint8Array;
}

/** A changed rectangle of a page, in device pixels, as RGBA. */
export interface CanvasPrototypeFrame {
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

export type CanvasPrototypeHostEvent =
  | { readonly kind: "ready" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | ({ readonly kind: "frame"; readonly surfaceId: string } & CanvasPrototypeFrame)
  | { readonly kind: "bridge"; readonly surfaceId: string; readonly payload: unknown }
  | { readonly kind: "cursor"; readonly surfaceId: string; readonly cursor: string }
  /** A page with a network asks the app to have the host fetch one address. */
  | {
      readonly kind: "relay";
      readonly surfaceId: string;
      readonly requestId: number;
      /** Whether a script, an image element, or a font face is asking. */
      readonly resource: CanvasNetworkResource;
      readonly target: string;
      /** A script's JSON body, already held to the host's bound; it makes the question a `POST`. */
      readonly body?: Uint8Array;
    }
  | { readonly kind: "gone"; readonly surfaceId: string };

export interface CanvasPrototypeCancellable {
  readonly preventDefault: () => void;
}

export interface CanvasPrototypeHostSessionPort {
  readonly setProxy: (config: {
    readonly proxyRules: string;
    readonly proxyBypassRules: string;
  }) => Promise<void>;
  readonly resolveProxy: (url: string) => Promise<string>;
  /** Resolves a name the way a page's request would; rejects when it does not resolve. */
  readonly resolveHost: (name: string) => Promise<unknown>;
  /** Refuses every permission, device, screen-capture, and download request. */
  readonly refuseEverythingAsked: () => void;
  readonly serve: (handler: (request: Request) => Promise<Response>) => void;
}

/** One page drawn offscreen. */
export interface CanvasPrototypeHostPagePort {
  readonly onPaint: (listener: (paint: CanvasPrototypePaint) => void) => void;
  readonly onCursor: (listener: (cursor: string) => void) => void;
  readonly onBridge: (listener: (payload: unknown) => void) => void;
  readonly onGone: (listener: () => void) => void;
  readonly onNavigation: (listener: (event: CanvasPrototypeCancellable) => void) => void;
  readonly refuseNewWindows: () => void;
  readonly refuseNonProxiedUdp: () => void;
  /** Lets the page be closed whatever its `beforeunload` asks. */
  readonly refuseUnloadPrompts: () => void;
  readonly load: (url: string) => void;
  readonly input: (input: CanvasPrototypeInput) => void;
  readonly setSize: (width: number, height: number) => void;
  readonly close: () => void;
}

export interface CanvasPrototypeHostOptions {
  readonly session: CanvasPrototypeHostSessionPort;
  readonly createPage: (input: {
    readonly width: number;
    readonly height: number;
    readonly scaleFactor: number;
  }) => CanvasPrototypeHostPagePort;
  readonly send: (event: CanvasPrototypeHostEvent) => void;
}

/** The smallest rectangle holding both, or the one that exists. */
function union(
  first: CanvasPrototypeRectangle | undefined,
  second: CanvasPrototypeRectangle,
): CanvasPrototypeRectangle {
  if (first === undefined) return second;
  const x = Math.min(first.x, second.x);
  const y = Math.min(first.y, second.y);
  return {
    x,
    y,
    width: Math.max(first.x + first.width, second.x + second.width) - x,
    height: Math.max(first.y + first.height, second.y + second.height) - y,
  };
}

/** A rectangle cut to the frame, whole pixels only. */
function within(
  rectangle: CanvasPrototypeRectangle,
  frameWidth: number,
  frameHeight: number,
): CanvasPrototypeRectangle {
  const x = Math.max(0, Math.min(frameWidth, Math.floor(rectangle.x)));
  const y = Math.max(0, Math.min(frameHeight, Math.floor(rectangle.y)));
  const right = Math.max(x, Math.min(frameWidth, Math.ceil(rectangle.x + rectangle.width)));
  const bottom = Math.max(y, Math.min(frameHeight, Math.ceil(rectangle.y + rectangle.height)));
  return { x, y, width: right - x, height: bottom - y };
}

/**
 * Sends a page's paints to the app at the pace the app draws them: one frame
 * at a time until the window says it drew it, within a byte budget per second.
 * Paints meanwhile are folded into one changed rectangle of the latest paint,
 * so a page that paints faster than the window draws costs no more.
 */
function paceFrames(
  surfaceId: string,
  send: (event: CanvasPrototypeHostEvent) => void,
): {
  readonly painted: (paint: CanvasPrototypePaint) => void;
  readonly drawn: () => void;
  readonly stop: () => void;
} {
  let latest: CanvasPrototypePaint | undefined;
  let changed: CanvasPrototypeRectangle | undefined;
  let awaitingDrawn = false;
  let budget = MAX_FRAME_BYTES_PER_SECOND;
  let budgetAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const flush = () => {
    if (stopped || awaitingDrawn || timer !== undefined) return;
    if (latest === undefined || changed === undefined) return;
    const now = Date.now();
    budget = Math.min(
      MAX_FRAME_BYTES_PER_SECOND,
      budget + ((now - budgetAt) * MAX_FRAME_BYTES_PER_SECOND) / 1000,
    );
    budgetAt = now;
    if (budget < 0) {
      timer = setTimeout(
        () => {
          timer = undefined;
          flush();
        },
        Math.ceil((-budget * 1000) / MAX_FRAME_BYTES_PER_SECOND),
      );
      return;
    }
    const { frameWidth, frameHeight } = latest;
    const rectangle = within(changed, frameWidth, frameHeight);
    changed = undefined;
    if (rectangle.width === 0 || rectangle.height === 0) return;
    const pixels = latest.read(rectangle);
    budget -= rectangle.width * rectangle.height * 4;
    awaitingDrawn = true;
    send({ kind: "frame", surfaceId, frameWidth, frameHeight, ...rectangle, pixels });
  };

  return {
    painted: (paint) => {
      // A frame of a new size starts the window's canvas over: all of it is new.
      const resized =
        latest !== undefined &&
        (latest.frameWidth !== paint.frameWidth || latest.frameHeight !== paint.frameHeight);
      latest = paint;
      changed = resized
        ? { x: 0, y: 0, width: paint.frameWidth, height: paint.frameHeight }
        : union(changed, paint.dirty);
      flush();
    },
    drawn: () => {
      awaitingDrawn = false;
      flush();
    },
    stop: () => {
      stopped = true;
      latest = undefined;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/** Passes on at most so many of a page's bridge messages in each second. */
function capBridgeMessages(forward: (payload: unknown) => void): (payload: unknown) => void {
  let windowStart = 0;
  let count = 0;
  return (payload) => {
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      count = 0;
    }
    count += 1;
    if (count <= MAX_BRIDGE_MESSAGES_PER_SECOND) forward(payload);
  };
}

/**
 * The input to play back on a page, or `undefined`. The app checks input
 * before sending it, and this checks the edit command again because it names a
 * method the host calls.
 */
function admittedInput(input: CanvasPrototypeInput): CanvasPrototypeInput | undefined {
  if (input.type === "edit" && !EDIT_COMMANDS.has(input.command)) return undefined;
  return input;
}

function pageAddress(surfaceId: string): string {
  return `${CANVAS_PROTOTYPE_SCHEME}://page/${surfaceId}`;
}

/** The surface in an address under the page scheme, or `undefined`. */
function addressedSurface(address: string): string | undefined {
  try {
    const url = new URL(address);
    if (url.protocol !== `${CANVAS_PROTOTYPE_SCHEME}:` || url.hostname !== "page") return undefined;
    if (url.search !== "" || url.hash !== "") return undefined;
    const surfaceId = url.pathname.slice(1);
    return SURFACE_ID.test(surfaceId) ? surfaceId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What every answer to a page's question carries, a refusal included: the
 * headers the host's proxy route sets. The page's origin is opaque, so it
 * reads the answer only with the first; the rest keep fetched markup from
 * ever being a document.
 */
const RELAY_ANSWER_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "cache-control": "no-store",
  "content-disposition": "attachment",
  "content-security-policy": "sandbox; default-src 'none'",
  "x-content-type-options": "nosniff",
};

function relayRefusal(status: number, reason: string): Response {
  return new Response(JSON.stringify({ refused: reason }), {
    status,
    headers: { ...RELAY_ANSWER_HEADERS, "content-type": "application/json" },
  });
}

const RELAY_REFUSAL_STATUS = {
  "not-the-relay": 404,
  "method-not-allowed": 405,
  "request-type-not-allowed": 415,
  "invalid-request": 400,
  "no-network": 403,
} as const;

/**
 * A page's JSON body, or `undefined` once it passes the host's bound. Read
 * here so a body the host would refuse is never carried across two processes.
 */
async function relayBody(request: Request): Promise<Uint8Array | undefined> {
  if (
    Number(request.headers.get("content-length") ?? "0") > CANVAS_NETWORK_MAX_REQUEST_BODY_BYTES
  ) {
    return undefined;
  }
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > CANVAS_NETWORK_MAX_REQUEST_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** The app's answer as the page's response; one a response cannot carry is the far side's fault. */
function relayedResponse(answer: CanvasPrototypeRelayAnswer): Response {
  if (!Number.isInteger(answer.status) || answer.status < 200 || answer.status > 599) {
    return relayRefusal(502, "unreachable");
  }
  const bodyless = answer.status === 204 || answer.status === 205 || answer.status === 304;
  return new Response(bodyless ? null : answer.body.slice().buffer, {
    status: answer.status,
    headers: { ...RELAY_ANSWER_HEADERS, "content-type": answer.contentType },
  });
}

export function createCanvasPrototypeHost(options: CanvasPrototypeHostOptions) {
  const pages = new Map<string, CanvasPrototypeHostPagePort>();
  const pacers = new Map<string, ReturnType<typeof paceFrames>>();
  // A page is served once, to the load this process starts for it.
  const unserved = new Map<string, CanvasPrototypeHostPage>();

  const answerPage = async (request: Request): Promise<Response> => {
    const surfaceId = addressedSurface(request.url);
    const page = surfaceId === undefined ? undefined : unserved.get(surfaceId);
    if (request.method !== "GET" || surfaceId === undefined || page === undefined) {
      return new Response(null, { status: 404 });
    }
    unserved.delete(surfaceId);
    return new Response(page.body.slice().buffer, { status: page.status, headers: page.headers });
  };

  // The surfaces the app said have a network, and what their pages wait on.
  const networked = new Set<string>();
  const relays = new Map<
    number,
    { readonly surfaceId: string; readonly settle: (response: Response) => void }
  >();
  let lastRelay = 0;

  /**
   * A page's question. Only the admitted request shapes are handed to the
   * app, and only the surface, which of the three paths, the address asked
   * for, and a script's JSON body: no header of the page's goes with it. The
   * app decides where that goes, and the host decides whether it is fetched.
   */
  const answerRelay = async (request: Request): Promise<Response> => {
    const decision = canvasPrototypeRelayRequest(
      {
        url: request.url,
        method: request.method,
        contentType: request.headers.get("content-type"),
      },
      (surfaceId) => networked.has(surfaceId),
    );
    if (decision.status === "refused") {
      return relayRefusal(RELAY_REFUSAL_STATUS[decision.reason], decision.reason);
    }
    if (decision.status === "preflight") {
      return new Response(null, {
        status: 204,
        headers: {
          ...RELAY_ANSWER_HEADERS,
          "access-control-allow-methods": "GET, POST",
          "access-control-allow-headers": "content-type",
        },
      });
    }
    let waiting = 0;
    for (const relay of relays.values()) if (relay.surfaceId === decision.surfaceId) waiting += 1;
    if (waiting >= MAX_RELAYS_PER_PAGE) return relayRefusal(429, "too-many-requests");
    lastRelay += 1;
    const requestId = lastRelay;
    // The place is taken before the body is read, so a page cannot open more
    // questions than its bound by sending slow bodies.
    const answered = new Promise<Response>((settle) => {
      relays.set(requestId, { surfaceId: decision.surfaceId, settle });
    });
    let body: Uint8Array | undefined;
    if (decision.method === "POST") {
      body = await relayBody(request).catch(() => undefined);
      if (body === undefined) {
        relays.delete(requestId);
        return relayRefusal(413, "request-too-large");
      }
      // The page closed while its body arrived: it was already answered.
      if (!relays.has(requestId)) return answered;
    }
    options.send({
      kind: "relay",
      surfaceId: decision.surfaceId,
      requestId,
      resource: decision.resource,
      target: decision.target,
      ...(body === undefined ? {} : { body }),
    });
    return answered;
  };

  const answer = (request: Request): Promise<Response> =>
    request.url.startsWith(CANVAS_PROTOTYPE_NETWORK_RELAY_PREFIX)
      ? answerRelay(request)
      : answerPage(request);

  const close = (surfaceId: string) => {
    networked.delete(surfaceId);
    for (const [requestId, relay] of relays) {
      if (relay.surfaceId !== surfaceId) continue;
      relays.delete(requestId);
      relay.settle(relayRefusal(503, "page-closed"));
    }
    unserved.delete(surfaceId);
    pacers.get(surfaceId)?.stop();
    pacers.delete(surfaceId);
    pages.get(surfaceId)?.close();
    pages.delete(surfaceId);
  };

  const open = (command: Extract<CanvasPrototypeHostCommand, { kind: "open" }>) => {
    if (!SURFACE_ID.test(command.surfaceId) || pages.has(command.surfaceId)) return;
    const { surfaceId } = command;
    const page = options.createPage({
      width: command.width,
      height: command.height,
      scaleFactor: command.scaleFactor,
    });
    pages.set(surfaceId, page);
    const pacer = paceFrames(surfaceId, options.send);
    pacers.set(surfaceId, pacer);
    page.refuseNonProxiedUdp();
    page.refuseNewWindows();
    page.refuseUnloadPrompts();
    // The page this process loads is the only one: a page that moves itself,
    // or is redirected, loads nothing.
    page.onNavigation((event) => event.preventDefault());
    page.onPaint(pacer.painted);
    page.onCursor((cursor) => options.send({ kind: "cursor", surfaceId, cursor }));
    page.onBridge(
      capBridgeMessages((payload) => options.send({ kind: "bridge", surfaceId, payload })),
    );
    page.onGone(() => {
      close(surfaceId);
      options.send({ kind: "gone", surfaceId });
    });
    unserved.set(surfaceId, command.page);
    if (command.network === true) networked.add(surfaceId);
    page.load(pageAddress(surfaceId));
  };

  return Object.freeze({
    /**
     * Closes the session's network and reads back that it is closed: a public
     * and a loopback address go to the dead proxy, and `localhost` does not
     * resolve, which it does under any resolver but the not-found rule. Only
     * then does it serve pages and say it is ready.
     */
    start: async (): Promise<void> => {
      const unavailable = (reason: string) => options.send({ kind: "unavailable", reason });
      try {
        await options.session.setProxy({
          proxyRules: NO_ROUTE_PROXY,
          proxyBypassRules: NO_ROUTE_BYPASS,
        });
        for (const probe of ["https://example.com/", "http://127.0.0.1:9/"]) {
          const route = await options.session.resolveProxy(probe);
          if (!/^SOCKS5 127\.0\.0\.1:1$/.test(route.trim())) {
            unavailable(
              "Octant could not close the prototype surface's network, so it does not run.",
            );
            return;
          }
        }
        const resolves = await options.session.resolveHost("localhost").then(
          () => true,
          () => false,
        );
        if (resolves) {
          unavailable(
            "Octant could not stop the prototype surface looking up names, so it does not run.",
          );
          return;
        }
        options.session.refuseEverythingAsked();
        options.session.serve(answer);
        options.send({ kind: "ready" });
      } catch {
        unavailable("Octant could not start the prototype surface, so it does not run.");
      }
    },

    receive: (command: CanvasPrototypeHostCommand): void => {
      switch (command.kind) {
        case "open":
          open(command);
          return;
        case "resize":
          pages.get(command.surfaceId)?.setSize(command.width, command.height);
          return;
        case "input": {
          const input = admittedInput(command.input);
          if (input !== undefined) pages.get(command.surfaceId)?.input(input);
          return;
        }
        case "drawn":
          pacers.get(command.surfaceId)?.drawn();
          return;
        case "relayed": {
          // An answer goes to the question it names, of the surface it names.
          const relay = relays.get(command.requestId);
          if (relay === undefined || relay.surfaceId !== command.surfaceId) return;
          relays.delete(command.requestId);
          relay.settle(relayedResponse(command.answer));
          return;
        }
        case "close":
          close(command.surfaceId);
          return;
      }
    },
  });
}

/** BGRA, as Chromium paints, to the RGBA a canvas takes. */
function rgbaFrom(bitmap: Buffer): Uint8Array {
  const pixels = new Uint8Array(bitmap.length);
  for (let index = 0; index + 3 < bitmap.length; index += 4) {
    pixels[index] = bitmap[index + 2] ?? 0;
    pixels[index + 1] = bitmap[index + 1] ?? 0;
    pixels[index + 2] = bitmap[index] ?? 0;
    pixels[index + 3] = bitmap[index + 3] ?? 0;
  }
  return pixels;
}

function paintOf(dirty: Rectangle, image: NativeImage): CanvasPrototypePaint {
  const frame = image.getSize();
  return {
    frameWidth: frame.width,
    frameHeight: frame.height,
    dirty,
    read: (rectangle) => rgbaFrom(image.crop(rectangle).toBitmap()),
  };
}

/** Runs one of the edit commands a page takes, by name, and nothing else. */
function runEditCommand(contents: WebContents, command: CanvasPrototypeEditCommand): void {
  switch (command) {
    case "copy":
      contents.copy();
      return;
    case "cut":
      contents.cut();
      return;
    case "paste":
      contents.paste();
      return;
    case "selectAll":
      contents.selectAll();
      return;
    case "undo":
      contents.undo();
      return;
    case "redo":
      contents.redo();
      return;
  }
}

type ElectronInput = MouseInputEvent | MouseWheelInputEvent | KeyboardInputEvent;

/** The event Chromium takes for a forwarded pointer, wheel, or key; focus and edits are not events. */
function electronInput(input: CanvasPrototypeInput): ElectronInput | undefined {
  switch (input.type) {
    case "focus":
    case "blur":
    case "edit":
      return undefined;
    case "mouseWheel":
      return {
        type: "mouseWheel",
        x: input.x,
        y: input.y,
        // A page scrolls down for a positive DOM delta; Chromium's wheel
        // event counts the other way.
        deltaX: -input.deltaX,
        deltaY: -input.deltaY,
        canScroll: true,
        modifiers: [...input.modifiers],
      };
    case "keyDown":
    case "keyUp":
    case "char":
      return { type: input.type, keyCode: input.keyCode, modifiers: [...input.modifiers] };
    default:
      return {
        type: input.type,
        x: input.x,
        y: input.y,
        button: input.button,
        clickCount: input.clickCount,
        modifiers: [...input.modifiers],
      };
  }
}

function sessionPort(session: Session): CanvasPrototypeHostSessionPort {
  return {
    setProxy: (config) => session.setProxy(config),
    resolveProxy: (url) => session.resolveProxy(url),
    resolveHost: (name) => session.resolveHost(name),
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

/**
 * Runs this process as the prototype host. The desktop app starts it with an
 * IPC channel; when that channel closes, the app is gone and so is this.
 */
export async function runCanvasPrototypeHost(): Promise<void> {
  const { app, BrowserWindow, ipcMain, protocol, session } = await import("electron");
  for (const [name, value] of CANVAS_PROTOTYPE_HOST_CHROMIUM_SWITCHES) {
    app.commandLine.appendSwitch(name, value);
  }
  // No Dock icon, menu, or focus of its own: this process only paints.
  if (process.platform === "darwin") app.setActivationPolicy("prohibited");
  const userData = mkdtempSync(join(tmpdir(), "octant-prototype-host-"));
  app.setPath("userData", userData);
  app.setPath("sessionData", userData);
  protocol.registerSchemesAsPrivileged([
    {
      scheme: CANVAS_PROTOTYPE_SCHEME,
      // A page whose Canvas has the network on asks an address of this scheme
      // with `fetch`, from an opaque origin; without these two Chromium
      // refuses a fetch of a scheme it does not know. They open no route: the
      // one thing that answers the scheme is this process's handler.
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
  const send = (event: CanvasPrototypeHostEvent) => {
    if (process.connected) process.send?.(event);
  };
  const removeData = () => rmSync(userData, { recursive: true, force: true });
  app.on("will-quit", removeData);
  // Started without the app's channel, it has nobody to paint for.
  if (process.send === undefined) {
    app.quit();
    return;
  }
  // When the app is gone, or asks this to stop, this leaves at once: a quit
  // could wait on a page's `beforeunload`, and a page has no say here.
  const leave = () => {
    removeData();
    app.exit(0);
  };
  process.on("disconnect", leave);
  process.on("SIGTERM", leave);
  // A closed page is not the end of the host: it stays until the app is gone.
  app.on("window-all-closed", () => undefined);

  await app.whenReady();
  const pageSession = session.fromPartition(CANVAS_PROTOTYPE_PARTITION);
  const preload = resolve(
    dirname(fileURLToPath(import.meta.url)),
    CANVAS_PROTOTYPE_PRELOAD_FILENAME,
  );
  const bridges = new Map<number, (payload: unknown) => void>();
  ipcMain.on(CANVAS_PROTOTYPE_PAGE_BRIDGE_CHANNEL, (event, payload: unknown) => {
    bridges.get(event.sender.id)?.(payload);
  });

  const host = createCanvasPrototypeHost({
    session: sessionPort(pageSession),
    send,
    createPage: ({ width, height, scaleFactor }) => {
      const window = new BrowserWindow({
        show: false,
        width,
        height,
        useContentSize: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          offscreen: { deviceScaleFactor: scaleFactor },
          plugins: false,
          preload,
          sandbox: true,
          session: pageSession,
          webSecurity: true,
          webviewTag: false,
        },
      });
      const contents = window.webContents;
      const id = contents.id;
      contents.setFrameRate(FRAME_RATE);
      return {
        onPaint: (listener) =>
          contents.on("paint", (_event, dirty, image) => listener(paintOf(dirty, image))),
        onCursor: (listener) => contents.on("cursor-changed", (_event, type) => listener(type)),
        onBridge: (listener) => {
          bridges.set(id, listener);
        },
        onGone: (listener) => {
          contents.on("render-process-gone", () => listener());
          contents.on("unresponsive", () => listener());
        },
        onNavigation: (listener) => {
          // The load this process starts is not one of these; every
          // navigation the page or a redirect starts is.
          contents.on("will-navigate", (event) => listener(event));
          contents.on("will-redirect", (event) => listener(event));
          contents.on("will-frame-navigate", (event) => listener(event));
        },
        refuseNewWindows: () => contents.setWindowOpenHandler(() => ({ action: "deny" })),
        refuseNonProxiedUdp: () => contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp"),
        refuseUnloadPrompts: () =>
          contents.on("will-prevent-unload", (event) => event.preventDefault()),
        load: (url) => {
          void contents.loadURL(url).catch(() => undefined);
        },
        input: (input) => {
          if (window.isDestroyed()) return;
          if (input.type === "focus") window.focusOnWebView();
          else if (input.type === "blur") window.blurWebView();
          else if (input.type === "edit") runEditCommand(contents, input.command);
          else {
            const event = electronInput(input);
            if (event !== undefined) contents.sendInputEvent(event);
          }
        },
        setSize: (nextWidth, nextHeight) => {
          if (!window.isDestroyed()) window.setContentSize(nextWidth, nextHeight);
        },
        close: () => {
          bridges.delete(id);
          if (!window.isDestroyed()) window.destroy();
        },
      };
    },
  });
  process.on("message", (command: CanvasPrototypeHostCommand) => host.receive(command));
  await host.start();
}
