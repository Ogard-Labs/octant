import {
  MAX_CODE_FORK_MERGE_BACKS_PER_TURN,
  decodeAgentRunAdmittedContext,
  decodeCodeOperationId,
  type CodeConversationTurn,
  type CodeEvidenceReference,
  type CodeForkMergeBack,
  type CodeForkMergeBackOutcome,
  type CodeForkMergeBackRefusal,
  type CodeOperationEvent,
  type CodeOperationEventFrame,
  type CodeOperationId,
  type CodeThread,
  type CodeThreadId,
  type ProviderContextBlock,
  type WindowId,
} from "@octant/contracts";
import type {
  AgentRunParentContextSelection,
  AgentRunParentContextUnavailableReason,
} from "../agentRun/agentRunParentContext";
import type {
  ExternalContentIngestionResult,
  RecordExternalContentIngestionInput,
} from "../context/externalContentIngestionStore";
import type { CodeOperationEventStore } from "./codeOperationEventStore";

type ForkContextMerged = Extract<CodeOperationEvent, { readonly kind: "fork-context-merged" }>;
export type ForkContextDelivered = Extract<
  CodeOperationEvent,
  { readonly kind: "fork-context-delivered" }
>;

/**
 * Reads a fork's own turns after `afterOperationId` (or the fork point) through
 * `throughOperationId`, through the same bounded selector a fork's handoff and
 * a provider switch use (purpose `fork-merge-back`).
 */
export type CodeForkMergeBackReader = (input: {
  readonly fork: CodeThread;
  readonly afterOperationId?: string;
  readonly throughOperationId: string;
}) => AgentRunParentContextSelection;

export interface CodeForkMergeBackPorts {
  readonly read: CodeForkMergeBackReader | undefined;
  readonly readThread: (threadId: CodeThreadId) => CodeThread | undefined;
  readonly canAccessProject: (
    windowId: WindowId,
    projectId: CodeThread["projectId"],
  ) => Promise<boolean> | boolean;
  /** The fork's own turns, to check the named one finished. */
  readonly forkTurns: (threadId: CodeThreadId) => ReadonlyArray<CodeConversationTurn> | undefined;
  readonly events: Pick<CodeOperationEventStore, "append" | "forkContextMerges">;
  readonly putEvidence: (content: string) => CodeEvidenceReference;
  readonly recordExternalContentIngestion?: (
    input: RecordExternalContentIngestionInput,
  ) => ExternalContentIngestionResult;
  readonly uuid: () => string;
}

function selectionRefusal(reason: AgentRunParentContextUnavailableReason): CodeForkMergeBackRefusal {
  switch (reason) {
    case "source-empty":
      return "nothing-new";
    case "source-point-unavailable":
      return "point-unavailable";
    default:
      return "fork-unreadable";
  }
}

/**
 * Merge a fork's conversation back into the thread it was forked from, at the
 * person's request. Only conversation moves: the fork's turns after the fork
 * point, or after its previous merge back, through a finished fork turn, as
 * bounded, attributed text. It is journaled on the source before anything is
 * sent anywhere, and the source's next turn carries it. Nothing runs, so no
 * approval is asked; the fork's file changes still reach the source only
 * through Git review.
 *
 * The window is authorized against both threads before anything is read, and
 * everything after that is synchronous, so two merges of the same fork cannot
 * both pass the duplicate check. Outside content the fork took in taints the
 * source the moment the merge is recorded there, before any turn can carry it.
 */
export async function mergeForkConversation(
  ports: CodeForkMergeBackPorts,
  input: {
    readonly windowId: WindowId;
    readonly forkThreadId: CodeThreadId;
    readonly throughOperationId: string;
  },
): Promise<CodeForkMergeBackOutcome> {
  const refused = (reason: CodeForkMergeBackRefusal) => ({ status: "refused", reason }) as const;
  if (ports.read === undefined) return refused("unsupported");
  let fork: CodeThread | undefined;
  let source: CodeThread | undefined;
  try {
    fork = ports.readThread(input.forkThreadId);
    if (fork === undefined || String(fork.id) !== String(input.forkThreadId))
      return refused("fork-unreadable");
    if (fork.forkedFrom === undefined) return refused("not-a-fork");
    source = ports.readThread(fork.forkedFrom.threadId);
  } catch {
    return refused("fork-unreadable");
  }
  const origin = fork.forkedFrom;
  if (source === undefined || String(source.id) !== String(origin.threadId))
    return refused("source-unavailable");
  const authorized = async (projectId: CodeThread["projectId"]) => {
    try {
      return await ports.canAccessProject(input.windowId, projectId);
    } catch {
      return false;
    }
  };
  if (!(await authorized(fork.projectId))) return refused("fork-unreadable");
  if (!(await authorized(source.projectId))) return refused("source-unauthorized");
  if (String(source.projectId) !== String(fork.projectId)) return refused("foreign-project");

  // Synchronous from here: the duplicate check and the append cannot interleave.
  const merges = ports.events.forkContextMerges(source.id);
  if (merges === undefined) return refused("source-unavailable");
  const previous = merges.merges.findLast(
    (merge) => String(merge.event.forkThreadId) === String(fork.id),
  )?.event;
  if (String(previous?.throughOperationId) === input.throughOperationId)
    return refused("already-merged");
  const turns = ports.forkTurns(fork.id);
  if (turns === undefined) return refused("fork-unreadable");
  const named = turns.find((turn) => String(turn.operationId) === input.throughOperationId);
  // A reply still being written would be merged half-finished, and the next
  // merge would start after it.
  if (named === undefined || named.status !== "completed") return refused("point-unavailable");
  let selection: AgentRunParentContextSelection;
  try {
    selection = ports.read({
      fork,
      ...(previous === undefined ? {} : { afterOperationId: String(previous.throughOperationId) }),
      throughOperationId: input.throughOperationId,
    });
  } catch {
    return refused("fork-unreadable");
  }
  if (selection.status === "unavailable") return refused(selectionRefusal(selection.reason));
  // What came back must be this fork's conversation, in this Project.
  if (
    selection.source.mode !== "code" ||
    selection.source.threadId !== String(fork.id) ||
    selection.source.projectId !== String(fork.projectId)
  )
    return refused("fork-unreadable");
  const tainted = selection.source.externalContentIngested;
  let content: CodeEvidenceReference;
  let operationId: CodeOperationId;
  try {
    content = ports.putEvidence(JSON.stringify(selection.blocks));
    operationId = decodeCodeOperationId(ports.uuid());
  } catch {
    return refused("unsaved");
  }
  if (tainted) {
    // The taint is recorded before the merge, so no turn can carry the text
    // into a source that does not yet say it took in outside content.
    const record = ports.recordExternalContentIngestion;
    if (record === undefined) return refused("unsupported");
    let ingested: ExternalContentIngestionResult;
    try {
      ingested = record({
        threadId: source.id,
        provenance: { origin: "external-content", sourceLabel: "fork-merge-back" },
        contentReference: `fork-merge-back-${String(content.contentId)}`,
        correlationId: ports.uuid(),
        authorized: true,
      });
    } catch {
      return refused("unsaved");
    }
    if (ingested.kind === "refused") return refused("unsaved");
  }
  const messages = selection.blocks.length - 1;
  const event: ForkContextMerged = {
    kind: "fork-context-merged",
    forkThreadId: fork.id,
    ...(previous === undefined ? {} : { afterOperationId: previous.throughOperationId }),
    throughOperationId: decodeCodeOperationId(input.throughOperationId),
    messages,
    omissions: selection.omissions,
    externalContentIngested: tainted,
    content,
    nativeSessionTransferred: false,
    hiddenReasoningTransferred: false,
  };
  try {
    ports.events.append({ threadId: source.id, operationId, expectedCursor: 0, event });
  } catch {
    return refused("unsaved");
  }
  return { status: "merged", sourceThreadId: source.id, messages };
}

function summary(event: ForkContextMerged | ForkContextDelivered): CodeForkMergeBack {
  return {
    forkThreadId: event.forkThreadId,
    ...(event.afterOperationId === undefined ? {} : { afterOperationId: event.afterOperationId }),
    throughOperationId: event.throughOperationId,
    messages: event.messages,
    omissions: event.omissions,
    externalContentIngested: event.externalContentIngested,
  };
}

/**
 * The merged fork conversations a source turn carries: the merges this turn
 * already journaled as carried (a recovered start reads those back), or else
 * the oldest merges no turn has carried yet, up to the per-turn bound. The
 * records come back unjournaled; the turn journals them when its session is
 * ready, before the prompt is sent, exactly like a handoff.
 */
export async function forkMergeDelivery(
  ports: {
    readonly events: Pick<CodeOperationEventStore, "forkContextMerges">;
    readonly readEvidence:
      | ((reference: CodeEvidenceReference) => Promise<string | undefined> | string | undefined)
      | undefined;
  },
  input: {
    readonly threadId: CodeThreadId;
    /** This turn's own frames, oldest first. */
    readonly frames: ReadonlyArray<CodeOperationEventFrame>;
  },
): Promise<
  | {
      readonly status: "ready";
      readonly blocks: ReadonlyArray<ProviderContextBlock>;
      readonly records: ReadonlyArray<ForkContextDelivered>;
    }
  | { readonly status: "refused" }
> {
  const journaled = input.frames.flatMap((frame) =>
    frame.event.kind === "fork-context-delivered" ? [frame.event] : [],
  );
  const merges = ports.events.forkContextMerges(input.threadId);
  if (merges === undefined) return { status: "refused" };
  if (journaled.length === 0 && merges.merges.length === 0)
    return { status: "ready", blocks: [], records: [] };
  let chosen: ReadonlyArray<{
    readonly operationId: CodeOperationId;
    readonly event: ForkContextMerged;
  }>;
  if (journaled.length > 0) {
    const found = journaled.map((delivered) =>
      merges.merges.find(
        (merge) => String(merge.operationId) === String(delivered.mergeOperationId),
      ),
    );
    if (found.some((merge) => merge === undefined)) return { status: "refused" };
    chosen = found.filter((merge) => merge !== undefined);
  } else {
    const last = merges.lastDeliveredOperationId;
    const start =
      last === undefined
        ? 0
        : merges.merges.findIndex((merge) => String(merge.operationId) === String(last)) + 1;
    chosen = merges.merges.slice(start, start + MAX_CODE_FORK_MERGE_BACKS_PER_TURN);
  }
  if (chosen.length === 0) return { status: "ready", blocks: [], records: [] };
  if (ports.readEvidence === undefined) return { status: "refused" };
  const blocks: ProviderContextBlock[] = [];
  for (const merge of chosen) {
    try {
      const text = await ports.readEvidence(merge.event.content);
      if (text === undefined) return { status: "refused" };
      blocks.push(...decodeAgentRunAdmittedContext(JSON.parse(text)));
    } catch {
      return { status: "refused" };
    }
  }
  return {
    status: "ready",
    blocks,
    records:
      journaled.length > 0
        ? []
        : chosen.map((merge) => ({
            ...summary(merge.event),
            kind: "fork-context-delivered" as const,
            mergeOperationId: merge.operationId,
          })),
  };
}
