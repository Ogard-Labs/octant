import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from "electron";
import {
  DESKTOP_IPC_CHANNELS,
  decodeFilesCloseReply,
  type FilesCloseRequestPayload,
} from "./ipcChannels";

/**
 * The Files close exchange between this main process and a window's renderer.
 *
 * One request per window is in flight at a time: `sent` waits for the
 * renderer's `checking` acknowledgement, `acknowledged` waits for the
 * person's `allow` or `cancel` with no deadline, `confirming-unavailable`
 * is a native dialog asking the person directly because the renderer could
 * not answer, and `held` is an `allow` still locking the window until the
 * close consumes it or `release` frees it. A reply only ever affects the
 * request the registry holds for that same window and request id — a late,
 * malformed, or out-of-order one changes nothing — and an absent
 * acknowledgement never means allowed.
 *
 * The module holds no Electron state of its own: callers `install` each
 * window at registration so a cross-document main-frame navigation, a gone
 * render process, or the window's own destruction invalidates whatever the
 * previous renderer said.
 */

const FILES_CLOSE_ACK_TIMEOUT_MS = 5_000;

type CloseRequestPhase = "sent" | "acknowledged" | "confirming-unavailable" | "held";

interface CloseRequest {
  readonly id: number;
  phase: CloseRequestPhase;
  readonly resolve: (allowed: boolean) => void;
  ackHandle: ReturnType<typeof setTimeout> | undefined;
  /** Cancels the unavailable-renderer dialog when the request leaves it. */
  confirmation?: AbortController | undefined;
  /** The renderer already announced its prompt once; retries do not refocus. */
  revealed?: boolean;
}

interface DeliveryTimer {
  readonly set: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  readonly clear: (handle: ReturnType<typeof setTimeout> | undefined) => void;
}

const realTimer: DeliveryTimer = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (handle) => {
    if (handle !== undefined) clearTimeout(handle);
  },
};

export interface DesktopFilesClose {
  /** Attaches the lifetime invalidation a window's requests depend on. */
  readonly install: (window: BrowserWindow) => void;
  /**
   * Asks the window's renderer whether its Files drafts may close: `true`
   * leaves the window held and its document inert until `release` or the
   * close it allowed. A request already in flight — sent, acknowledged or
   * held — refuses rather than opening a second prompt or bypassing the
   * first.
   */
  readonly prepare: (window: BrowserWindow) => Promise<boolean>;
  /**
   * The window's renderer approved a close and still holds it. Only the
   * close path consumes this; nothing else may treat a hold as permission.
   */
  readonly holds: (window: BrowserWindow) => boolean;
  /** A request is in flight: the person may be answering it right now. */
  readonly pending: (window: BrowserWindow) => boolean;
  /** A window-set preflight is running; ordinary closes must wait it out. */
  readonly preflighting: () => boolean;
  /**
   * Feeds the window's `filesCloseReply` IPC. Returns `true` only when the
   * reply moved this window's own request: a malformed payload, a request id
   * the registry does not hold, an answer out of phase, or a cancel against a
   * request already held is refused, so the renderer learns its reply did not
   * land rather than guessing.
   */
  readonly reply: (window: BrowserWindow, payload: unknown) => boolean;
  /** Frees the window's request, telling the renderer to unlock its document. */
  readonly release: (window: BrowserWindow) => void;
  readonly releaseAll: () => void;
  /** The window's renderer no longer stands behind anything it said. */
  readonly invalidate: (window: BrowserWindow) => void;
  /**
   * Asks each live window in turn — raised and focused so the person can
   * answer — then verifies every window of the (possibly changed) set is
   * still live and held. Any refusal releases the windows that had already
   * allowed.
   */
  readonly prepareAll: (currentWindows: () => ReadonlyArray<BrowserWindow>) => Promise<boolean>;
}

/**
 * The native fallback for a window whose renderer never answered the Files
 * check: the person decides in a plain dialog whether closing may proceed
 * unchecked.
 */
export async function confirmUnresponsiveFilesClose(options: {
  readonly window: BrowserWindow;
  readonly signal: AbortSignal;
  readonly showMessageBox: (
    window: BrowserWindow,
    options: MessageBoxOptions,
  ) => Promise<MessageBoxReturnValue>;
  readonly log: (message: string) => void;
}): Promise<boolean> {
  options.log("Octant could not check unsaved Files edits before closing a window.");
  const { response } = await options.showMessageBox(options.window, {
    type: "warning",
    message: "Close this window without checking for unsaved edits?",
    detail: "Octant could not check this window. Closing it may lose unsaved Files edits.",
    buttons: ["Cancel", "Close anyway"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    signal: options.signal,
  });
  return response === 1;
}

/** Treat an unmarked macOS quit with open windows like the app menu's Quit. */
export function shouldPreflightNativeQuit(options: {
  readonly platform: NodeJS.Platform | string;
  readonly hasWindows: boolean;
  readonly systemShuttingDown: boolean;
  readonly internalQuit: boolean;
}): boolean {
  return (
    options.platform === "darwin" &&
    options.hasWindows &&
    !options.systemShuttingDown &&
    !options.internalQuit
  );
}

export function createDesktopFilesClose(options?: {
  readonly timer?: DeliveryTimer;
  readonly ackTimeoutMs?: number;
  /**
   * Asks the person natively when the renderer cannot answer — an absent
   * acknowledgement, a send that could not reach it, or a render process
   * that died with the check unanswered. When unset, an unavailable
   * renderer simply refuses, as it always did.
   */
  readonly confirmUnavailable?: (window: BrowserWindow, signal: AbortSignal) => Promise<boolean>;
}): DesktopFilesClose {
  const timer = options?.timer ?? realTimer;
  const ackTimeoutMs = options?.ackTimeoutMs ?? FILES_CLOSE_ACK_TIMEOUT_MS;
  const confirmUnavailable = options?.confirmUnavailable;
  const requests = new Map<BrowserWindow, CloseRequest>();
  let nextRequestId = 1;
  let preflight = false;

  function dropRequest(window: BrowserWindow): void {
    const request = requests.get(window);
    if (request === undefined) return;
    requests.delete(window);
    timer.clear(request.ackHandle);
    request.confirmation?.abort();
    // A held request's prepare already resolved; only a pending one is answered.
    if (request.phase !== "held") request.resolve(false);
  }

  function send(window: BrowserWindow, payload: FilesCloseRequestPayload): void {
    try {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send(DESKTOP_IPC_CHANNELS.filesCloseRequest, payload);
      }
    } catch {
      // A window leaving mid-send is refused by its invalidation, not here.
    }
  }

  function invalidate(window: BrowserWindow): void {
    dropRequest(window);
  }

  function release(window: BrowserWindow): void {
    const request = requests.get(window);
    if (request === undefined) return;
    dropRequest(window);
    send(window, { requestId: request.id, kind: "release" });
  }

  function holds(window: BrowserWindow): boolean {
    return requests.get(window)?.phase === "held";
  }

  /**
   * A renderer that could not answer does not strand the window: the person
   * is asked natively instead, and only an explicit yes becomes a hold —
   * every other outcome keeps the close refused.
   */
  function askUnavailable(window: BrowserWindow, request: CloseRequest): void {
    if (requests.get(window) !== request || request.phase !== "sent") return;
    if (confirmUnavailable === undefined || window.isDestroyed()) {
      release(window);
      return;
    }
    request.phase = "confirming-unavailable";
    timer.clear(request.ackHandle);
    const confirmation = new AbortController();
    request.confirmation = confirmation;
    // A surviving renderer may still hold this request's lock; releasing it
    // by id must not drop the request the native fallback now owns.
    send(window, { requestId: request.id, kind: "release" });
    try {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    } catch {
      // A window leaving mid-raise is refused by the await below.
    }
    void Promise.resolve()
      .then(() => confirmUnavailable(window, confirmation.signal))
      .catch(() => false)
      .then((allowed) => {
        if (
          requests.get(window) !== request ||
          request.phase !== "confirming-unavailable" ||
          confirmation.signal.aborted
        )
          return;
        request.confirmation = undefined;
        if (allowed) {
          request.phase = "held";
          request.resolve(true);
        } else {
          dropRequest(window);
        }
      });
  }

  function prepare(window: BrowserWindow): Promise<boolean> {
    if (window.isDestroyed()) return Promise.resolve(false);
    if (requests.has(window)) return Promise.resolve(false);
    const id = nextRequestId;
    nextRequestId += 1;
    return new Promise<boolean>((resolve) => {
      const request: CloseRequest = { id, phase: "sent", resolve, ackHandle: undefined };
      requests.set(window, request);
      // Only the acknowledgement is timed: the person's answer may take as
      // long as it takes, and an acknowledgement that never arrives never
      // approves. Timing out asks natively, so a renderer holding a stale
      // request unlocks instead of freezing behind an id the registry
      // dropped — and a missing answer still never means allowed.
      request.ackHandle = timer.set(() => askUnavailable(window, request), ackTimeoutMs);
      try {
        window.webContents.send(DESKTOP_IPC_CHANNELS.filesCloseRequest, {
          requestId: id,
          kind: "check",
        } satisfies FilesCloseRequestPayload);
      } catch {
        askUnavailable(window, request);
      }
    });
  }

  function reply(window: BrowserWindow, payload: unknown): boolean {
    const decoded = decodeFilesCloseReply(payload);
    if (decoded === undefined) return false;
    const request = requests.get(window);
    if (request === undefined || request.id !== decoded.requestId) return false;
    // The native fallback owns the question now: nothing a late renderer
    // says — including a cancel — may answer for it.
    if (request.phase === "confirming-unavailable") return false;
    switch (decoded.answer) {
      case "checking":
        if (request.phase !== "sent") return false;
        request.phase = "acknowledged";
        timer.clear(request.ackHandle);
        return true;
      case "prompting":
        if (request.phase !== "acknowledged") return false;
        // The renderer is showing the question: the window holding it must
        // be visible to answer. Once per request — a retried prompt must
        // not yank focus back to it.
        if (!request.revealed) {
          request.revealed = true;
          try {
            if (window.isMinimized()) window.restore();
            window.show();
            window.focus();
          } catch {
            // A window leaving mid-raise fails its own request elsewhere.
          }
        }
        return true;
      case "allow":
        // An allow only counts after the renderer acknowledged it is asking.
        if (request.phase !== "acknowledged") return false;
        request.phase = "held";
        request.resolve(true);
        return true;
      case "cancel":
        // A cancel cannot take back an approval the close already consumed.
        if (request.phase === "held") return false;
        dropRequest(window);
        return true;
    }
  }

  async function prepareAll(currentWindows: () => ReadonlyArray<BrowserWindow>): Promise<boolean> {
    if (preflight) return false;
    preflight = true;
    const accepted: BrowserWindow[] = [];
    let succeeded = false;
    try {
      const asked = [...currentWindows()];
      for (const window of asked) {
        if (window.isDestroyed()) return false;
        // Raising is the answering path's job: the renderer says `prompting`
        // when the question is on screen, and the native fallback raises the
        // window it asks about itself. No window is focused for a prompt
        // that never appears.
        if (!(await prepare(window))) return false;
        accepted.push(window);
      }
      // The set may have moved under the answers: the windows it names now
      // must be exactly the ones this preflight asked, each still live and
      // held by its own request, before any close may consume them.
      const now = currentWindows();
      succeeded =
        now.length === accepted.length &&
        now.every((window) => accepted.includes(window) && !window.isDestroyed() && holds(window));
      return succeeded;
    } finally {
      preflight = false;
      if (!succeeded) for (const window of accepted) release(window);
    }
  }

  return {
    install: (window) => {
      const contents = window.webContents;
      contents.on(
        "did-start-navigation",
        (_event, _url, isInPlace: boolean, isMainFrame: boolean) => {
          // Hash and history updates keep the renderer that answered; a new
          // document means whatever it said belongs to a renderer that left.
          // The answer is released, not silently dropped: if the navigation
          // aborts and the old document survives, it unlocks instead of
          // sitting inert behind a request the registry forgot.
          if (isMainFrame && !isInPlace) release(window);
        },
      );
      contents.on("render-process-gone", () => {
        const request = requests.get(window);
        // A render process that died with a check unanswered is just an
        // unavailable renderer: the fallback asks the person. Once the
        // fallback owns the question, the gone renderer has nothing to say.
        if (request !== undefined && request.phase === "sent") {
          askUnavailable(window, request);
        } else if (request === undefined || request.phase !== "confirming-unavailable") {
          invalidate(window);
        }
      });
      window.once("closed", () => invalidate(window));
    },
    prepare,
    holds,
    pending: (window) => {
      const phase = requests.get(window)?.phase;
      return phase === "sent" || phase === "acknowledged" || phase === "confirming-unavailable";
    },
    preflighting: () => preflight,
    reply,
    release,
    releaseAll: () => {
      for (const window of [...requests.keys()]) release(window);
    },
    invalidate,
    prepareAll,
  };
}
