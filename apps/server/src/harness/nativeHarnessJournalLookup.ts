import {
  decodeProviderSessionId,
  type NativeHarnessJournalLookupArguments,
  type NativeHarnessTranscriptMessage,
  type OctantMode,
  type ProviderInstanceId,
  type ProviderResumeCursor,
  type ProviderSessionId,
} from "@octant/contracts";
import { isNativeHarnessDriverKind } from "@octant/domain";
import { rewriteForFork } from "./nativeHarnessFork";
import type {
  NativeHarnessTranscript,
  NativeHarnessTranscriptStore,
} from "./nativeHarnessTranscriptStore";

/**
 * `journal-lookup`: the lead re-reads messages of its own conversation that a
 * context cut left out of the request. The journal keeps every message, so
 * the note in front of a cut names message numbers here and this read returns
 * them, bounded and with the thread's secrets redacted the way a fork copy
 * redacts them.
 */

/** How many messages a lookup returns when the call does not say. */
const DEFAULT_LOOKUP_MESSAGES = 5;
/** The most one lookup returns, in characters of its messages' content. */
const MAX_LOOKUP_CHARACTERS = 32_000;
/** The most of one text, argument payload, or result payload a lookup returns. */
const MAX_LOOKUP_ITEM_CHARACTERS = 8_000;

export interface NativeHarnessJournalExcerptMessage {
  /** The message's number in the conversation; `from` in a later lookup. */
  readonly number: number;
  readonly role: "user" | "assistant";
  readonly text?: string;
  readonly toolCalls?: ReadonlyArray<{
    readonly toolCallId: string;
    readonly toolName: string;
    readonly arguments: string;
  }>;
  readonly toolResults?: ReadonlyArray<{
    readonly toolCallId: string;
    readonly isError: boolean;
    readonly result: string;
  }>;
}

export type NativeHarnessJournalLookup =
  | {
      readonly status: "found";
      readonly messages: ReadonlyArray<NativeHarnessJournalExcerptMessage>;
      /** How many messages the conversation holds. */
      readonly total: number;
      /** The next message number to read when more follow; absent at the end. */
      readonly next?: number;
    }
  | {
      readonly status: "refused";
      readonly reason: "journal-unavailable" | "journal-message-missing";
      readonly message: string;
    };

/**
 * Messages `from` onward, at most `count` and at most the lookup's size bound.
 * A text or payload over its own bound is clipped with a marker saying how
 * much was left out; the first message is always returned, clipped to fit.
 */
export function excerptNativeHarnessJournal(
  transcript: NativeHarnessTranscript,
  input: NativeHarnessJournalLookupArguments,
  secrets: ReadonlyArray<string>,
): NativeHarnessJournalLookup {
  const total = transcript.messages.length;
  if (input.from >= total) {
    return {
      status: "refused",
      reason: "journal-message-missing",
      message:
        total === 0
          ? "This conversation has no journaled messages yet."
          : `This conversation has messages 0 to ${total - 1}; there is no message ${input.from}.`,
    };
  }
  // The thread's resolved secrets never leave in a lookup, as they never
  // leave in a fork's copy; the root stays as the model already read it.
  const redaction = {
    fromRoot: transcript.binding.projectRoot,
    toRoot: transcript.binding.projectRoot,
    secrets,
  };
  const end = Math.min(total, input.from + (input.count ?? DEFAULT_LOOKUP_MESSAGES));
  const messages: NativeHarnessJournalExcerptMessage[] = [];
  let remaining = MAX_LOOKUP_CHARACTERS;
  for (let number = input.from; number < end; number += 1) {
    const message = transcript.messages[number];
    if (message === undefined) break;
    const excerpt = excerptMessage(number, rewriteForFork(message, redaction));
    if (messages.length > 0 && excerpt.characters > remaining) break;
    messages.push(excerpt.message);
    remaining -= excerpt.characters;
  }
  const next = input.from + messages.length;
  return { status: "found", messages, total, ...(next < total ? { next } : {}) };
}

function excerptMessage(
  number: number,
  message: NativeHarnessTranscriptMessage,
): { readonly message: NativeHarnessJournalExcerptMessage; readonly characters: number } {
  const items = 1 + (message.toolCalls?.length ?? 0) + (message.toolResults?.length ?? 0);
  // A message with many results shares the lookup's bound between them.
  const bound = Math.min(MAX_LOOKUP_ITEM_CHARACTERS, Math.floor(MAX_LOOKUP_CHARACTERS / items));
  let characters = 0;
  const clip = (value: string) => {
    const clipped =
      value.length <= bound
        ? value
        : `${value.slice(0, bound)} [${value.length - bound} more characters left out]`;
    characters += clipped.length;
    return clipped;
  };
  const excerpt: NativeHarnessJournalExcerptMessage = {
    number,
    role: message.role,
    ...(message.text.length === 0 ? {} : { text: clip(message.text) }),
    ...(message.toolCalls === undefined
      ? {}
      : {
          toolCalls: message.toolCalls.map((call) => ({
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            arguments: clip(call.argumentsJson),
          })),
        }),
    ...(message.toolResults === undefined
      ? {}
      : {
          toolResults: message.toolResults.map((result) => ({
            toolCallId: result.toolCallId,
            isError: result.isError,
            result: clip(result.resultJson),
          })),
        }),
  };
  return { message: excerpt, characters };
}

/** The provider session a thread's running turn uses, as the thread's own journal recorded it. */
export interface NativeHarnessJournaledSession {
  readonly providerInstanceId: ProviderInstanceId;
  readonly resumeCursor?: ProviderResumeCursor | undefined;
}

/**
 * The session a Chat thread's running attempt uses: the attempt created last.
 * That is not always the last turn's: regenerating an earlier turn appends its
 * attempt to that turn after the tail ran, on a session of its own.
 */
export function newestChatAttemptSession(
  turns: ReadonlyArray<{
    readonly attempts: ReadonlyArray<
      NativeHarnessJournaledSession & { readonly createdAt: string }
    >;
  }>,
): NativeHarnessJournaledSession | undefined {
  let newest: (NativeHarnessJournaledSession & { readonly createdAt: string }) | undefined;
  for (const turn of turns) {
    for (const attempt of turn.attempts) {
      if (newest === undefined || Date.parse(attempt.createdAt) >= Date.parse(newest.createdAt)) {
        newest = attempt;
      }
    }
  }
  return newest === undefined
    ? undefined
    : {
        providerInstanceId: newest.providerInstanceId,
        ...(newest.resumeCursor === undefined ? {} : { resumeCursor: newest.resumeCursor }),
      };
}

/**
 * A thread's lookup. The conversation is the one the thread's running turn
 * uses, read from the thread's own journal when the call runs (a Chat
 * thread's attempts, a Work thread's turns, a Code thread's
 * `provider-session-ready`), so a call can only ever reach that thread's
 * conversation; one on another provider, mode, or a session the harness did
 * not run refuses. A session the thread rebuilt is a new conversation, so an
 * earlier one it replaced is not read.
 */
export function createThreadJournalLookup(input: {
  readonly mode: OctantMode;
  readonly transcripts: Pick<NativeHarnessTranscriptStore, "load">;
  readonly latestSession: () => NativeHarnessJournaledSession | undefined;
  readonly providerInstanceId: ProviderInstanceId;
  readonly secrets: ReadonlyArray<string>;
}): (args: NativeHarnessJournalLookupArguments) => NativeHarnessJournalLookup {
  const unavailable: NativeHarnessJournalLookup = {
    status: "refused",
    reason: "journal-unavailable",
    message:
      "This thread has no journaled harness conversation to read back. Continue from your task list and the files on disk.",
  };
  return (args) => {
    const session = input.latestSession();
    const cursor = session?.resumeCursor;
    if (
      session === undefined ||
      cursor === undefined ||
      String(session.providerInstanceId) !== String(input.providerInstanceId) ||
      !isNativeHarnessDriverKind(cursor.driverKind)
    ) {
      return unavailable;
    }
    let transcriptId: ProviderSessionId;
    try {
      transcriptId = decodeProviderSessionId(cursor.value);
    } catch {
      return unavailable;
    }
    const transcript = input.transcripts.load(transcriptId);
    if (
      transcript === undefined ||
      transcript.binding.mode !== input.mode ||
      String(transcript.binding.instanceId) !== String(input.providerInstanceId)
    ) {
      return unavailable;
    }
    return excerptNativeHarnessJournal(transcript, args, input.secrets);
  };
}
