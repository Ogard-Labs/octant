import type { CodeNavigation } from "@octant/contracts/code";
import type { PendingRequest, PendingRequestList, WaitingAsk } from "@octant/contracts";
import { buildFederatedReadItem, type FederatedReadItem } from "./hostFederationMergedReads";

/** What a paired computer's Code thread shows in this window's lists. */
export interface PairedComputerThreadPayload {
  readonly mode: "code";
  readonly threadId: string;
  readonly projectId: string;
  /** Running, waiting on the person, or neither, as that computer reports it now. */
  readonly state: "working" | "needs-you" | "idle";
  readonly updatedAt: string;
}

/**
 * An approval, question, or other waiting ask a paired computer holds for the
 * person. Only Code-mode entries are listed: the row opens the thread in that
 * computer's Code start screen, which cannot show a Work or Chat thread.
 */
export interface PairedComputerAskPayload {
  readonly request: PendingRequest | WaitingAsk;
}

export type PairedComputerReadItem = Omit<
  FederatedReadItem<PairedComputerThreadPayload | PairedComputerAskPayload>,
  "freshness" | "readOnly" | "hostDisplayName"
>;

/**
 * One paired computer's contribution to this window's lists: its active Code
 * threads and what it holds for the person. Each item keeps that computer's
 * id, so opening or answering it goes back to that computer and nowhere else.
 */
export function pairedComputerReadItems(input: {
  readonly hostId: string;
  readonly navigation: CodeNavigation;
  readonly pendingRequests: PendingRequestList | undefined;
}): ReadonlyArray<PairedComputerReadItem> {
  const runtime = new Map(input.navigation.runtime.map((entry) => [String(entry.threadId), entry]));
  const threads = input.navigation.threads
    .filter((thread) => thread.lifecycle === "active")
    .map((thread) => {
      const live = runtime.get(String(thread.id));
      const payload: PairedComputerThreadPayload = {
        mode: "code",
        threadId: String(thread.id),
        projectId: String(thread.projectId),
        state:
          live?.awaitingInput === true
            ? "needs-you"
            : live?.executing === true
              ? "working"
              : "idle",
        updatedAt: String(thread.updatedAt),
      };
      return withoutPresentation(
        buildFederatedReadItem({
          hostId: input.hostId,
          entityId: String(thread.id),
          kind: "thread",
          hostDisplayName: "",
          title: thread.title,
          sortKey: String(thread.updatedAt),
          tags: ["code"],
          payload,
        }),
      );
    });
  const requests = (input.pendingRequests?.requests ?? [])
    .filter((request) => request.mode === "code")
    .map((request) => ({
      request,
      entityId: `${String(request.threadId)}:${request.kind}:${String(request.requestedAt)}`,
    }));
  const waitingAsks = (input.pendingRequests?.asks ?? [])
    .filter((ask) => ask.mode === "code")
    .map((ask) => ({ request: ask, entityId: `ask:${String(ask.askId)}` }));
  const asks = [...requests, ...waitingAsks].map(({ request, entityId }) =>
    withoutPresentation(
      buildFederatedReadItem<PairedComputerAskPayload>({
        hostId: input.hostId,
        entityId,
        kind: "approval",
        hostDisplayName: "",
        title: request.threadTitle,
        sortKey: String(request.requestedAt),
        tags: [request.mode],
        payload: { request },
      }),
    ),
  );
  return [...threads, ...asks];
}

function withoutPresentation(
  item: FederatedReadItem<PairedComputerThreadPayload | PairedComputerAskPayload>,
): PairedComputerReadItem {
  const { freshness: _freshness, readOnly: _readOnly, hostDisplayName: _name, ...rest } = item;
  return rest;
}

export function isPairedComputerThread(
  item: FederatedReadItem,
): item is FederatedReadItem<PairedComputerThreadPayload> {
  return (
    item.kind === "thread" &&
    typeof item.payload === "object" &&
    item.payload !== null &&
    "threadId" in item.payload
  );
}

export function isPairedComputerAsk(
  item: FederatedReadItem,
): item is FederatedReadItem<PairedComputerAskPayload> {
  return (
    item.kind === "approval" &&
    typeof item.payload === "object" &&
    item.payload !== null &&
    "request" in item.payload
  );
}
