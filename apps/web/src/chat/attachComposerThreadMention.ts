import type { ThreadMentionCandidate } from "@octant/contracts";
import {
  appendThreadMentionChip,
  composerThreadDropCandidate,
  composerThreadDropLocalRefusal,
  composerThreadDropMessage,
} from "@octant/domain";
import { announceComposerThreadDrop } from "./composerThreadDrop";

/**
 * Ask the host's mention search for this exact id, then insert the same chip
 * an explicit selection would. The lookup is by id, not by the sidebar title,
 * so a thread the typeahead would rank out of its first page still attaches,
 * and the title shown is the host's.
 */
export async function attachComposerThreadMention(input: {
  readonly threadId: string;
  readonly currentThreadId?: string;
  readonly existingThreadIds: ReadonlyArray<string>;
  readonly mentionCount: number;
  readonly draft: string;
  readonly searchThread: (threadId: string) => Promise<ReadonlyArray<ThreadMentionCandidate>>;
  readonly onDraftChange: (draft: string, caretIndex: number) => void;
  readonly onSelectCandidate: (candidate: ThreadMentionCandidate) => void;
  readonly onStatus: (message: string) => void;
}): Promise<void> {
  const local = composerThreadDropLocalRefusal({
    payloadThreadId: input.threadId,
    existingThreadIds: input.existingThreadIds,
    mentionCount: input.mentionCount,
    ...(input.currentThreadId === undefined ? {} : { currentThreadId: input.currentThreadId }),
  });
  if (local !== undefined) {
    input.onStatus(composerThreadDropMessage(local));
    announceComposerThreadDrop(composerThreadDropMessage(local));
    return;
  }
  let openable: ReadonlyArray<ThreadMentionCandidate>;
  try {
    openable = await input.searchThread(input.threadId);
  } catch {
    const message = composerThreadDropMessage("unreadable");
    input.onStatus(message);
    announceComposerThreadDrop(message);
    return;
  }
  const candidate = composerThreadDropCandidate(input.threadId, openable);
  if (candidate === undefined) {
    const message = composerThreadDropMessage("unavailable");
    input.onStatus(message);
    announceComposerThreadDrop(message);
    return;
  }
  const applied = appendThreadMentionChip(input.draft, candidate.title);
  input.onDraftChange(applied.draft, applied.caretIndex);
  input.onSelectCandidate(candidate);
  const message = composerThreadDropMessage("attached");
  input.onStatus(message);
  announceComposerThreadDrop(message);
}
