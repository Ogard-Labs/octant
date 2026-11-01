import {
  decodeWorkThreadRewound,
  decodeWorkTurnAccepted,
  decodeWorkTurnRequestId,
  decodeWorkTurnState,
  decodeWorkTurnUpdated,
  type WorkThreadId,
  type WorkThreadRewound,
  type WorkTurnAccepted,
  type WorkTurnRequestId,
  type WorkTurnState,
  type WorkTurnUpdated,
  type ProjectId,
} from "@octant/contracts";
import { WORK_TURN_CAPABILITIES } from "@octant/contracts";
import { hydrateJournalProjection } from "../persistence/journalHydration";

/**
 * Rebuildable in-memory Work turn projection. Journaled turn-accepted and
 * turn-updated events rebuild durable transcript state after reconnect or
 * restart without a separate store.
 */
export class WorkTurnProjection {
  readonly #byRequest = new Map<WorkTurnRequestId, WorkTurnState>();
  readonly #byThread = new Map<string, WorkTurnRequestId[]>();
  /** Every journaled rewind, by its id, so a retried rewind answers from it. */
  readonly #rewinds = new Map<string, WorkThreadRewound>();
  /**
   * Threads rewound since their last kept turn was accepted. The next turn
   * must not take up the session that turn ran on, which still holds the
   * removed turns; accepting a new turn ends it.
   */
  readonly #rewoundSinceLatest = new Set<string>();

  apply(event: WorkTurnAccepted | WorkTurnUpdated | WorkThreadRewound): void {
    if (event.kind === "thread-rewound") {
      const rewound = decodeWorkThreadRewound(event);
      if (this.#rewinds.has(String(rewound.rewindId))) return;
      this.#rewinds.set(String(rewound.rewindId), rewound);
      const threadKey = String(rewound.threadId);
      const removed = new Set(rewound.removedRequestIds.map(String));
      // The removed turns leave the thread's order only; their own records
      // stay readable by request, so a retried send of one answers as before.
      this.#byThread.set(
        threadKey,
        (this.#byThread.get(threadKey) ?? []).filter(
          (requestId) => !removed.has(String(requestId)),
        ),
      );
      this.#rewoundSinceLatest.add(threadKey);
      return;
    }
    if (event.kind === "turn-accepted") {
      const accepted = decodeWorkTurnAccepted(event);
      const existing = this.#byRequest.get(accepted.requestId);
      if (existing !== undefined && existing.version >= 1) return;
      const turn = decodeWorkTurnState({
        requestId: accepted.requestId,
        threadId: accepted.threadId,
        turnId: accepted.turnId,
        projectId: accepted.projectId,
        authority: accepted.authority,
        providerSessionId: accepted.providerSessionId,
        ...(accepted.resumeCursor === undefined ? {} : { resumeCursor: accepted.resumeCursor }),
        ...(accepted.handoff === undefined ? {} : { handoff: accepted.handoff }),
        ...(accepted.carriedFrom === undefined ? {} : { carriedFrom: accepted.carriedFrom }),
        status: "accepted",
        prompt: accepted.prompt,
        transcript: [{ role: "user", text: accepted.prompt }],
        ...(accepted.attachments === undefined || accepted.attachments.length === 0
          ? {}
          : { attachments: accepted.attachments }),
        ...(accepted.extensionSelections === undefined || accepted.extensionSelections.length === 0
          ? {}
          : { extensionSelections: accepted.extensionSelections }),
        capabilities: accepted.capabilities,
        ...(accepted.delivery === undefined ? {} : { delivery: accepted.delivery }),
        version: 1,
        acceptedAt: accepted.acceptedAt,
        updatedAt: accepted.acceptedAt,
      });
      this.#byRequest.set(accepted.requestId, turn);
      const threadKey = String(accepted.threadId);
      this.#rewoundSinceLatest.delete(threadKey);
      const order = this.#byThread.get(threadKey) ?? [];
      if (!order.includes(accepted.requestId)) {
        this.#byThread.set(threadKey, [...order, accepted.requestId]);
      }
      return;
    }

    const updated = decodeWorkTurnUpdated(event);
    const current = this.#byRequest.get(updated.requestId);
    if (current === undefined) return;
    if (
      String(current.threadId) !== String(updated.threadId) ||
      String(current.turnId) !== String(updated.turnId)
    ) {
      return;
    }
    const transcript =
      updated.transcript ??
      ([
        { role: "user", text: current.prompt },
        ...(updated.response === undefined
          ? []
          : [
              {
                role: "assistant" as const,
                text: updated.response,
                status: updated.status,
              },
            ]),
      ] as WorkTurnState["transcript"]);
    const next = decodeWorkTurnState({
      ...current,
      ...(updated.resumeCursor === undefined ? {} : { resumeCursor: updated.resumeCursor }),
      status: updated.status,
      ...(updated.response === undefined ? {} : { response: updated.response }),
      transcript,
      ...(updated.wroteFiles === undefined ? {} : { wroteFiles: updated.wroteFiles }),
      ...(updated.tasks === undefined ? {} : { tasks: updated.tasks }),
      ...(updated.toolSteps === undefined ? {} : { toolSteps: updated.toolSteps }),
      ...(updated.toolStepsTruncated === undefined
        ? {}
        : { toolStepsTruncated: updated.toolStepsTruncated }),
      ...(updated.childObservations === undefined
        ? {}
        : { childObservations: updated.childObservations }),
      ...(updated.failure === undefined ? { failure: undefined } : { failure: updated.failure }),
      version: current.version + 1,
      updatedAt: updated.updatedAt,
    });
    this.#byRequest.set(updated.requestId, next);
  }

  lookup(requestId: WorkTurnRequestId): WorkTurnState | undefined {
    return this.#byRequest.get(decodeWorkTurnRequestId(requestId));
  }

  /** Whether the thread was rewound since its last kept turn was accepted. */
  rewoundSinceLatest(threadId: WorkThreadId): boolean {
    return this.#rewoundSinceLatest.has(String(threadId));
  }

  /** A journaled rewind, by its id. */
  rewind(rewindId: string): WorkThreadRewound | undefined {
    return this.#rewinds.get(rewindId);
  }

  latestForThread(threadId: WorkThreadId): WorkTurnState | undefined {
    const requestId = this.#byThread.get(String(threadId))?.at(-1);
    return requestId === undefined ? undefined : this.#byRequest.get(requestId);
  }

  listForThread(threadId: WorkThreadId): ReadonlyArray<WorkTurnState> {
    const order = this.#byThread.get(String(threadId)) ?? [];
    return order
      .map((requestId) => this.#byRequest.get(requestId))
      .filter((turn): turn is WorkTurnState => turn !== undefined);
  }

  listForProject(projectId: ProjectId): ReadonlyArray<WorkTurnState> {
    return [...this.#byRequest.values()]
      .filter((turn) => String(turn.projectId) === String(projectId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /**
   * A host restart ends every turn the journal still reads as running: nothing
   * is left that could finish it. Such a turn settles as interrupted, as a Code
   * turn does, so the thread takes its next message instead of waiting on a
   * runtime that is gone. A turn already `waiting` on a provider usage limit
   * waits on the reset, not on a runtime, so the restart leaves it alone.
   * Settling a settled turn changes nothing, so a rebuild reads the same.
   */
  markInterruptedOnRestart(updatedAt: string): void {
    for (const [requestId, turn] of this.#byRequest) {
      if (turn.status !== "accepted" && turn.status !== "running" && turn.status !== "waiting") {
        continue;
      }
      if (turn.status === "waiting" && turn.failure?.usageLimit !== undefined) continue;
      this.#byRequest.set(
        requestId,
        decodeWorkTurnState({
          ...turn,
          status: "failed",
          failure: {
            category: "interrupted",
            message: RESTART_INTERRUPTED_MESSAGE,
          },
          transcript: [
            { role: "user", text: turn.prompt },
            {
              role: "assistant",
              text: turn.response ?? "",
              status: "interrupted",
            },
          ],
          version: turn.version + 1,
          updatedAt,
          capabilities: turn.capabilities ?? WORK_TURN_CAPABILITIES,
        }),
      );
    }
  }
}

const RESTART_INTERRUPTED_MESSAGE =
  "Octant restarted while this turn was running, so it did not finish. Send a new message to continue.";

export function hydrateWorkTurnProjectionFromJournal(input: {
  readonly replay: (cursor: {
    afterSequence: number;
    limit: number;
    aggregateType?: string;
  }) => ReadonlyArray<{
    readonly globalSequence: number;
    readonly aggregateType?: string;
    readonly eventName: string;
    readonly eventVersion: number;
    readonly payload: unknown;
  }>;
  readonly projection: WorkTurnProjection;
  readonly maxScan?: number;
}): "ok" | "snapshot-required" {
  return hydrateJournalProjection({
    replay: input.replay,
    aggregateType: "work-turn",
    ...(input.maxScan === undefined ? {} : { maxScan: input.maxScan }),
    apply: (event) => {
      if (
        (event.aggregateType !== undefined && event.aggregateType !== "work-turn") ||
        event.eventVersion !== 1
      ) {
        return;
      }
      if (event.eventName === "work.turn-accepted@1") {
        input.projection.apply(event.payload as WorkTurnAccepted);
      } else if (event.eventName === "work.turn-updated@1") {
        input.projection.apply(event.payload as WorkTurnUpdated);
      } else if (event.eventName === "work.thread-rewound@1") {
        input.projection.apply(event.payload as WorkThreadRewound);
      }
    },
  });
}
