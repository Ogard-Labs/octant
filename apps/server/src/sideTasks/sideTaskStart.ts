import {
  decodeUtcTimestamp,
  type NativeHarnessFollowUpCreation,
  type OctantMode,
  type SideTaskContext,
  type SideTaskOffer,
  type SideTaskResult,
} from "@octant/contracts";
import type {
  FollowUpCreationOutcome,
  FollowUpOrigin,
} from "../followUps/followUpSuggestionCreation";
import type { SideTaskStore } from "./sideTaskStore";

/** Where the offering turn stands for a fork through it, as that mode's fork reads it. */
export type OfferingTurnStanding = "settled" | "running" | "not-found";

export type SideTaskForkOutcome =
  | {
      readonly kind: "forked";
      readonly mode: OctantMode;
      readonly threadId: string;
      /** False when the fork runs on another model than the card named; nothing is sent then. */
      readonly onSuggestingModel: boolean;
    }
  | { readonly kind: "refused"; readonly message: string };

/** How "do it here" reached the offering thread, or why it did not. */
export type SideTaskHereOutcome =
  | { readonly kind: "sent" }
  | { readonly kind: "queued" }
  | { readonly kind: "refused"; readonly message: string };

/** A prompt for a thread's next turn, sent on the confirming window. */
export interface SideTaskTurnInput {
  readonly windowId: string;
  readonly mode: OctantMode;
  readonly threadId: string;
  readonly prompt: string;
}

export interface SideTaskStartDependencies {
  readonly store: Pick<SideTaskStore, "find" | "settle">;
  /** The same creation path a confirmed follow-up takes. */
  readonly create: (input: {
    readonly windowId: string;
    readonly view: FollowUpOrigin;
    readonly creation: NativeHarnessFollowUpCreation;
  }) => Promise<FollowUpCreationOutcome>;
  /**
   * The mode's own fork through the offering turn, on the confirming window:
   * a Chat branch, a Code fork onto its own worktree, or a Work fork.
   */
  readonly fork: (input: {
    readonly windowId: string;
    readonly offer: SideTaskOffer;
    readonly turnId: string;
  }) => Promise<SideTaskForkOutcome>;
  readonly offeringTurn: (input: {
    readonly mode: OctantMode;
    readonly threadId: string;
    readonly turnId: string;
  }) => OfferingTurnStanding;
  /**
   * Sends the prompt as the thread's next message through the mode's ordinary
   * turn command, on the confirming window. False when it did not go out.
   */
  readonly sendTurn: (input: SideTaskTurnInput) => Promise<boolean>;
  /**
   * Gives the prompt to the offering thread itself: its next turn when it is
   * idle, or its message queue behind the turn that is running.
   */
  readonly continueHere: (input: SideTaskTurnInput) => Promise<SideTaskHereOutcome>;
  readonly clock: () => string;
}

/**
 * Offers being started or continued right now, so a second click is refused
 * rather than creating twice or sending twice.
 */
const settling = new Set<string>();

function creationFor(offer: SideTaskOffer): NativeHarnessFollowUpCreation | undefined {
  if (offer.target === "new-worktree") {
    if (offer.mode !== "code" || offer.projectId === undefined) return undefined;
    return { kind: "new-worktree", mode: "code", projectId: offer.projectId, title: offer.title };
  }
  return {
    kind: "new-thread",
    mode: offer.mode,
    ...(offer.projectId === undefined ? {} : { projectId: offer.projectId }),
    title: offer.title,
  };
}

type Created =
  | {
      readonly kind: "created";
      readonly mode: OctantMode;
      readonly threadId: string;
      readonly onSuggestingModel: boolean;
    }
  | { readonly kind: "refused"; readonly result: SideTaskResult };

async function createFresh(
  dependencies: SideTaskStartDependencies,
  windowId: string,
  offer: SideTaskOffer,
): Promise<Created> {
  const id = String(offer.id);
  const creation = creationFor(offer);
  if (creation === undefined) return { kind: "refused", result: refused(id, "target-unavailable") };
  const created = await dependencies.create({
    windowId,
    view: {
      threadId: String(offer.threadId),
      mode: offer.mode,
      ...(offer.projectId === undefined ? {} : { projectId: offer.projectId }),
      suggestedBy: offer.suggestedBy,
    },
    creation,
  });
  if (created.kind === "refused" || created.created.kind === "same-thread") {
    return {
      kind: "refused",
      result: refused(
        id,
        "target-unavailable",
        created.kind === "refused" ? created.message : "The side task has no thread.",
      ),
    };
  }
  const threadId = created.created.threadId;
  if (threadId === undefined) return { kind: "refused", result: refused(id, "target-unavailable") };
  return {
    kind: "created",
    mode: created.created.mode,
    threadId,
    onSuggestingModel: created.onSuggestingModel,
  };
}

/**
 * Checks a fork can be taken before anything exists: the offer must name its
 * turn, and that turn must have finished, because a fork point is a settled
 * turn. The card holds a fork choice until the reply ends.
 */
function forkRefusal(
  dependencies: SideTaskStartDependencies,
  offer: SideTaskOffer,
): SideTaskResult | undefined {
  const id = String(offer.id);
  if (offer.turnId === undefined) {
    return refused(
      id,
      "target-unavailable",
      "This offer does not name the turn it came from, so it can only start fresh.",
    );
  }
  const standing = dependencies.offeringTurn({
    mode: offer.mode,
    threadId: String(offer.threadId),
    turnId: offer.turnId,
  });
  if (standing === "running") return refused(id, "turn-running");
  if (standing === "not-found") {
    return refused(
      id,
      "target-unavailable",
      "The turn this offer came from is no longer in the thread, so it can only start fresh.",
    );
  }
  return undefined;
}

/**
 * Starts an offered side task: the person's click is the confirmation, so the
 * thread is created and its first message sent in one step. A fresh start
 * creates the thread the way a confirmed follow-up does; a fork goes through
 * the mode's own fork through the offering turn. The offer is marked started
 * once the thread exists, even when the message could not be sent, so a
 * retry never creates a second thread.
 */
export async function startSideTask(
  dependencies: SideTaskStartDependencies,
  input: {
    readonly threadId: string;
    readonly windowId: string;
    readonly sideTaskId: string;
    /** The person's choice on the card; the model's suggestion otherwise. */
    readonly context?: SideTaskContext | undefined;
  },
): Promise<SideTaskResult> {
  const task = dependencies.store.find(input.threadId, input.sideTaskId);
  if (task === undefined) return refused(input.sideTaskId, "not-found");
  const key = `${input.threadId}:${input.sideTaskId}`;
  if (task.status !== "offered" || settling.has(key)) {
    return refused(input.sideTaskId, "already-settled");
  }
  const offer = task.offer;
  const context = input.context ?? offer.context ?? "fresh";
  const turnId = offer.turnId;
  if (context === "fork") {
    const refusal = forkRefusal(dependencies, offer);
    if (refusal !== undefined) return refusal;
  }
  settling.add(key);
  try {
    let created: Created;
    if (context === "fork" && turnId !== undefined) {
      const forked = await dependencies.fork({ windowId: input.windowId, offer, turnId });
      created =
        forked.kind === "refused"
          ? {
              kind: "refused",
              result: refused(String(offer.id), "target-unavailable", forked.message),
            }
          : { ...forked, kind: "created" };
    } else {
      created = await createFresh(dependencies, input.windowId, offer);
    }
    if (created.kind === "refused") return created.result;
    const settled = dependencies.store.settle(input.threadId, {
      kind: "started",
      payload: {
        sideTaskId: offer.id,
        startedThreadId: created.threadId,
        startedWith: context,
        startedAt: decodeUtcTimestamp(dependencies.clock()),
      },
    });
    // Sending is only for the model the person saw on the card, and only
    // while the journal agrees the offer is the one being started. Otherwise
    // the thread still opens, with the prompt waiting for the person.
    const sent =
      settled === "settled" &&
      created.onSuggestingModel &&
      (await dependencies
        .sendTurn({
          windowId: input.windowId,
          mode: created.mode,
          threadId: created.threadId,
          prompt: offer.prompt,
        })
        .catch(() => false));
    return {
      kind: "side-task-started",
      sideTaskId: offer.id,
      mode: created.mode,
      threadId: created.threadId,
      title: offer.title,
      ...(offer.projectId === undefined ? {} : { projectId: offer.projectId }),
      startedWith: context,
      sent,
    };
  } finally {
    settling.delete(key);
  }
}

/**
 * "Do it here": the offering thread takes the work on itself. The prompt goes
 * out as its next turn, or waits in its message queue behind the running
 * one, and the offer journals which. Nothing is journaled when the prompt
 * could not be delivered, so the card stays open.
 */
export async function continueSideTaskHere(
  dependencies: Pick<SideTaskStartDependencies, "store" | "continueHere" | "clock">,
  input: { readonly threadId: string; readonly windowId: string; readonly sideTaskId: string },
): Promise<SideTaskResult> {
  const task = dependencies.store.find(input.threadId, input.sideTaskId);
  if (task === undefined) return refused(input.sideTaskId, "not-found");
  const key = `${input.threadId}:${input.sideTaskId}`;
  if (task.status !== "offered" || settling.has(key)) {
    return refused(input.sideTaskId, "already-settled");
  }
  const offer = task.offer;
  settling.add(key);
  try {
    const delivered = await dependencies
      .continueHere({
        windowId: input.windowId,
        mode: offer.mode,
        threadId: String(offer.threadId),
        prompt: offer.prompt,
      })
      .catch(
        (): SideTaskHereOutcome => ({
          kind: "refused",
          message: "The prompt could not be given to this thread.",
        }),
      );
    if (delivered.kind === "refused") {
      return refused(input.sideTaskId, "target-unavailable", delivered.message);
    }
    dependencies.store.settle(input.threadId, {
      kind: "continued-here",
      payload: {
        sideTaskId: offer.id,
        delivery: delivered.kind,
        continuedAt: decodeUtcTimestamp(dependencies.clock()),
      },
    });
    return {
      kind: "side-task-continued-here",
      sideTaskId: offer.id,
      threadId: offer.threadId,
      delivery: delivered.kind,
    };
  } finally {
    settling.delete(key);
  }
}

export function dismissSideTask(
  dependencies: Pick<SideTaskStartDependencies, "store" | "clock">,
  input: { readonly threadId: string; readonly sideTaskId: string },
): SideTaskResult {
  const task = dependencies.store.find(input.threadId, input.sideTaskId);
  if (task === undefined) return refused(input.sideTaskId, "not-found");
  // A start in flight owns the offer; dismissing under it would journal a
  // dismissal for a thread that is about to exist.
  if (settling.has(`${input.threadId}:${input.sideTaskId}`)) {
    return refused(input.sideTaskId, "already-settled");
  }
  const outcome = dependencies.store.settle(input.threadId, {
    kind: "dismissed",
    payload: { sideTaskId: task.offer.id, dismissedAt: decodeUtcTimestamp(dependencies.clock()) },
  });
  return outcome === "settled"
    ? { kind: "side-task-dismissed", sideTaskId: task.offer.id }
    : refused(input.sideTaskId, outcome === "not-found" ? "not-found" : "already-settled");
}

const REFUSAL_MESSAGES = {
  "not-found": "That side task is no longer offered on this thread.",
  "already-settled": "That side task was already started, continued here, or dismissed.",
  "target-unavailable": "That side task cannot be started here.",
  "turn-running": "The reply this offer came from is still running. Fork it once the reply ends.",
} as const;

function refused(
  sideTaskId: string,
  reason: keyof typeof REFUSAL_MESSAGES,
  message: string = REFUSAL_MESSAGES[reason],
): SideTaskResult {
  const trimmed = message.trim();
  return {
    kind: "side-task-refused",
    sideTaskId,
    reason,
    message: trimmed.length > 0 && trimmed.length <= 512 ? trimmed : REFUSAL_MESSAGES[reason],
  };
}
