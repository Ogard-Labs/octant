import { Schema } from "effect";
import { MAX_AGENT_RUN_ADMITTED_CONTEXT_BLOCKS } from "./agentRun";
import { ProviderInstanceId, ProviderModelId } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const nonNegativeCount = Schema.Int.pipe(Schema.nonNegative());

/**
 * What a handoff left out of the conversation it carried, by cause. Every
 * count is explicit so a reader never mistakes a short handoff for a short
 * conversation: purged bodies are `missingBodies`, bodies over the read bound
 * are `oversizedBodies`, and replies a turn never finished are
 * `unfinishedReplies`. Code, Chat and Work journal the same shape.
 */
export const ContextHandoffOmissions = Schema.Struct({
  earlierMessages: nonNegativeCount,
  unfinishedReplies: nonNegativeCount,
  missingBodies: nonNegativeCount,
  oversizedBodies: nonNegativeCount,
  emptyBodies: nonNegativeCount,
  attachments: nonNegativeCount,
  truncatedMessages: nonNegativeCount,
  truncatedCharacters: nonNegativeCount,
  sourceTruncatedMessages: nonNegativeCount,
}).annotations(strict);
export type ContextHandoffOmissions = typeof ContextHandoffOmissions.Type;

/** Conversation messages a handoff carried; the bound leaves room for its summary block. */
export const ContextHandoffMessages = Schema.Int.pipe(
  Schema.between(1, MAX_AGENT_RUN_ADMITTED_CONTEXT_BLOCKS - 1),
);

/**
 * What a Chat or Work turn started its session with when its provider changed
 * and the new provider keeps its conversation in a session of its own: the
 * thread's earlier accepted prompts and completed replies as bounded,
 * attributed text. The two `false` fields are fixed because Octant never
 * carries a provider's native session or hidden reasoning across providers,
 * and the record says so. The handed-over text is a verbatim excerpt of the
 * thread's own journaled messages, so the record keeps the counts, not a
 * second copy of the text.
 */
export const ProviderSwitchConversationHandoff = Schema.Struct({
  reason: Schema.Literal("provider-switch"),
  previousProviderInstanceId: ProviderInstanceId,
  previousModelId: ProviderModelId,
  /** Conversation messages the handoff carried, not counting its summary. */
  messages: ContextHandoffMessages,
  omissions: ContextHandoffOmissions,
  /** Whether the thread had taken in outside content when the handoff was read. */
  externalContentIngested: Schema.Boolean,
  nativeSessionTransferred: Schema.Literal(false),
  hiddenReasoningTransferred: Schema.Literal(false),
}).annotations(strict);
export type ProviderSwitchConversationHandoff = typeof ProviderSwitchConversationHandoff.Type;
