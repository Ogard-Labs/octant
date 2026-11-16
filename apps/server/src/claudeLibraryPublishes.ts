import type {
  CodeOperationEventFrame,
  ProjectId,
  ThreadPublishedPage,
  UtcTimestamp,
  WorkTurnState,
} from "@octant/contracts";
import type { ClaudePublishRecord } from "@octant/domain";

type PublishRecord = Omit<ClaudePublishRecord, "projectName">;

interface LibraryThread {
  readonly id: string;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly lifecycle?: string;
}

export interface ClaudeLibraryPublishSources {
  readonly workThreads: () => ReadonlyArray<LibraryThread>;
  readonly workTurns: (threadId: string) => ReadonlyArray<WorkTurnState>;
  readonly codeThreads: () => ReadonlyArray<LibraryThread>;
  /**
   * A Code thread's summarized history, which keeps every frame carrying a
   * published page; undefined when the summary must be rebuilt first.
   */
  readonly codeSummary: (
    threadId: string,
  ) => ReadonlyArray<typeof CodeOperationEventFrame.Type> | undefined;
}

/**
 * Every page a Work or Code thread published to claude.ai, read from each
 * thread's journal alone (its turns, or its summarized operation history).
 * A thread that is deleted takes its pages with it, because nothing here is
 * kept apart from the thread. Only a call's published result counts, and a
 * call reported twice is one publish.
 */
export function makeClaudeLibraryPublishes(
  sources: ClaudeLibraryPublishSources,
): () => ReadonlyArray<PublishRecord> {
  return () => {
    const records: PublishRecord[] = [];
    const record = (
      thread: LibraryThread,
      mode: "work" | "code",
      toolCallId: string,
      page: ThreadPublishedPage,
      publishedAt: UtcTimestamp,
      sequence: number,
      seen: Set<string>,
    ) => {
      if (seen.has(toolCallId)) return;
      seen.add(toolCallId);
      records.push({
        url: page.url,
        ...(page.title === undefined ? {} : { title: page.title }),
        ...(page.artifactType === undefined ? {} : { artifactType: page.artifactType }),
        ...(page.account === undefined ? {} : { account: page.account }),
        projectId: thread.projectId,
        mode,
        threadId: thread.id,
        threadTitle: thread.title,
        toolCallId,
        publishedAt,
        sequence,
        ...(page.snapshot === undefined ? {} : { snapshot: page.snapshot.format }),
      });
    };
    for (const thread of sources.workThreads()) {
      const seen = new Set<string>();
      // A Work step carries no time of its own, so a publish is placed by its
      // turn's acceptance and its step's place in the turn: a publish and the
      // update after it in one turn share the turn's time.
      const turns = sources
        .workTurns(thread.id)
        .toSorted((left, right) =>
          left.acceptedAt === right.acceptedAt ? 0 : left.acceptedAt < right.acceptedAt ? -1 : 1,
        );
      let sequence = 0;
      for (const turn of turns) {
        for (const step of turn.toolSteps ?? []) {
          sequence += 1;
          if (step.published === undefined) continue;
          record(
            thread,
            "work",
            String(step.toolCallId),
            step.published,
            turn.updatedAt,
            sequence,
            seen,
          );
        }
      }
    }
    for (const thread of sources.codeThreads()) {
      const seen = new Set<string>();
      for (const frame of sources.codeSummary(thread.id) ?? []) {
        const event = frame.event;
        if (event.kind !== "tool-activity" || event.published === undefined) continue;
        record(
          thread,
          "code",
          String(event.toolCallId),
          event.published,
          frame.occurredAt,
          frame.cursor,
          seen,
        );
      }
    }
    return records;
  };
}
