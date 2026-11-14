import {
  MAX_THREAD_RECAP_EXCERPT_LENGTH,
  type MentionableThreadId,
  type OctantMode,
  type ThreadMentionTranscriptEntry,
  type ThreadRecap,
} from "@octant/contracts";

export interface ThreadRecapSource {
  readonly threadId: MentionableThreadId;
  readonly mode: OctantMode;
  readonly title: string;
  /** Oldest first, as the owning mode's transcript reader returns it. */
  readonly transcript: ReadonlyArray<ThreadMentionTranscriptEntry>;
  readonly truncated: boolean;
  readonly notes: number;
}

/**
 * A recap of a thread read straight from its transcript: what the person asked
 * first and last, the agent's latest reply, and whether the newest ask still
 * waits. It quotes the thread and adds nothing of its own, so it can never say
 * more than the thread did.
 */
export function recapThread(source: ThreadRecapSource): ThreadRecap {
  const asks = source.transcript.filter((entry) => entry.role === "user");
  const replies = source.transcript.filter((entry) => entry.role === "assistant");
  const firstAsk = asks[0];
  const latestAsk = asks.at(-1);
  const latestReply = replies.at(-1);
  const last = source.transcript.at(-1);
  return {
    threadId: source.threadId,
    mode: source.mode,
    title: source.title,
    asks: asks.length,
    replies: replies.length,
    ...(firstAsk === undefined ? {} : { firstAsk: excerpt(firstAsk.text) }),
    ...(latestAsk === undefined ? {} : { latestAsk: excerpt(latestAsk.text) }),
    ...(latestReply === undefined ? {} : { latestReply: excerpt(latestReply.text) }),
    awaitingReply: last?.role === "user",
    ...(last === undefined ? {} : { throughAt: last.occurredAt }),
    truncated: source.truncated,
    notes: source.notes,
  };
}

function excerpt(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= MAX_THREAD_RECAP_EXCERPT_LENGTH) return line;
  return `${line.slice(0, MAX_THREAD_RECAP_EXCERPT_LENGTH - 1).trimEnd()}…`;
}
