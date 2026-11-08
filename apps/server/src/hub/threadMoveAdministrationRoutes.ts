// Loopback routes a window on this host uses to move one of its threads to
// another member: list the member computers and their Projects, fetch the
// destination's owner challenge for this Mac's Touch ID, start the move, read
// where it stands, and cancel, take back, activate, or dismiss. Like the rest
// of hub administration these answer only the loopback desktop bridge with an
// authenticated window capability and refuse a request that carries an Origin
// header; the private listener refuses the whole prefix, so a peer, the hub,
// or a paired device reaches them on no path. Only a person starts a move, so
// no tool or agent route leads here.

import { createHash, timingSafeEqual } from "node:crypto";
import {
  decodeThreadMoveChallengeRequest,
  decodeThreadMoveControlRequest,
  decodeThreadMoveStartRequest,
  decodeThreadMoveThreadRequest,
  type MovedThreadReference,
} from "@octant/contracts";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { ThreadMoveStatePort } from "./threadMoveStateStore";
import type { ThreadMovesFromWindow } from "./threadMovesFromWindow";

const BODY_LIMIT = 16 * 1_024;

export const THREAD_MOVE_ADMINISTRATION_ROUTES = {
  destinations: "/api/desktop/hub/thread-moves/destinations",
  challenge: "/api/desktop/hub/thread-moves/challenge",
  start: "/api/desktop/hub/thread-moves/start",
  status: "/api/desktop/hub/thread-moves/status",
  stopWaiting: "/api/desktop/hub/thread-moves/stop-waiting",
  cancel: "/api/desktop/hub/thread-moves/cancel",
  takeBack: "/api/desktop/hub/thread-moves/take-back",
  activate: "/api/desktop/hub/thread-moves/activate",
  dismiss: "/api/desktop/hub/thread-moves/dismiss",
} as const;

type RouteValue =
  (typeof THREAD_MOVE_ADMINISTRATION_ROUTES)[keyof typeof THREAD_MOVE_ADMINISTRATION_ROUTES];

export interface ThreadMoveAdministrationRouteOptions {
  readonly desktopBridgeSecret: string | undefined;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly moves: ThreadMovesFromWindow;
  readonly state: ThreadMoveStatePort;
  /** Whether the window currently holds the thread on its Project. */
  readonly authorizeThread: (input: {
    readonly thread: MovedThreadReference;
    readonly windowId: string;
  }) => boolean;
  readonly now?: () => number;
}

export function createThreadMoveAdministrationRouteHandler(
  options: ThreadMoveAdministrationRouteOptions,
): (request: Request) => Promise<Response | undefined> {
  const now = options.now ?? Date.now;
  const routes = Object.values(THREAD_MOVE_ADMINISTRATION_ROUTES) as ReadonlyArray<string>;
  return async (request) => {
    const url = new URL(request.url);
    if (!routes.includes(url.pathname)) return undefined;
    const route = url.pathname as RouteValue;
    if (options.desktopBridgeSecret === undefined) return failure("unavailable", 503);
    if (
      !isLoopbackHostname(url.hostname) ||
      request.headers.has("origin") ||
      !secretsEqual(
        options.desktopBridgeSecret,
        request.headers.get("x-octant-desktop-secret") ?? "",
      )
    ) {
      return failure("unauthorized", 401);
    }
    if (url.search !== "" || request.method !== "POST") return failure("invalid", 400);
    let windowId: string;
    try {
      windowId = String(
        options.windowAuthorityStore.authenticate(
          request.headers.get("x-octant-window-capability") ?? "",
          now(),
        ),
      );
    } catch (error) {
      return failure(error instanceof WindowAuthorityError ? "unauthorized" : "invalid", 401);
    }
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
      return failure("invalid", 400);
    }
    const text = await request.text().catch(() => undefined);
    if (text === undefined || Buffer.byteLength(text, "utf8") > BODY_LIMIT) {
      return failure("invalid", 413);
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return failure("invalid", 400);
    }

    // The capability proves a live window, not that this window holds the
    // thread: a window acts only on a thread it shows.
    const holds = (thread: MovedThreadReference) => options.authorizeThread({ thread, windowId });
    const threadOfMove = (moveId: string): MovedThreadReference | undefined => {
      const state = options.state.load();
      return (
        state.sent.find((move) => String(move.moveId) === moveId)?.thread ??
        state.received.find((move) => String(move.moveId) === moveId)?.thread
      );
    };
    const unavailable = () => outcome({ status: "refused", kind: "thread-unavailable" });

    try {
      switch (route) {
        case THREAD_MOVE_ADMINISTRATION_ROUTES.challenge:
          return outcome(
            await options.moves.challenge(
              String(decodeThreadMoveChallengeRequest(value).destinationMemberId),
            ),
          );
        case THREAD_MOVE_ADMINISTRATION_ROUTES.status: {
          // Read-only and names only member computers, so any local window
          // may read it, including for a thread that already moved away.
          const { thread } = decodeThreadMoveThreadRequest(value);
          return outcome(options.moves.status(thread));
        }
        case THREAD_MOVE_ADMINISTRATION_ROUTES.destinations: {
          const { thread } = decodeThreadMoveThreadRequest(value);
          if (!holds(thread)) return unavailable();
          return outcome(await options.moves.destinations(thread));
        }
        case THREAD_MOVE_ADMINISTRATION_ROUTES.start: {
          const started = decodeThreadMoveStartRequest(value);
          if (!holds(started.thread)) return unavailable();
          return outcome(await options.moves.start(started));
        }
        case THREAD_MOVE_ADMINISTRATION_ROUTES.stopWaiting: {
          const { thread } = decodeThreadMoveThreadRequest(value);
          if (!holds(thread)) return unavailable();
          return outcome(options.moves.stopWaiting(thread));
        }
        case THREAD_MOVE_ADMINISTRATION_ROUTES.dismiss: {
          const { thread } = decodeThreadMoveThreadRequest(value);
          if (!holds(thread)) return unavailable();
          return outcome(options.moves.dismiss(thread));
        }
        case THREAD_MOVE_ADMINISTRATION_ROUTES.cancel:
        case THREAD_MOVE_ADMINISTRATION_ROUTES.takeBack:
        case THREAD_MOVE_ADMINISTRATION_ROUTES.activate: {
          const moveId = String(decodeThreadMoveControlRequest(value).moveId);
          const thread = threadOfMove(moveId);
          if (thread === undefined || !holds(thread)) return unavailable();
          if (route === THREAD_MOVE_ADMINISTRATION_ROUTES.cancel) {
            return outcome(await options.moves.cancel(moveId));
          }
          if (route === THREAD_MOVE_ADMINISTRATION_ROUTES.takeBack) {
            return outcome(await options.moves.takeBack(moveId));
          }
          return outcome(await options.moves.activateAnyway(moveId));
        }
      }
    } catch {
      return failure("invalid", 400);
    }
  };
}

/** A refusal is a state the person can act on, so it answers 409 with its kind; anything else is the outcome. */
function outcome(value: { readonly status: string; readonly kind?: string }): Response {
  return Response.json(value, {
    status: value.status === "refused" ? 409 : 200,
    headers: { "cache-control": "no-store" },
  });
}

function secretsEqual(expected: string, actual: string): boolean {
  const left = createHash("sha256").update(expected, "utf8").digest();
  const right = createHash("sha256").update(actual, "utf8").digest();
  return timingSafeEqual(left, right);
}

function failure(category: "invalid" | "unauthorized" | "unavailable", status: number): Response {
  return Response.json(
    {
      category,
      message:
        category === "unavailable"
          ? "Thread moves are unavailable."
          : category === "unauthorized"
            ? "Thread move administration is unauthorized."
            : "Thread move request is invalid.",
    },
    { status },
  );
}
