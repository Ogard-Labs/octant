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
  decodeHandoverContinueRequest,
  decodeHandoverControlRequest,
  decodeHandoverRequest,
  decodeShutdownChallengeRequest,
  decodeShutdownHandoverRequest,
  decodeShutdownStartRequest,
  decodeThreadMoveChallengeRequest,
  decodeThreadMoveControlRequest,
  decodeThreadMoveStartRequest,
  decodeThreadMoveThreadRequest,
  type HandoverOutcome,
  type MovedThreadReference,
} from "@octant/contracts";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { ThreadMoveStatePort } from "./threadMoveStateStore";
import type { HandoverExchange } from "./handoverExchange";
import type { ThreadHandovers } from "./threadHandovers";
import type { ThreadMovesFromWindow } from "./threadMovesFromWindow";

// A batch names up to 64 threads with their Projects.
const BODY_LIMIT = 64 * 1_024;

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
  // Prepare to shut down acts for the whole host, as its menu entry does.
  shutdownListing: "/api/desktop/hub/thread-moves/shutdown/listing",
  shutdownChallenge: "/api/desktop/hub/thread-moves/shutdown/challenge",
  shutdownStart: "/api/desktop/hub/thread-moves/shutdown/start",
  shutdownHandover: "/api/desktop/hub/thread-moves/shutdown/handover",
  // A Code thread that cannot move hands over through its branch.
  handoverPreview: "/api/desktop/hub/thread-moves/handover/preview",
  handover: "/api/desktop/hub/thread-moves/handover",
  handoverTakeBack: "/api/desktop/hub/thread-moves/handover/take-back",
  // The handovers other members told this computer about, for the start screen.
  handoversList: "/api/desktop/hub/thread-moves/handovers/list",
  handoversContinue: "/api/desktop/hub/thread-moves/handovers/continue",
} as const;

type RouteValue =
  (typeof THREAD_MOVE_ADMINISTRATION_ROUTES)[keyof typeof THREAD_MOVE_ADMINISTRATION_ROUTES];

export interface ThreadMoveAdministrationRouteOptions {
  readonly desktopBridgeSecret: string | undefined;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly moves: ThreadMovesFromWindow;
  readonly handovers: Pick<ThreadHandovers, "preview" | "handOver" | "takeBack">;
  readonly exchange: Pick<HandoverExchange, "list" | "continueHandover">;
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
        case THREAD_MOVE_ADMINISTRATION_ROUTES.shutdownListing:
          return outcome(await options.moves.shutdownListing());
        case THREAD_MOVE_ADMINISTRATION_ROUTES.shutdownChallenge:
          return outcome(
            await options.moves.shutdownChallenge(decodeShutdownChallengeRequest(value)),
          );
        case THREAD_MOVE_ADMINISTRATION_ROUTES.shutdownStart:
          return outcome(await options.moves.shutdownStart(decodeShutdownStartRequest(value)));
        // Prepare to shut down hands over for the whole host, as its batch
        // moves do, so it is not limited to threads this window shows; it
        // hands over only what the listing offers Hand over for.
        case THREAD_MOVE_ADMINISTRATION_ROUTES.shutdownHandover: {
          const asked = decodeShutdownHandoverRequest(value);
          const refusal = await options.moves.shutdownHandoverRefusal(asked);
          if (refusal !== undefined) {
            const refused: HandoverOutcome = { status: "refused", reason: refusal };
            return outcome(refused);
          }
          return outcome(
            await options.handovers.handOver(asked.thread, String(asked.destinationMemberId)),
          );
        }
        case THREAD_MOVE_ADMINISTRATION_ROUTES.handoverPreview:
        case THREAD_MOVE_ADMINISTRATION_ROUTES.handover: {
          const asked = decodeHandoverRequest(value);
          if (!holds(asked.thread)) return unavailable();
          return outcome(
            route === THREAD_MOVE_ADMINISTRATION_ROUTES.handover
              ? await options.handovers.handOver(
                  asked.thread,
                  asked.destinationMemberId === undefined
                    ? undefined
                    : String(asked.destinationMemberId),
                  { summarize: asked.summarize === true },
                )
              : await options.handovers.preview(asked.thread),
          );
        }
        // Continuing a handover is a person's act at a window here, for the whole host.
        case THREAD_MOVE_ADMINISTRATION_ROUTES.handoversList:
          return outcome(await options.exchange.list());
        case THREAD_MOVE_ADMINISTRATION_ROUTES.handoversContinue: {
          return outcome(
            await options.exchange.continueHandover(decodeHandoverContinueRequest(value)),
          );
        }
        case THREAD_MOVE_ADMINISTRATION_ROUTES.handoverTakeBack: {
          const handoverId = String(decodeHandoverControlRequest(value).handoverId);
          const handed = (options.state.load().handovers ?? []).find(
            (entry) => String(entry.handoverId) === handoverId,
          );
          if (handed === undefined || !holds(handed.thread)) return unavailable();
          return outcome(options.handovers.takeBack(handoverId));
        }
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
