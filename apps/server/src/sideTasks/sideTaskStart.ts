import {
  decodeUtcTimestamp,
  type NativeHarnessFollowUpCreation,
  type OctantMode,
  type SideTaskOffer,
  type SideTaskResult,
} from "@octant/contracts";
import type {
  FollowUpCreationOutcome,
  FollowUpOrigin,
} from "../followUps/followUpSuggestionCreation";
import type { SideTaskStore } from "./sideTaskStore";

export interface SideTaskStartDependencies {
  readonly store: Pick<SideTaskStore, "find" | "settle">;
  /** The same creation path a confirmed follow-up takes. */
  readonly create: (input: {
    readonly windowId: string;
    readonly view: FollowUpOrigin;
    readonly creation: NativeHarnessFollowUpCreation;
  }) => Promise<FollowUpCreationOutcome>;
  /**
   * Sends the prompt as the new thread's first message through the mode's
   * ordinary turn command, on the confirming window. False when it did not
   * go out; the thread still exists.
   */
  readonly sendFirstMessage: (input: {
    readonly windowId: string;
    readonly mode: OctantMode;
    readonly threadId: string;
    readonly prompt: string;
  }) => Promise<boolean>;
  readonly clock: () => string;
}

/** Offers being started right now, so a second click is refused rather than creating twice. */
const starting = new Set<string>();

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

/**
 * Starts an offered side task: the person's click is the confirmation, so the
 * thread is created and its first message sent in one step. The offer is
 * marked started once the thread exists, even when the message could not be
 * sent, so a retry never creates a second thread.
 */
export async function startSideTask(
  dependencies: SideTaskStartDependencies,
  input: { readonly threadId: string; readonly windowId: string; readonly sideTaskId: string },
): Promise<SideTaskResult> {
  const task = dependencies.store.find(input.threadId, input.sideTaskId);
  if (task === undefined) return refused(input.sideTaskId, "not-found");
  const key = `${input.threadId}:${input.sideTaskId}`;
  if (task.status !== "offered" || starting.has(key)) {
    return refused(input.sideTaskId, "already-settled");
  }
  const offer = task.offer;
  const creation = creationFor(offer);
  if (creation === undefined) return refused(input.sideTaskId, "target-unavailable");
  starting.add(key);
  try {
    const created = await dependencies.create({
      windowId: input.windowId,
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
        kind: "side-task-refused",
        sideTaskId: input.sideTaskId,
        reason: "target-unavailable",
        message: created.kind === "refused" ? created.message : "The side task has no thread.",
      };
    }
    const newThreadId = created.created.threadId;
    if (newThreadId === undefined) return refused(input.sideTaskId, "target-unavailable");
    const settled = dependencies.store.settle(input.threadId, {
      kind: "started",
      payload: {
        sideTaskId: offer.id,
        startedThreadId: newThreadId,
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
        .sendFirstMessage({
          windowId: input.windowId,
          mode: created.created.mode,
          threadId: newThreadId,
          prompt: offer.prompt,
        })
        .catch(() => false));
    return {
      kind: "side-task-started",
      sideTaskId: offer.id,
      mode: created.created.mode,
      threadId: newThreadId,
      title: offer.title,
      ...(offer.projectId === undefined ? {} : { projectId: offer.projectId }),
      sent,
    };
  } finally {
    starting.delete(key);
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
  if (starting.has(`${input.threadId}:${input.sideTaskId}`)) {
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

function refused(
  sideTaskId: string,
  reason: "not-found" | "already-settled" | "target-unavailable",
): SideTaskResult {
  const message =
    reason === "not-found"
      ? "That side task is no longer offered on this thread."
      : reason === "already-settled"
        ? "That side task was already started or dismissed."
        : "That side task cannot be started here.";
  return { kind: "side-task-refused", sideTaskId, reason, message };
}
