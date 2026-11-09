import {
  decodeHandoverContinueOutcome,
  decodeHandoverListing,
  decodeHandoverOutcome,
  decodeKeptWorktreeRemoveOutcome,
  decodeShutdownListing,
  decodeShutdownStartOutcome,
  decodeThreadMoveChallengeOutcome,
  decodeThreadMoveDestinations,
  decodeThreadMovePhoneAskOutcome,
  decodeThreadMoveSizes,
  decodeThreadMoveStartOutcome,
  decodeThreadMoveThreadStatus,
  type HandoverContinueOutcome,
  type HandoverListing,
  type HandoverOutcome,
  type KeptWorktreeRemoveOutcome,
  type MovedThreadReference,
  type ShutdownListing,
  type ShutdownPhoneAskRequest,
  type ShutdownStartOutcome,
  type ShutdownStartRequest,
  type ThreadMoveChallengeOutcome,
  type ThreadMoveDestinations,
  type ThreadMovePhoneAskOutcome,
  type ThreadMovePhoneAskRequest,
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
  /** Holds the move until an owner phone confirms it with its own unlock on the destination. */
  readonly askPhone: (request: ThreadMovePhoneAskRequest) => Promise<ThreadMovePhoneAskOutcome>;
  readonly status: (thread: MovedThreadReference) => Promise<ThreadMoveThreadStatus>;
  readonly stopWaiting: (thread: MovedThreadReference) => Promise<void>;
  readonly cancel: (moveId: string) => Promise<ThreadMoveCancelOutcome>;
  readonly takeBack: (moveId: string) => Promise<void>;
  readonly activate: (moveId: string) => Promise<boolean>;
  readonly dismiss: (thread: MovedThreadReference) => Promise<void>;
  /** Remove worktree on a moved thread's tombstone: the folder its move kept here. */
  readonly removeKeptWorktree: (moveId: string) => Promise<KeptWorktreeRemoveOutcome>;
  /**
   * Opens a departed thread on the destination's own web app in the default
   * browser; absent when this window has no such door, and the tombstone
   * copies the link instead.
   */
  readonly openThere?: (thread: MovedThreadReference) => Promise<"opened" | "refused">;
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
  readonly shutdownAskPhone: (
    request: ShutdownPhoneAskRequest,
  ) => Promise<ThreadMovePhoneAskOutcome>;
  /** Hand over for one Prepare to shut down row, naming the head's destination. */
  readonly shutdownHandOver: (
    thread: MovedThreadReference,
    destinationMemberId: string,
  ) => Promise<HandoverOutcome>;
  /** The same sizes for any of this host's threads, as Prepare to shut down lists them. */
  readonly shutdownSizes: (
    destinationMemberId: string,
    threads: ReadonlyArray<MovedThreadReference>,
  ) => Promise<ThreadMoveSizes>;
  /** A Code thread that cannot move: what a handover would do, doing it, and taking it back. */
  readonly handoverPreview: (thread: MovedThreadReference) => Promise<HandoverOutcome>;
  readonly handOver: (
    thread: MovedThreadReference,
    destinationMemberId: string | undefined,
    choices: { readonly summarize: boolean },
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
  const openThere = hub.openMovedThreadThere;
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
    askPhone: async (request) =>
      decodeThreadMovePhoneAskOutcome(await call("thread-move-phone-ask", request)),
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
    removeKeptWorktree: async (moveId) =>
      decodeKeptWorktreeRemoveOutcome(await call("thread-move-remove-kept-worktree", { moveId })),
    ...(openThere === undefined
      ? {}
      : { openThere: async (thread: MovedThreadReference) => (await openThere(thread)).status }),
    sizes: async (destinationMemberId, threads) =>
      decodeThreadMoveSizes(await call("thread-move-sizes", { destinationMemberId, threads })),
    shutdownListing: async () => decodeShutdownListing(await call("shutdown-listing", {})),
    shutdownChallenge: async (destinationMemberId, threads) =>
      decodeThreadMoveChallengeOutcome(
        await call("shutdown-challenge", { destinationMemberId, threads }),
      ),
    shutdownStart: async (request) =>
      decodeShutdownStartOutcome(await call("shutdown-start", request)),
    shutdownAskPhone: async (request) =>
      decodeThreadMovePhoneAskOutcome(await call("shutdown-phone-ask", request)),
    shutdownHandOver: async (thread, destinationMemberId) =>
      decodeHandoverOutcome(await call("shutdown-handover", { thread, destinationMemberId })),
    shutdownSizes: async (destinationMemberId, threads) =>
      decodeThreadMoveSizes(await call("shutdown-sizes", { destinationMemberId, threads })),
    handoverPreview: async (thread) =>
      decodeHandoverOutcome(await call("handover-preview", { thread })),
    handOver: async (thread, destinationMemberId, choices) =>
      decodeHandoverOutcome(
        await call("handover", {
          thread,
          ...(destinationMemberId === undefined ? {} : { destinationMemberId }),
          summarize: choices.summarize,
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
