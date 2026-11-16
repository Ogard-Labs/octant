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
        ...(page.snapshot === undefined ? {} : { snapshot: page.snapshot.format }),
      });
    };
    for (const thread of sources.workThreads()) {
      const seen = new Set<string>();
      for (const turn of sources.workTurns(thread.id)) {
        for (const step of turn.toolSteps ?? []) {
          if (step.published === undefined) continue;
          record(thread, "work", String(step.toolCallId), step.published, turn.updatedAt, seen);
        }
      }
    }
    for (const thread of sources.codeThreads()) {
      const seen = new Set<string>();
      for (const frame of sources.codeSummary(thread.id) ?? []) {
        const event = frame.event;
        if (event.kind !== "tool-activity" || event.published === undefined) continue;
        record(thread, "code", String(event.toolCallId), event.published, frame.occurredAt, seen);
      }
    }
    return records;
  };
}
