// The Chat side of a thread move, on both computers. The source packs the
// conversation it holds (each turn's message and each completed attempt's
// answers, with the provider identifiers they ran on) and erases the thread
// through the ordinary purge once the destination committed. The destination
// opens the conversation as real turns, held until the commit, the way a
// branch carries its source's turns.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ChatThreadId,
  ProjectId,
  ProviderInstanceId,
  ProviderModelId,
  ProviderSessionId,
  ContextManifestId,
  UtcTimestamp,
  type ChatThread,
  type ChatThreadView,
  type MovedThreadReference,
  type ThreadMoveOffer,
} from "@octant/contracts";
import { Schema } from "effect";
import type { MovedChatThreadImport } from "../chat/chatService";
import type {
  PackedPart,
  ThreadMoveDestinationHost,
  ThreadMoveSourceHost,
} from "./threadMoveService";

/** The format the Chat conversation part is written in; a destination refuses any other. */
export const MOVED_CHAT_CONVERSATION_FORMAT = "octant.thread-move.chat/1" as const;

const strict = { parseOptions: { onExcessProperty: "error" as const } };

const MovedChatConversation = Schema.Struct({
  format: Schema.Literal(MOVED_CHAT_CONVERSATION_FORMAT),
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  externalContentIngested: Schema.Boolean,
  turns: Schema.Array(
    Schema.Struct({
      userText: Schema.String,
      createdAt: UtcTimestamp,
      attempts: Schema.Array(
        Schema.Struct({
          providerInstanceId: ProviderInstanceId,
          providerSessionId: ProviderSessionId,
          modelId: ProviderModelId,
          contextManifestId: ContextManifestId,
          responses: Schema.Array(Schema.String),
          createdAt: UtcTimestamp,
          updatedAt: UtcTimestamp,
        }).annotations(strict),
      ),
    }).annotations(strict),
  ),
}).annotations(strict);
type MovedChatConversation = typeof MovedChatConversation.Type;

const decodeConversation = Schema.decodeUnknownSync(MovedChatConversation);
const decodeChatThreadId = Schema.decodeUnknownSync(ChatThreadId);
const decodeProjectId = Schema.decodeUnknownSync(ProjectId);

/** Which threads a move holds on this host, frozen or arriving. */
export interface ThreadMoveHolds {
  readonly hold: (thread: MovedThreadReference) => void;
  readonly release: (thread: MovedThreadReference) => void;
  readonly isHeld: (thread: MovedThreadReference) => boolean;
}

export function createThreadMoveHolds(
  initial: ReadonlyArray<MovedThreadReference> = [],
): ThreadMoveHolds {
  const key = (thread: MovedThreadReference) => `${thread.mode}:${thread.threadId}`;
  const held = new Set(initial.map(key));
  return {
    hold: (thread) => {
      held.add(key(thread));
    },
    release: (thread) => {
      held.delete(key(thread));
    },
    isHeld: (thread) => held.has(key(thread)),
  };
}

export interface ChatThreadMoveHostOptions {
  readonly readView: (threadId: ChatThreadId) => ChatThreadView | undefined;
  /** Whether a turn is running or the thread waits on the person. */
  readonly isBusy: (view: ChatThreadView) => boolean;
  readonly externalContentIngested: (threadId: string) => boolean;
  readonly importMovedThread: (input: MovedChatThreadImport) => Promise<ChatThread>;
  readonly activeChatProject: (projectId: string) => boolean;
  /** Erases one Chat thread through the ordinary purge. */
  readonly purge: (threadId: ChatThreadId) => Promise<void>;
  readonly holds: ThreadMoveHolds;
}

export function createChatThreadMoveHost(options: ChatThreadMoveHostOptions): {
  readonly source: ThreadMoveSourceHost;
  readonly destination: ThreadMoveDestinationHost;
} {
  const viewOf = (thread: MovedThreadReference): ChatThreadView | undefined => {
    if (thread.mode !== "chat") return undefined;
    try {
      return options.readView(decodeChatThreadId(thread.threadId));
    } catch {
      return undefined;
    }
  };

  const source: ThreadMoveSourceHost = {
    read: async (thread) => {
      const view = viewOf(thread);
      if (view === undefined || view.thread.lifecycle !== "active") return { status: "missing" };
      return {
        status: "found",
        title: view.thread.title,
        busy: options.isBusy(view),
        // A Chat thread is never delegated between computers.
        delegated: false,
        repositoryRemotes: [],
      };
    },
    freeze: (thread) => options.holds.hold(thread),
    unfreeze: (thread) => options.holds.release(thread),
    isFrozen: (thread) => options.holds.isHeld(thread),
    pack: async (thread, folder) => {
      const view = viewOf(thread);
      if (view === undefined) return { status: "refused", reason: "refused" };
      const conversation = conversationOf(view, options.externalContentIngested(thread.threadId));
      const path = join(folder, "thread.json");
      await writeFile(path, JSON.stringify(conversation), { mode: 0o600 });
      const part: PackedPart = { partId: "thread", kind: "thread-bundle", path };
      return { status: "packed", parts: [part] };
    },
    erase: async ({ thread }) => {
      await options.purge(decodeChatThreadId(thread.threadId));
      // A Chat thread owns no worktree.
      return { worktreeKept: false };
    },
  };

  const destination: ThreadMoveDestinationHost = {
    acceptsProject: (offer: ThreadMoveOffer) =>
      offer.source.mode === "chat" &&
      (offer.destinationProjectId === undefined ||
        options.activeChatProject(String(offer.destinationProjectId))),
    arrive: async ({ thread: planned, offer, parts }) => {
      if (planned.mode !== "chat") return { status: "refused", reason: "transfer-failed" };
      // A thread already opened under the planned id was opened by an earlier
      // try that stopped before it was recorded: hold it, never open a second.
      if (viewOf(planned) !== undefined) {
        options.holds.hold(planned);
        return { status: "arrived", thread: planned };
      }
      const bundle = offer.manifest.parts.find((part) => part.kind === "thread-bundle");
      const path = bundle === undefined ? undefined : parts.get(bundle.partId);
      if (offer.source.mode !== "chat" || path === undefined) {
        return { status: "refused", reason: "transfer-failed" };
      }
      let conversation: MovedChatConversation;
      try {
        conversation = decodeConversation(JSON.parse(await readFile(path, "utf8")));
      } catch {
        return { status: "refused", reason: "transfer-failed" };
      }
      if (
        offer.destinationProjectId !== undefined &&
        !options.activeChatProject(String(offer.destinationProjectId))
      ) {
        return { status: "refused", reason: "no-eligible-project" };
      }
      options.holds.hold(planned);
      const created = await options.importMovedThread({
        moveId: String(offer.moveId),
        threadId: decodeChatThreadId(planned.threadId),
        title: conversation.title,
        ...(offer.destinationProjectId === undefined
          ? {}
          : { projectId: decodeProjectId(offer.destinationProjectId) }),
        externalContentIngested: conversation.externalContentIngested,
        turns: conversation.turns.map((turn) => ({
          userText: turn.userText,
          createdAt: turn.createdAt,
          attempts: turn.attempts.map((attempt) => ({
            providerInstanceId: attempt.providerInstanceId,
            providerSessionId: attempt.providerSessionId,
            modelId: attempt.modelId,
            contextManifestId: attempt.contextManifestId,
            responses: attempt.responses,
            createdAt: attempt.createdAt,
            updatedAt: attempt.updatedAt,
          })),
        })),
      });
      const thread: MovedThreadReference = { mode: "chat", threadId: String(created.id) };
      options.holds.hold(thread);
      return { status: "arrived", thread };
    },
    activate: async (thread) => options.holds.release(thread),
    discard: async (thread) => {
      options.holds.release(thread);
      // A planned thread that was never opened has nothing to erase.
      if (viewOf(thread) !== undefined) await options.purge(decodeChatThreadId(thread.threadId));
    },
  };

  return { source, destination };
}

/**
 * The conversation a Chat thread carries: each active turn's message and the
 * answers of its completed attempts. Attempts that did not complete carry no
 * answer worth continuing from and are left out, as a branch leaves them.
 */
function conversationOf(
  view: ChatThreadView,
  externalContentIngested: boolean,
): MovedChatConversation {
  const contents = new Map(
    view.contents.map((content) => [String(content.contentId), content.body]),
  );
  return {
    format: MOVED_CHAT_CONVERSATION_FORMAT,
    title: view.thread.title,
    externalContentIngested,
    turns: view.turns.map((turn) => ({
      userText: contents.get(String(turn.userMessageRef.contentId)) ?? "",
      createdAt: turn.createdAt,
      attempts: turn.attempts
        .filter((attempt) => attempt.outcome === "completed")
        .map((attempt) => ({
          providerInstanceId: attempt.providerInstanceId,
          providerSessionId: attempt.providerSessionId,
          modelId: attempt.modelId,
          contextManifestId: attempt.contextManifestId,
          responses: attempt.responseRefs.map(
            (reference) => contents.get(String(reference.contentId)) ?? "",
          ),
          createdAt: attempt.createdAt,
          updatedAt: attempt.updatedAt,
        })),
    })),
  };
}
