import {
  decodeThreadMoveChallengeOutcome,
  decodeThreadMoveDestinations,
  decodeThreadMoveStartOutcome,
  decodeThreadMoveThreadStatus,
  type MovedThreadReference,
  type ThreadMoveChallengeOutcome,
  type ThreadMoveDestinations,
  type ThreadMoveStartOutcome,
  type ThreadMoveStartRequest,
  type ThreadMoveThreadStatus,
} from "@octant/contracts";
import type { HubAdministrationBridge, HubAdministrationOperation } from "../../shell/hostBridge";

/**
 * What a window asks its own host about moving one thread. Every call goes
 * through the loopback hub administration, which only a local desktop window
 * has, so a remote client never offers a move.
 */
export interface ThreadMoveClient {
  readonly destinations: (thread: MovedThreadReference) => Promise<ThreadMoveDestinations>;
  readonly challenge: (destinationMemberId: string) => Promise<ThreadMoveChallengeOutcome>;
  readonly start: (request: ThreadMoveStartRequest) => Promise<ThreadMoveStartOutcome>;
  readonly status: (thread: MovedThreadReference) => Promise<ThreadMoveThreadStatus>;
  readonly stopWaiting: (thread: MovedThreadReference) => Promise<void>;
  readonly cancel: (moveId: string) => Promise<ThreadMoveCancelOutcome>;
  readonly takeBack: (moveId: string) => Promise<void>;
  readonly activate: (moveId: string) => Promise<boolean>;
  readonly dismiss: (thread: MovedThreadReference) => Promise<void>;
}

export type ThreadMoveCancelOutcome = "cancelled" | "already-moved" | "destination-unreachable";

export class ThreadMoveRequestFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThreadMoveRequestFailure";
  }
}

export function threadMoveClientOf(hub: HubAdministrationBridge): ThreadMoveClient {
  const call = async (operation: HubAdministrationOperation, body: unknown): Promise<unknown> => {
    const answer = await hub.hubAdministrationRequest(operation, body);
    // A refusal answers 409 with a body the caller reads; anything else that is
    // not a success is a failure of the request itself.
    if (answer.status !== 200 && answer.status !== 409) {
      throw new ThreadMoveRequestFailure("This computer could not answer.");
    }
    return answer.body;
  };
  return {
    destinations: async (thread) =>
      decodeThreadMoveDestinations(await call("thread-move-destinations", { thread })),
    challenge: async (destinationMemberId) =>
      decodeThreadMoveChallengeOutcome(
        await call("thread-move-challenge", { destinationMemberId }),
      ),
    start: async (request) =>
      decodeThreadMoveStartOutcome(await call("thread-move-start", request)),
    status: async (thread) =>
      decodeThreadMoveThreadStatus(await call("thread-move-status", { thread })),
    stopWaiting: async (thread) => {
      await call("thread-move-stop-waiting", { thread });
    },
    cancel: async (moveId) => {
      const body = await call("thread-move-cancel", { moveId });
      const status = typeof body === "object" && body !== null ? Reflect.get(body, "status") : "";
      return status === "already-moved" || status === "destination-unreachable"
        ? status
        : "cancelled";
    },
    takeBack: async (moveId) => {
      await call("thread-move-take-back", { moveId });
    },
    activate: async (moveId) => {
      const body = await call("thread-move-activate", { moveId });
      return (
        typeof body === "object" && body !== null && Reflect.get(body, "status") === "activated"
      );
    },
    dismiss: async (thread) => {
      await call("thread-move-dismiss", { thread });
    },
  };
}

const clientsByBridge = new WeakMap<object, ThreadMoveClient>();

/**
 * One client per host bridge, so a pane that re-renders keeps reading through
 * the same client instead of restarting its polling.
 */
export function threadMoveClientForBridge(
  bridge: object,
  hub: HubAdministrationBridge,
): ThreadMoveClient {
  const known = clientsByBridge.get(bridge);
  if (known !== undefined) return known;
  const client = threadMoveClientOf(hub);
  clientsByBridge.set(bridge, client);
  return client;
}
