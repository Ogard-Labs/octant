import {
  decodeHandoverContinueOutcome,
  decodeHandoverListing,
  decodeHandoverOutcome,
  decodeShutdownListing,
  decodeShutdownStartOutcome,
  decodeThreadMoveChallengeOutcome,
  decodeThreadMoveDestinations,
  decodeThreadMoveSizes,
  decodeThreadMoveStartOutcome,
  decodeThreadMoveThreadStatus,
  type HandoverContinueOutcome,
  type HandoverListing,
  type HandoverOutcome,
  type MovedThreadReference,
  type ShutdownListing,
  type ShutdownStartOutcome,
  type ShutdownStartRequest,
  type ThreadMoveChallengeOutcome,
  type ThreadMoveDestinations,
  type ThreadMoveSizes,
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
  /** What moving the thread to a member would send, and how fast; read-only. */
  readonly sizes: (
    destinationMemberId: string,
    threads: ReadonlyArray<MovedThreadReference>,
  ) => Promise<ThreadMoveSizes>;
  /** Prepare to shut down: every thread here, and one unlocked batch per destination. */
  readonly shutdownListing: () => Promise<ShutdownListing>;
  readonly shutdownChallenge: (
    destinationMemberId: string,
    threads: ReadonlyArray<MovedThreadReference>,
  ) => Promise<ThreadMoveChallengeOutcome>;
  readonly shutdownStart: (request: ShutdownStartRequest) => Promise<ShutdownStartOutcome>;
  /** The same sizes for any of this host's threads, as Prepare to shut down lists them. */
  readonly shutdownSizes: (
    destinationMemberId: string,
    threads: ReadonlyArray<MovedThreadReference>,
  ) => Promise<ThreadMoveSizes>;
  /** A Code thread that cannot move: what a handover would do, doing it, and taking it back. */
  readonly handoverPreview: (thread: MovedThreadReference) => Promise<HandoverOutcome>;
  readonly handOver: (
    thread: MovedThreadReference,
    destinationMemberId?: string,
  ) => Promise<HandoverOutcome>;
  readonly handoverTakeBack: (handoverId: string) => Promise<void>;
  /** Handovers other computers told this one about, and continuing one here. */
  readonly handoversList: () => Promise<HandoverListing>;
  readonly handoversContinue: (request: {
    readonly handoverId: string;
    readonly projectId: string;
  }) => Promise<HandoverContinueOutcome>;
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
    sizes: async (destinationMemberId, threads) =>
      decodeThreadMoveSizes(await call("thread-move-sizes", { destinationMemberId, threads })),
    shutdownListing: async () => decodeShutdownListing(await call("shutdown-listing", {})),
    shutdownChallenge: async (destinationMemberId, threads) =>
      decodeThreadMoveChallengeOutcome(
        await call("shutdown-challenge", { destinationMemberId, threads }),
      ),
    shutdownStart: async (request) =>
      decodeShutdownStartOutcome(await call("shutdown-start", request)),
    shutdownSizes: async (destinationMemberId, threads) =>
      decodeThreadMoveSizes(await call("shutdown-sizes", { destinationMemberId, threads })),
    handoverPreview: async (thread) =>
      decodeHandoverOutcome(await call("handover-preview", { thread })),
    handOver: async (thread, destinationMemberId) =>
      decodeHandoverOutcome(
        await call("handover", {
          thread,
          ...(destinationMemberId === undefined ? {} : { destinationMemberId }),
        }),
      ),
    handoverTakeBack: async (handoverId) => {
      await call("handover-take-back", { handoverId });
    },
    handoversList: async () => decodeHandoverListing(await call("handovers-list", {})),
    handoversContinue: async (request) =>
      decodeHandoverContinueOutcome(await call("handovers-continue", request)),
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
