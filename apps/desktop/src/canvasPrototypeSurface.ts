import { spawn } from "node:child_process";
import { CANVAS_DESIGN_PAGE_PATH } from "@octant/contracts/canvas";
import type {
  CanvasPrototypeEditCommand,
  CanvasPrototypeFrame,
  CanvasPrototypeHostCommand,
  CanvasPrototypeHostEvent,
  CanvasPrototypeInput,
  CanvasPrototypeModifier,
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
 *   cannot hold the keyboard.
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
  readonly send: (command: CanvasPrototypeHostCommand) => void;
  readonly onEvent: (listener: (event: CanvasPrototypeHostEvent) => void) => void;
  readonly onExit: (listener: () => void) => void;
  readonly stop: () => void;
}

export interface CanvasPrototypeSurfaceOptions {
  /** Starts the prototype host process. */
  readonly launchHost: () => CanvasPrototypeHostConnection;
  /** The host the renderer reaches now; it can change when the host restarts. */
  readonly serverUrl: () => string | undefined;
  readonly fetch: typeof fetch;
  readonly platform: NodeJS.Platform;
  /** How long the prototype host has to read back that it is closed. */
  readonly readyTimeoutMs?: number;
}

const TICKET = /^[A-Za-z0-9_-]{43}$/;
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

  /** The host is gone: every prototype it drew is gone with it. */
  const forget = () => {
    ready = false;
    preparing = undefined;
    host = undefined;
    for (const [surfaceId, owner] of owners) owner.send({ kind: "gone", surfaceId });
    owners.clear();
  };

  const route = (event: CanvasPrototypeHostEvent) => {
    if (event.kind === "ready" || event.kind === "unavailable") return;
    const owner = owners.get(event.surfaceId);
    if (owner === undefined) return;
    if (event.kind === "gone") owners.delete(event.surfaceId);
    owner.send(event);
  };

  const start = (): Promise<CanvasPrototypeSurfacePreparation> =>
    new Promise((settle) => {
      let settled = false;
      let started: CanvasPrototypeHostConnection | undefined;
      const finish = (result: CanvasPrototypeSurfacePreparation) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (abandonStart === abandon) abandonStart = undefined;
        if (result.status === "ready") ready = true;
        else {
          started?.stop();
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
        if (event.kind === "ready") finish({ status: "ready" });
        else if (event.kind === "unavailable") {
          finish({ status: "unavailable", reason: event.reason });
        } else route(event);
      });
      launched.onExit(() => {
        if (host !== launched) return;
        finish({ status: "unavailable", reason: NOT_STARTED });
        forget();
      });
    });

  const fetchPage = async (ticket: string, server: string, signal: AbortSignal) => {
    const page = await options.fetch(
      new URL(`${CANVAS_DESIGN_PAGE_PATH}?ticket=${ticket}`, server),
      { redirect: "error", signal },
    );
    const headers: Record<string, string> = {};
    for (const name of PAGE_HEADERS) {
      const value = page.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    return { status: page.status, headers, body: new Uint8Array(await page.arrayBuffer()) };
  };

  const ownedBy = (owner: CanvasPrototypeOwner, surfaceId: unknown): surfaceId is string =>
    typeof surfaceId === "string" && owners.get(surfaceId)?.id === owner.id;

  const stopHost = () => {
    const running = host;
    const abandon = abandonStart;
    forget();
    // A host still starting is stopped by settling its start.
    if (abandon === undefined) running?.stop();
    else abandon();
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
      preparing ??= start();
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
      let page;
      try {
        page = await fetchPage(ticket, server, pageRequest.signal);
      } catch {
        page = undefined;
      } finally {
        pending.delete(pageRequest);
        if (pending.size === 0 && pendingOpens.get(owner.id) === pending) {
          pendingOpens.delete(owner.id);
        }
      }
      if ((closings.get(owner.id) ?? 0) !== closingsAsked) {
        return { status: "refused", reason: "The window that asked for the prototype is gone." };
      }
      if (page === undefined) {
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
      current.send({
        kind: "open",
        surfaceId: request.surfaceId,
        page,
        width: request.width,
        height: request.height,
        scaleFactor: request.scaleFactor,
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
      host?.send({ kind: "close", surfaceId });
    },

    /**
     * Closes every prototype a window opened and cancels the ones it is still
     * waiting on, as the window's page goes away. The host stops when no other
     * window uses it; the next prepare starts a new one.
     */
    closeOwnedBy: (ownerId: number): void => {
      closings.set(ownerId, (closings.get(ownerId) ?? 0) + 1);
      for (const request of pendingOpens.get(ownerId) ?? []) request.abort();
      pendingOpens.delete(ownerId);
      for (const [surfaceId, owner] of owners) {
        if (owner.id !== ownerId) continue;
        owners.delete(surfaceId);
        host?.send({ kind: "close", surfaceId });
      }
      users.delete(ownerId);
      if (users.size === 0) stopHost();
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
  child.on("error", () => undefined);
  const running = () => child.exitCode === null && child.signalCode === null;
  const graceMs = lifetime.quitGraceMs ?? HOST_QUIT_GRACE_MS;
  const onAppExit =
    lifetime.onAppExit ??
    ((listener) => {
      process.once("exit", listener);
      return () => process.removeListener("exit", listener);
    });
  const forgetAppExit = onAppExit(() => {
    if (running()) child.kill("SIGKILL");
  });
  child.once("exit", forgetAppExit);
  return {
    send: (message) => {
      if (child.connected) child.send(message);
    },
    // The host speaks only the events it declares; anything else is dropped.
    onEvent: (listener) =>
      child.on("message", (message: unknown) => {
        if (isRecord(message) && typeof message.kind === "string") {
          listener(message as CanvasPrototypeHostEvent);
        }
      }),
    onExit: (listener) => {
      child.once("exit", () => listener());
      child.once("error", () => listener());
    },
    // Closing the channel lets the host quit on its own. One still running a
    // moment later is asked to stop, and a moment after that, killed. The
    // timers do not keep the app open; the exit listener above covers that.
    stop: () => {
      if (!running()) return;
      if (child.connected) child.disconnect();
      setTimeout(() => {
        if (!running()) return;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (running()) child.kill("SIGKILL");
        }, graceMs).unref();
      }, graceMs).unref();
    },
  };
}
