import { spawn } from "node:child_process";
import { createNativeHelperShutdown, type NativeHelperStopOutcome } from "./nativeHelperShutdown";
import { CANVAS_DESIGN_PAGE_PATH } from "@octant/contracts/canvas";
import {
  CANVAS_NETWORK_TOKEN_HEADER,
  CANVAS_PROTOTYPE_SURFACE_HEADER,
} from "@octant/contracts/canvas-network";
import { canvasNetworkRelayAddress } from "./canvasPrototypeNetwork";
import type {
  CanvasPrototypeEditCommand,
  CanvasPrototypeFrame,
  CanvasPrototypeHostCommand,
  CanvasPrototypeHostEvent,
  CanvasPrototypeInput,
  CanvasPrototypeModifier,
  CanvasPrototypeRelayAnswer,
} from "./canvasPrototypeHost";

/**
 * Where a running Canvas prototype runs on the desktop: the prototype host, a
 * process of its own with no route out and no resolver (see
 * `canvasPrototypeHost.ts`).
 *
 * A prototype is agent-written script. A page policy does not cover WebRTC, and
 * a session of the app's own process could be kept off the network but not off
 * the app's resolver, so a `dns-prefetch` link or a peer connection's server
 * name made the app look up a name the page chose. The host process is started
 * with a resolver rule that answers nothing, so the page has no name to look up
 * either.
 *
 * This side, in the app's main process, decides what the host shows:
 *
 * - a window opens a prototype only for a ticketed design page on this host.
 *   The main process fetches that page from the host itself and hands it to the
 *   prototype host, so the page needs no route to the host's address;
 * - the host draws the page offscreen and sends its pixels here, and this
 *   forwards them, with the page's bridge messages and cursor, to the window
 *   that opened it and to no other;
 * - the window forwards a person's pointer and keys, which are checked here.
 *   The reserved shortcut that leaves a prototype is never forwarded, so a page
 *   cannot hold the keyboard;
 * - when the host answers the page request with a network token (the Canvas's
 *   "Allow network" switch is on, and this process proved itself with the
 *   desktop bridge secret), the token stays here. The prototype host is told
 *   only that the page has a network; each address its page asks for is
 *   fetched here from the host's proxy path under that token, and from
 *   nowhere else.
 */

export type CanvasPrototypeSurfacePreparation =
  | { readonly status: "ready" }
  | { readonly status: "unavailable"; readonly reason: string };

export type CanvasPrototypeOpenResult =
  | { readonly status: "open" }
  | { readonly status: "refused"; readonly reason: string };

/** What a window hears about a prototype it opened. */
export type CanvasPrototypeSurfaceEvent =
  | ({ readonly kind: "frame"; readonly surfaceId: string } & CanvasPrototypeFrame)
  | { readonly kind: "bridge"; readonly surfaceId: string; readonly payload: unknown }
  | { readonly kind: "cursor"; readonly surfaceId: string; readonly cursor: string }
  | { readonly kind: "gone"; readonly surfaceId: string };

/** A window that opens prototypes, by the id of its contents. */
export interface CanvasPrototypeOwner {
  readonly id: number;
  readonly send: (event: CanvasPrototypeSurfaceEvent) => void;
}

/**
 * The contents of a window that opens prototypes, as far as its going away
 * goes. A reload or a new page, a renderer that exits, and destroyed contents
 * each leave its prototypes without the page that opened them.
 */
export interface CanvasPrototypeOwnerContentsPort {
  readonly id: number;
  readonly onNavigation: (
    listener: (navigation: { readonly isMainFrame: boolean; readonly isInPlace: boolean }) => void,
  ) => void;
  readonly onRendererGone: (listener: () => void) => void;
  readonly onDestroyed: (listener: () => void) => void;
}

/** The running prototype host process. */
export interface CanvasPrototypeHostConnection {
  readonly exited: Promise<void>;
  readonly send: (command: CanvasPrototypeHostCommand) => void;
  readonly onEvent: (listener: (event: CanvasPrototypeHostEvent) => void) => void;
  readonly onExit: (listener: () => void) => void;
  readonly stop: () => Promise<NativeHelperStopOutcome>;
}

export interface CanvasPrototypeSurfaceOptions {
  /** Starts the prototype host process. */
  readonly launchHost: () => CanvasPrototypeHostConnection;
  /** The host the renderer reaches now; it can change when the host restarts. */
  readonly serverUrl: () => string | undefined;
  readonly fetch: typeof fetch;
  /**
   * What proves this process to the host as its own desktop: the bridge
   * secret every brokered desktop route takes. Sent with the page request to
   * the loopback host only. Absent, no page is given a network.
   */
  readonly brokerHeaders?: () => Readonly<Record<string, string>>;
  readonly platform: NodeJS.Platform;
  /** How long the prototype host has to read back that it is closed. */
  readonly readyTimeoutMs?: number;
}

const TICKET = /^[A-Za-z0-9_-]{43}$/;
const NETWORK_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** The longest address a page's question may carry here; the host refuses one a quarter as long. */
const MAX_RELAY_TARGET_LENGTH = 8_192;
const RELAY_NOT_ALLOWED: CanvasPrototypeRelayAnswer = {
  status: 403,
  contentType: "application/json",
  body: new TextEncoder().encode('{"refused":"no-network"}'),
};
const RELAY_UNREACHABLE: CanvasPrototypeRelayAnswer = {
  status: 502,
  contentType: "application/json",
  body: new TextEncoder().encode('{"refused":"unreachable"}'),
};
const SURFACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** What of the host's answer the page keeps: the page and the policy it came with. */
const PAGE_HEADERS = [
  "content-type",
  "content-security-policy",
  "referrer-policy",
  "cache-control",
];
/** The widest viewport a design has (a slide) and the tallest a running page may report. */
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 12_000;
const MAX_SCALE_FACTOR = 2;
const MAX_COORDINATE = 100_000;
const MAX_WHEEL_DELTA = 10_000;
const MAX_KEY_CODE_LENGTH = 32;
const MODIFIERS: ReadonlyMap<string, CanvasPrototypeModifier> = new Map(
  (["shift", "control", "alt", "meta"] as const).map((name) => [name, name]),
);
const EDIT_COMMANDS: ReadonlyMap<string, CanvasPrototypeEditCommand> = new Map(
  (["copy", "cut", "paste", "selectAll", "undo", "redo"] as const).map((name) => [name, name]),
);
const POINTER_TYPES = new Map(
  (["mouseDown", "mouseUp", "mouseMove", "mouseEnter", "mouseLeave"] as const).map((name) => [
    name as string,
    name,
  ]),
);
const BUTTONS = new Map(
  (["left", "middle", "right"] as const).map((name) => [name as string, name]),
);
const DEFAULT_READY_TIMEOUT_MS = 20_000;
const HOST_QUIT_GRACE_MS = 2_000;
const NOT_STARTED = "Octant could not start the prototype surface, so it does not run.";

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

/** Whether an address is the loopback host a desktop attaches to, by its literal address. */
function isLoopbackHost(address: string): boolean {
  try {
    const url = new URL(address);
    return url.protocol === "http:" && url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteIn(value: unknown, low: number, high: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
}

function wholeIn(value: unknown, low: number, high: number): value is number {
  return finiteIn(value, low, high) && Number.isInteger(value);
}

function decodeModifiers(value: unknown): ReadonlyArray<CanvasPrototypeModifier> | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MODIFIERS.size) return undefined;
  const modifiers: Array<CanvasPrototypeModifier> = [];
  for (const entry of value) {
    const modifier = typeof entry === "string" ? MODIFIERS.get(entry) : undefined;
    if (modifier === undefined) return undefined;
    modifiers.push(modifier);
  }
  return modifiers;
}

/**
 * Whether a key is the reserved shortcut that returns the keyboard to Octant:
 * Command-Escape on macOS, Control-Escape elsewhere. The window keeps it; the
 * page never sees it.
 */
export function isReservedPrototypeShortcut(
  input: {
    readonly key: string;
    readonly meta: boolean;
    readonly control: boolean;
    readonly alt: boolean;
    readonly shift: boolean;
  },
  platform: NodeJS.Platform | string,
): boolean {
  if (input.key !== "Escape" || input.alt || input.shift) return false;
  return platform === "darwin" ? input.meta && !input.control : input.control && !input.meta;
}

/**
 * A pointer, wheel, key, focus, or edit command a window forwards for a page,
 * or `undefined` for anything else. The reserved shortcut is refused here too,
 * so a window that forwarded it by mistake still cannot hand the page the key.
 */
export function decodeCanvasPrototypeInput(
  value: unknown,
  platform: NodeJS.Platform,
): CanvasPrototypeInput | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  const type = value.type;
  if (type === "focus" || type === "blur") return { type };
  if (type === "edit") {
    const command =
      typeof value.command === "string" ? EDIT_COMMANDS.get(value.command) : undefined;
    return command === undefined ? undefined : { type, command };
  }
  const modifiers = decodeModifiers(value.modifiers);
  if (modifiers === undefined) return undefined;
  if (type === "keyDown" || type === "keyUp" || type === "char") {
    const keyCode = value.keyCode;
    if (typeof keyCode !== "string" || keyCode.length === 0) return undefined;
    if (keyCode.length > MAX_KEY_CODE_LENGTH) return undefined;
    const reserved = isReservedPrototypeShortcut(
      {
        key: keyCode,
        meta: modifiers.includes("meta"),
        control: modifiers.includes("control"),
        alt: modifiers.includes("alt"),
        shift: modifiers.includes("shift"),
      },
      platform,
    );
    return reserved ? undefined : { type, keyCode, modifiers };
  }
  if (
    !finiteIn(value.x, -MAX_COORDINATE, MAX_COORDINATE) ||
    !finiteIn(value.y, -MAX_COORDINATE, MAX_COORDINATE)
  ) {
    return undefined;
  }
  const x = Math.round(value.x);
  const y = Math.round(value.y);
  if (type === "mouseWheel") {
    if (
      !finiteIn(value.deltaX, -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA) ||
      !finiteIn(value.deltaY, -MAX_WHEEL_DELTA, MAX_WHEEL_DELTA)
    ) {
      return undefined;
    }
    return { type, x, y, deltaX: value.deltaX, deltaY: value.deltaY, modifiers };
  }
  const pointer = POINTER_TYPES.get(type);
  const button = BUTTONS.get(typeof value.button === "string" ? value.button : "left");
  const clickCount = value.clickCount ?? 0;
  if (pointer === undefined || button === undefined || !wholeIn(clickCount, 0, 3)) {
    return undefined;
  }
  return { type: pointer, x, y, button, clickCount, modifiers };
}

interface OpenRequest {
  readonly surfaceId: string;
  readonly src: string;
  readonly width: number;
  readonly height: number;
  readonly scaleFactor: number;
}

function decodeOpenRequest(value: unknown): OpenRequest | undefined {
  if (!isRecord(value)) return undefined;
  const { surfaceId, src, width, height, scaleFactor } = value;
  if (typeof surfaceId !== "string" || !SURFACE_ID.test(surfaceId)) return undefined;
  if (typeof src !== "string" || src.length > 4_096) return undefined;
  if (!wholeIn(width, 1, MAX_WIDTH) || !wholeIn(height, 1, MAX_HEIGHT)) return undefined;
  if (!finiteIn(scaleFactor, 1, MAX_SCALE_FACTOR)) return undefined;
  return { surfaceId, src, width, height, scaleFactor };
}

export function createCanvasPrototypeSurface(options: CanvasPrototypeSurfaceOptions) {
  let host: CanvasPrototypeHostConnection | undefined;
  let ready = false;
  let preparing: Promise<CanvasPrototypeSurfacePreparation> | undefined;
  // Settles a start still waiting on the host as unavailable, when the host is
  // stopped before it says it is ready.
  let abandonStart: (() => void) | undefined;
  const owners = new Map<string, CanvasPrototypeOwner>();
  // How many times each window's prototypes were closed. An open that waited
  // on the page across a close belongs to a page that is gone, and is dropped.
  const closings = new Map<number, number>();
  // The windows that prepared the host or opened a prototype since their page
  // loaded. The host runs while one of them is still there, and stops when the
  // last goes, so a window that went while the host started leaves no process.
  const users = new Set<number>();
  // Page requests still in flight, by the window that asked, so a window that
  // goes takes its requests with it.
  const pendingOpens = new Map<number, Set<AbortController>>();
  // The network token of each open prototype whose Canvas has the switch on,
  // as the host minted it for this process. It is never sent to the prototype
  // host or a window, and goes when the prototype does.
  const networkTokens = new Map<string, string>();
  // Requests to the host's proxy still in flight, by the prototype that asked.
  const relaying = new Map<string, Set<AbortController>>();
  const forgetNetwork = (surfaceId: string) => {
    networkTokens.delete(surfaceId);
    for (const request of relaying.get(surfaceId) ?? []) request.abort();
    relaying.delete(surfaceId);
  };

  const retiring = new Map<CanvasPrototypeHostConnection, Promise<NativeHelperStopOutcome>>();
  let stopping: Promise<NativeHelperStopOutcome> | undefined;
  let generation = 0;
  const stopConnection = (connection: CanvasPrototypeHostConnection) => {
    const previous = retiring.get(connection);
    if (previous !== undefined) return previous;
    const completion = connection.stop();
    retiring.set(connection, completion);
    void completion.then((outcome) => {
      if (outcome.status === "stopped") retiring.delete(connection);
    });
    void connection.exited.then(() => retiring.delete(connection));
    return completion;
  };

  /** The host is gone: every prototype it drew is gone with it. */
  const forget = () => {
    ready = false;
    preparing = undefined;
    host = undefined;
    for (const [surfaceId, owner] of owners) owner.send({ kind: "gone", surfaceId });
    owners.clear();
    for (const surfaceId of networkTokens.keys()) forgetNetwork(surfaceId);
  };

  /**
   * One address a page asked for. This asks the host's proxy path under the
   * token of the prototype that asked, and nothing else: no header, cookie, or
   * body of its own, and no redirect followed. Whether the address is fetched
   * is the host's decision there, under the destination rule, the bounds, and
   * the switch. A question for a prototype with no token is answered here.
   */
  const relay = async (
    connection: CanvasPrototypeHostConnection,
    event: Extract<CanvasPrototypeHostEvent, { kind: "relay" }>,
  ): Promise<void> => {
    const { surfaceId, requestId, target } = event;
    // The prototype host draws agent-written pages; what it says is checked.
    if (typeof surfaceId !== "string" || !Number.isSafeInteger(requestId)) return;
    if (typeof target !== "string" || target.length > MAX_RELAY_TARGET_LENGTH) return;
    const answer = (relayed: CanvasPrototypeRelayAnswer) =>
      connection.send({ kind: "relayed", surfaceId, requestId, answer: relayed });
    const token = networkTokens.get(surfaceId);
    const address =
      token === undefined
        ? undefined
        : canvasNetworkRelayAddress(options.serverUrl(), token, target);
    if (address === undefined) {
      answer(RELAY_NOT_ALLOWED);
      return;
    }
    const request = new AbortController();
    const inFlight = relaying.get(surfaceId) ?? new Set<AbortController>();
    relaying.set(surfaceId, inFlight.add(request));
    try {
      const response = await options.fetch(address, {
        method: "GET",
        redirect: "error",
        signal: request.signal,
      });
      const body = new Uint8Array(await response.arrayBuffer());
      // The prototype closed while the host answered: its page hears nothing.
      if (request.signal.aborted) return;
      answer({
        status: response.status,
        contentType: response.headers.get("content-type") ?? "application/octet-stream",
        body,
      });
    } catch {
      if (!request.signal.aborted) answer(RELAY_UNREACHABLE);
    } finally {
      inFlight.delete(request);
      if (inFlight.size === 0 && relaying.get(surfaceId) === inFlight) relaying.delete(surfaceId);
    }
  };

  const route = (connection: CanvasPrototypeHostConnection, event: CanvasPrototypeHostEvent) => {
    if (event.kind === "ready" || event.kind === "unavailable") return;
    if (event.kind === "relay") {
      void relay(connection, event);
      return;
    }
    const owner = owners.get(event.surfaceId);
    if (owner === undefined) return;
    if (event.kind === "gone") {
      owners.delete(event.surfaceId);
      forgetNetwork(event.surfaceId);
    }
    owner.send(event);
  };

  const start = (expectedGeneration = generation): Promise<CanvasPrototypeSurfacePreparation> => {
    if (expectedGeneration !== generation)
      return Promise.resolve({ status: "unavailable", reason: NOT_STARTED });
    if (retiring.size > 0)
      return Promise.all(retiring.values()).then((outcomes) => {
        if (expectedGeneration !== generation)
          return { status: "unavailable", reason: NOT_STARTED };
        if (outcomes.some((outcome) => outcome.status === "failed")) {
          preparing = undefined;
          return { status: "unavailable", reason: NOT_STARTED };
        }
        return start(expectedGeneration);
      });
    return new Promise((settle) => {
      let settled = false;
      let started: CanvasPrototypeHostConnection | undefined;
      const finish = (result: CanvasPrototypeSurfacePreparation) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (abandonStart === abandon) abandonStart = undefined;
        if (result.status === "ready") ready = true;
        else {
          if (started !== undefined) stopConnection(started);
          // A host already stopped and replaced must not take its successor down.
          if (host === started) forget();
        }
        settle(result);
      };
      const abandon = () => finish({ status: "unavailable", reason: NOT_STARTED });
      abandonStart = abandon;
      const timer = setTimeout(
        () => finish({ status: "unavailable", reason: NOT_STARTED }),
        options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      );
      try {
        started = options.launchHost();
      } catch {
        finish({ status: "unavailable", reason: NOT_STARTED });
        return;
      }
      const launched = started;
      host = launched;
      launched.onEvent((event) => {
        if (host !== launched) return;
        if (event.kind === "ready") finish({ status: "ready" });
        else if (event.kind === "unavailable") {
          finish({ status: "unavailable", reason: event.reason });
        } else route(launched, event);
      });
      launched.onExit(() => {
        if (host !== launched) return;
        finish({ status: "unavailable", reason: NOT_STARTED });
        forget();
      });
    });
  };

  const fetchPage = async (
    ticket: string,
    server: string,
    surfaceId: string,
    signal: AbortSignal,
  ) => {
    // The proof goes to the loopback host this desktop attached to and to no
    // other address, and only it can answer with a token.
    const proof = isLoopbackHost(server) ? options.brokerHeaders?.() : undefined;
    const response = await options.fetch(
      new URL(`${CANVAS_DESIGN_PAGE_PATH}?ticket=${ticket}`, server),
      {
        redirect: "error",
        signal,
        ...(proof === undefined
          ? {}
          : { headers: { ...proof, [CANVAS_PROTOTYPE_SURFACE_HEADER]: surfaceId } }),
      },
    );
    const headers: Record<string, string> = {};
    for (const name of PAGE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    const minted = proof === undefined ? null : response.headers.get(CANVAS_NETWORK_TOKEN_HEADER);
    return {
      page: {
        status: response.status,
        headers,
        body: new Uint8Array(await response.arrayBuffer()),
      },
      networkToken: minted !== null && NETWORK_TOKEN.test(minted) ? minted : undefined,
    };
  };

  const ownedBy = (owner: CanvasPrototypeOwner, surfaceId: unknown): surfaceId is string =>
    typeof surfaceId === "string" && owners.get(surfaceId)?.id === owner.id;

  const stopHost = (): Promise<NativeHelperStopOutcome> => {
    if (host === undefined && abandonStart === undefined && stopping !== undefined) return stopping;
    generation += 1;
    const running = host;
    const abandon = abandonStart;
    for (const requests of pendingOpens.values()) for (const request of requests) request.abort();
    pendingOpens.clear();
    users.clear();
    forget();
    if (abandon !== undefined) abandon();
    if (running !== undefined) stopConnection(running);
    stopping = Promise.all(retiring.values()).then(
      (outcomes) =>
        outcomes.find((outcome) => outcome.status === "failed") ?? { status: "stopped" },
    );
    return stopping;
  };

  return Object.freeze({
    /**
     * Starts the prototype host and waits for it to read back that its network
     * and resolver are closed. Settles once; a failure is returned, not
     * remembered, so the next try starts over. Nothing opens before this is
     * ready.
     */
    prepare: (owner: CanvasPrototypeOwner): Promise<CanvasPrototypeSurfacePreparation> => {
      users.add(owner.id);
      if (preparing === undefined) {
        stopping = undefined;
        preparing = start();
      }
      return preparing;
    },

    /**
     * Opens a prototype for a window: only a ticketed design page on this
     * host, and only once the prototype host is ready. Its events go to that
     * window alone.
     */
    open: async (
      owner: CanvasPrototypeOwner,
      value: unknown,
    ): Promise<CanvasPrototypeOpenResult> => {
      const request = decodeOpenRequest(value);
      const server = options.serverUrl();
      const ticket = request === undefined ? undefined : designPageTicket(request.src, server);
      if (request === undefined || ticket === undefined || server === undefined) {
        return { status: "refused", reason: "Octant opens only a design page from this host." };
      }
      if (!ready) return { status: "refused", reason: "The prototype surface is not ready." };
      if (owners.has(request.surfaceId)) {
        return { status: "refused", reason: "That prototype is already open." };
      }
      const hostAsked = host;
      const closingsAsked = closings.get(owner.id) ?? 0;
      users.add(owner.id);
      const pageRequest = new AbortController();
      const pending = pendingOpens.get(owner.id) ?? new Set<AbortController>();
      pendingOpens.set(owner.id, pending.add(pageRequest));
      let fetched;
      try {
        fetched = await fetchPage(ticket, server, request.surfaceId, pageRequest.signal);
      } catch {
        fetched = undefined;
      } finally {
        pending.delete(pageRequest);
        if (pending.size === 0 && pendingOpens.get(owner.id) === pending) {
          pendingOpens.delete(owner.id);
        }
      }
      if ((closings.get(owner.id) ?? 0) !== closingsAsked) {
        return { status: "refused", reason: "The window that asked for the prototype is gone." };
      }
      if (fetched === undefined) {
        return { status: "refused", reason: "Octant could not reach the host for the page." };
      }
      const current = host;
      if (
        !ready ||
        current === undefined ||
        current !== hostAsked ||
        owners.has(request.surfaceId)
      ) {
        return { status: "refused", reason: "The prototype surface is not ready." };
      }
      owners.set(request.surfaceId, owner);
      if (fetched.networkToken !== undefined) {
        networkTokens.set(request.surfaceId, fetched.networkToken);
      }
      current.send({
        kind: "open",
        surfaceId: request.surfaceId,
        page: fetched.page,
        width: request.width,
        height: request.height,
        scaleFactor: request.scaleFactor,
        ...(fetched.networkToken === undefined ? {} : { network: true as const }),
      });
      return { status: "open" };
    },

    /** Forwards a person's input to a prototype the window opened. */
    input: (owner: CanvasPrototypeOwner, surfaceId: unknown, value: unknown): void => {
      if (!ownedBy(owner, surfaceId)) return;
      const input = decodeCanvasPrototypeInput(value, options.platform);
      if (input !== undefined) host?.send({ kind: "input", surfaceId, input });
    },

    resize: (
      owner: CanvasPrototypeOwner,
      surfaceId: unknown,
      width: unknown,
      height: unknown,
    ): void => {
      if (!ownedBy(owner, surfaceId)) return;
      if (!wholeIn(width, 1, MAX_WIDTH) || !wholeIn(height, 1, MAX_HEIGHT)) return;
      host?.send({ kind: "resize", surfaceId, width, height });
    },

    /** The window drew the last frame it heard, so the host may send the next. */
    drawn: (owner: CanvasPrototypeOwner, surfaceId: unknown): void => {
      if (!ownedBy(owner, surfaceId)) return;
      host?.send({ kind: "drawn", surfaceId });
    },

    close: (owner: CanvasPrototypeOwner, surfaceId: unknown): void => {
      if (!ownedBy(owner, surfaceId)) return;
      owners.delete(surfaceId);
      forgetNetwork(surfaceId);
      host?.send({ kind: "close", surfaceId });
    },

    /**
     * Closes every prototype a window opened and cancels the ones it is still
     * waiting on, as the window's page goes away. The host stops when no other
     * window uses it; the next prepare starts a new one.
     */
    closeOwnedBy: (
      ownerId: number,
    ): Promise<NativeHelperStopOutcome | { readonly status: "retained" }> => {
      closings.set(ownerId, (closings.get(ownerId) ?? 0) + 1);
      for (const request of pendingOpens.get(ownerId) ?? []) request.abort();
      pendingOpens.delete(ownerId);
      for (const [surfaceId, owner] of owners) {
        if (owner.id !== ownerId) continue;
        owners.delete(surfaceId);
        forgetNetwork(surfaceId);
        host?.send({ kind: "close", surfaceId });
      }
      users.delete(ownerId);
      return users.size === 0 ? stopHost() : Promise.resolve({ status: "retained" });
    },

    /** Stops the prototype host, as the app quits. */
    stop: stopHost,
  });
}

export type CanvasPrototypeSurface = ReturnType<typeof createCanvasPrototypeSurface>;

/**
 * A window's prototypes close with the page that opened them: on a reload or
 * a new page, when its renderer exits (which leaves the window open with no
 * page), and when its contents are destroyed.
 */
export function closeCanvasPrototypesWith(
  contents: CanvasPrototypeOwnerContentsPort,
  surface: () => CanvasPrototypeSurface | undefined,
): void {
  const close = () => surface()?.closeOwnedBy(contents.id);
  contents.onNavigation(({ isMainFrame, isInPlace }) => {
    if (isMainFrame && !isInPlace) close();
  });
  contents.onRendererGone(close);
  contents.onDestroyed(close);
}

/**
 * Starts the prototype host as a child of this process, with an IPC channel
 * that carries the page's pixels as bytes. The host leaves when the channel
 * closes; one that does not is stopped, then killed, and one still running
 * as the app exits is killed then, so it never outlives the app.
 */
export function spawnCanvasPrototypeHost(
  command: {
    readonly executable: string;
    readonly args: ReadonlyArray<string>;
  },
  lifetime: {
    readonly quitGraceMs?: number;
    /** Runs a listener as the app's process exits, until the returned function is called. */
    readonly onAppExit?: (listener: () => void) => () => void;
  } = {},
): CanvasPrototypeHostConnection {
  const child = spawn(command.executable, [...command.args], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "advanced",
  });
  const graceMs = lifetime.quitGraceMs ?? HOST_QUIT_GRACE_MS;
  const shutdown = createNativeHelperShutdown({
    child,
    closeGracefully: () => {
      if (child.connected) child.disconnect();
    },
    gracefulMs: graceMs,
    terminateMs: graceMs,
    killMs: graceMs,
  });
  const onAppExit =
    lifetime.onAppExit ??
    ((listener) => {
      process.once("exit", listener);
      return () => process.removeListener("exit", listener);
    });
  const forgetAppExit = onAppExit(() => {
    if (shutdown.state() !== "exited") child.kill("SIGKILL");
  });
  void shutdown.exited.then(forgetAppExit);
  const messages = new Set<(message: unknown) => void>();
  void shutdown.exited.then(() => {
    for (const listener of messages) child.off("message", listener);
    messages.clear();
  });
  return {
    exited: shutdown.exited,
    send: (message) => {
      if (child.connected && shutdown.state() === "running") child.send(message, () => {});
    },
    // The host speaks only the events it declares; anything else is dropped.
    onEvent: (listener) => {
      if (shutdown.state() === "exited") return;
      const messageListener = (message: unknown) => {
        if (
          shutdown.state() === "running" &&
          isRecord(message) &&
          typeof message.kind === "string"
        ) {
          listener(message as CanvasPrototypeHostEvent);
        }
      };
      messages.add(messageListener);
      child.on("message", messageListener);
    },
    onExit: (listener) => {
      void shutdown.exited.then(listener);
    },
    // Closing the channel lets the host quit on its own. One still running a
    // moment later is asked to stop, and a moment after that, killed. The
    // returned promise waits for observed exit through the bounded escalation.
    stop: shutdown.stop,
  };
}
