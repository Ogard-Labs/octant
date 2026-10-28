import {
  decodeCodeThreadId,
  decodeWorkThreadId,
  type CodeConversationPage,
  type CodeThreadId,
  type PublishedSnapshotRunRequest,
  type ThreadPublishedSnapshot,
  type WindowId,
  type WorkThreadId,
  type WorkTurnState,
} from "@octant/contracts";

const CODE_CONVERSATION_PAGE = 50;

export interface PublishedSnapshotSourceDependencies {
  /** Every turn of a Work thread, under the window's read check. */
  readonly workTurns: (
    windowId: WindowId,
    threadId: WorkThreadId,
  ) => Promise<ReadonlyArray<WorkTurnState>>;
  /** One forward page of a Code thread's conversation, under the window's read check. */
  readonly codeConversation?: (
    windowId: WindowId,
    threadId: CodeThreadId,
    afterCursor: number,
    limit: number,
  ) => CodeConversationPage | Promise<CodeConversationPage>;
}

/**
 * Finds the snapshot a thread's tool call journaled with the page it
 * published. Each read goes through the thread's own read authority, so a
 * window that cannot open the thread finds nothing.
 */
export function makePublishedSnapshotSource(dependencies: PublishedSnapshotSourceDependencies) {
  return async (
    windowId: WindowId,
    request: PublishedSnapshotRunRequest,
  ): Promise<ThreadPublishedSnapshot | undefined> => {
    if (request.mode === "work") {
      const turns = await dependencies.workTurns(windowId, decodeWorkThreadId(request.threadId));
      for (const turn of turns) {
        const step = turn.toolSteps?.find(
          (candidate) => candidate.toolCallId === request.toolCallId,
        );
        if (step !== undefined) return step.published?.snapshot;
      }
      return undefined;
    }
    const read = dependencies.codeConversation;
    if (read === undefined) return undefined;
    const threadId = decodeCodeThreadId(request.threadId);
    let cursor = 0;
    for (;;) {
      const page = await read(windowId, threadId, cursor, CODE_CONVERSATION_PAGE);
      for (const turn of page.turns) {
        const step = turn.steps?.find(
          (candidate) => candidate.kind === "tool" && candidate.toolCallId === request.toolCallId,
        );
        if (step?.kind === "tool") return step.published?.snapshot;
      }
      if (!page.hasMore || page.nextCursor <= cursor) return undefined;
      cursor = page.nextCursor;
    }
  };
}
