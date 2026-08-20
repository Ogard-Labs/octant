import {
  decodeWorkTurnAccepted,
  decodeWorkTurnRequestId,
  decodeWorkTurnState,
  decodeWorkTurnUpdated,
  type WorkThreadId,
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

  apply(event: WorkTurnAccepted | WorkTurnUpdated): void {
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
        status: "accepted",
        prompt: accepted.prompt,
        transcript: [{ role: "user", text: accepted.prompt }],
        ...(accepted.attachments === undefined || accepted.attachments.length === 0
          ? {}
          : { attachments: accepted.attachments }),
        capabilities: accepted.capabilities,
        version: 1,
        acceptedAt: accepted.acceptedAt,
        updatedAt: accepted.acceptedAt,
      });
      this.#byRequest.set(accepted.requestId, turn);
      const threadKey = String(accepted.threadId);
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
      status: updated.status,
      ...(updated.response === undefined ? {} : { response: updated.response }),
      transcript,
      ...(updated.failure === undefined ? { failure: undefined } : { failure: updated.failure }),
      version: current.version + 1,
      updatedAt: updated.updatedAt,
    });
    this.#byRequest.set(updated.requestId, next);
  }

  lookup(requestId: WorkTurnRequestId): WorkTurnState | undefined {
    return this.#byRequest.get(decodeWorkTurnRequestId(requestId));
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

  /** Mark non-terminal turns interrupted after a host restart with no live runtime. */
  markInterruptedOnRestart(updatedAt: string): void {
    for (const [requestId, turn] of this.#byRequest) {
      if (turn.status !== "accepted" && turn.status !== "running" && turn.status !== "waiting") {
        continue;
      }
      this.#byRequest.set(
        requestId,
        decodeWorkTurnState({
          ...turn,
          status: "waiting",
          failure: {
            category: "interrupted",
            message: "Work provider turn was interrupted by a host restart.",
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
      }
    },
  });
}
