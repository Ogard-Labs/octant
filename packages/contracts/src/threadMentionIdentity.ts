import { Schema } from "effect";

/**
 * Thread-mention identity and per-turn bound.
 *
 * These live apart from `threadMention.ts` so the Chat send command can name a
 * mentioned thread without a module cycle: `threadMention.ts` builds its
 * candidate and sidecar contracts on `ChatThreadId` from `chat.ts`, and
 * `chat.ts` needs the mention id for `send-chat-turn`. Effect schemas are
 * initialized at module load, so a cycle between those two would leave one
 * side reading an uninitialized binding. `threadMention.ts` re-exports
 * everything here, so existing importers are unaffected.
 */

/**
 * Opaque identity of a mentionable thread. Threads live in three modes with
 * three separate id brands; a mention only ever names a thread the principal
 * can already Open, so the mention surface carries the raw opaque string and
 * the owning mode rather than re-branding every per-mode id. The value rejects
 * path separators and URL schemes so a server bug cannot deliver a host path
 * or authority URL through a mention.
 */
export const MentionableThreadId = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(128),
  Schema.filter((value) => !/[\\/]/.test(value) && !/^(file|https?):/i.test(value)),
  Schema.brand("MentionableThreadId"),
);
export type MentionableThreadId = typeof MentionableThreadId.Type;

/** Maximum `#thread` chips one turn may carry. */
export const MAX_THREAD_MENTIONS_PER_TURN = 4;
