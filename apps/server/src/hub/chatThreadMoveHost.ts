// The Chat side of a thread move, on both computers. The source packs the
// conversation it holds (each turn's message and each completed attempt's
// answers, with the provider identifiers they ran on), the attachments and
// admitted inputs its turns carried, and the thread's other bulk parts, and
// erases the thread through the ordinary purge once the destination
// committed. The destination opens the conversation as real turns, held until
// the commit, the way a branch carries its source's turns.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ChatAttachmentId,
  ChatAttachmentMediaType,
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
  type ThreadMovePartLeftBehind,
} from "@octant/contracts";
import { Schema } from "effect";
import type { MovedChatAttachment, MovedChatThreadImport } from "../chat/chatService";
import {
  MovedThreadParts,
  movedPartUuid,
  packThreadParts,
  rehomeThreadParts,
  type ThreadPartsDestination,
  type ThreadPartsSource,
} from "./movedThreadParts";
import type {
  PackedPart,
  ThreadMoveDestinationHost,
  ThreadMoveSourceHost,
} from "./threadMoveService";
import type { ThreadMoveHolds } from "./threadMoveHolds";

/** The format the Chat conversation part is written in; a destination refuses any other. */
export const MOVED_CHAT_CONVERSATION_FORMAT = "octant.thread-move.chat/1" as const;

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/** An attachment or admitted input, carried as its own part. */
const MovedAttachment = Schema.Struct({
  partId: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
  displayName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  mediaType: ChatAttachmentMediaType,
}).annotations(strict);
type MovedAttachment = typeof MovedAttachment.Type;

const MovedChatConversation = Schema.Struct({
  format: Schema.Literal(MOVED_CHAT_CONVERSATION_FORMAT),
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  externalContentIngested: Schema.Boolean,
  turns: Schema.Array(
    Schema.Struct({
      userText: Schema.String,
      createdAt: UtcTimestamp,
      attachments: Schema.optional(Schema.Array(MovedAttachment)),
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
  unsentAttachments: Schema.optional(Schema.Array(MovedAttachment)),
  parts: Schema.optional(MovedThreadParts),
}).annotations(strict);
type MovedChatConversation = typeof MovedChatConversation.Type;

const decodeConversation = Schema.decodeUnknownSync(MovedChatConversation);
const decodeChatThreadId = Schema.decodeUnknownSync(ChatThreadId);
const decodeProjectId = Schema.decodeUnknownSync(ProjectId);
const decodeChatAttachmentMediaType = Schema.decodeUnknownSync(ChatAttachmentMediaType);
const decodeChatAttachmentId = Schema.decodeUnknownSync(ChatAttachmentId);

export interface ChatThreadMoveHostOptions {
  readonly readView: (threadId: ChatThreadId) => ChatThreadView | undefined;
  /** Whether a turn is running or the thread waits on the person. */
  readonly isBusy: (view: ChatThreadView) => boolean;
  readonly externalContentIngested: (threadId: string) => boolean;
  readonly importMovedThread: (input: MovedChatThreadImport) => Promise<ChatThread>;
  /** The bytes of one finalized attachment of a Chat thread; undefined when they cannot be read. */
  readonly readAttachment: (
    threadId: string,
    attachmentId: string,
  ) => Promise<Uint8Array | undefined>;
  readonly parts: {
    readonly source: ThreadPartsSource;
    readonly destination: ThreadPartsDestination;
  };
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
    measure: async (thread) => {
      const view = viewOf(thread);
      if (view === undefined) return { status: "unknown" };
      // The text pack writes, less the few lines that list the bulk parts:
      // reading those parts is not something a read-only measure does, and
      // their bytes are not counted yet.
      const bytes = Buffer.byteLength(
        JSON.stringify(
          conversationOf(view, options.externalContentIngested(thread.threadId), {
            byTurn: [],
            unsent: [],
            parts: [],
            partsLeftBehind: [],
          }),
        ),
      );
      return { status: "measured", bytes, parts: [{ kind: "thread-bundle", bytes }] };
    },
    pack: async (thread, folder) => {
      const view = viewOf(thread);
      if (view === undefined) return { status: "refused", reason: "refused" };
      const attachments = await packAttachments(view, folder, options.readAttachment);
      const bulk = await packThreadParts(thread, folder, options.parts.source);
      const conversation: MovedChatConversation = {
        ...conversationOf(view, options.externalContentIngested(thread.threadId), attachments),
        ...(attachments.unsent.length === 0 ? {} : { unsentAttachments: attachments.unsent }),
        ...(bulk.index === undefined ? {} : { parts: bulk.index }),
      };
      const path = join(folder, "thread.json");
      await writeFile(path, JSON.stringify(conversation), { mode: 0o600 });
      const part: PackedPart = { partId: "thread", kind: "thread-bundle", path };
      const partsLeftBehind = [...attachments.partsLeftBehind, ...bulk.partsLeftBehind];
      return {
        status: "packed",
        parts: [part, ...attachments.parts, ...bulk.parts],
        ...(partsLeftBehind.length === 0 ? {} : { partsLeftBehind }),
      };
    },
    erase: async ({ thread }) => {
      await options.purge(decodeChatThreadId(thread.threadId));
      // A Chat thread owns no worktree.
      return { worktreeKept: false };
    },
  };

  const destination: ThreadMoveDestinationHost = {
    acceptsProject: (placement) =>
      placement.mode === "chat" &&
      (placement.destinationProjectId === undefined ||
        options.activeChatProject(placement.destinationProjectId)),
    arrive: async ({ thread: planned, offer, parts }) => {
      if (planned.mode !== "chat") return { status: "refused", reason: "transfer-failed" };
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
      const moveId = String(offer.moveId);
      // The other bulk parts are re-homed once the thread exists, each under
      // an id the move derives, so a second try records nothing twice.
      const rehome = () =>
        rehomeThreadParts({
          index: conversation.parts,
          parts,
          moveId,
          thread: planned,
          projectId:
            offer.destinationProjectId === undefined ? null : String(offer.destinationProjectId),
          destination: options.parts.destination,
        });
      // A thread already opened under the planned id was opened by an earlier
      // try that stopped before it was recorded: hold it, never open a second.
      // That try may have stopped before every part was re-homed, so the rest
      // are now, before the source is told it arrived and erases its copy.
      if (viewOf(planned) !== undefined) {
        options.holds.hold(planned);
        if ((await rehome()).status === "refused") {
          return { status: "refused", reason: "transfer-failed" };
        }
        return { status: "arrived", thread: planned };
      }
      if (
        offer.destinationProjectId !== undefined &&
        !options.activeChatProject(String(offer.destinationProjectId))
      ) {
        return { status: "refused", reason: "no-eligible-project" };
      }
      let turnAttachments: ReadonlyArray<ReadonlyArray<MovedChatAttachment>>;
      let unsentAttachments: ReadonlyArray<MovedChatAttachment>;
      try {
        const carry = (attachments: ReadonlyArray<MovedAttachment> | undefined) =>
          Promise.all((attachments ?? []).map((moved) => arrivedAttachment(moved, parts, moveId)));
        turnAttachments = await Promise.all(
          conversation.turns.map((turn) => carry(turn.attachments)),
        );
        unsentAttachments = await carry(conversation.unsentAttachments);
      } catch {
        return { status: "refused", reason: "transfer-failed" };
      }
      options.holds.hold(planned);
      const created = await options.importMovedThread({
        moveId,
        threadId: decodeChatThreadId(planned.threadId),
        title: conversation.title,
        ...(offer.destinationProjectId === undefined
          ? {}
          : { projectId: decodeProjectId(offer.destinationProjectId) }),
        externalContentIngested: conversation.externalContentIngested,
        ...(unsentAttachments.length === 0 ? {} : { unsentAttachments }),
        turns: conversation.turns.map((turn, index) => ({
          userText: turn.userText,
          createdAt: turn.createdAt,
          ...((turnAttachments[index]?.length ?? 0) === 0
            ? {}
            : { attachments: turnAttachments[index] }),
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
      if ((await rehome()).status === "refused") {
        return { status: "refused", reason: "transfer-failed" };
      }
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

/** The attachments a Chat thread carries, written as parts beside the conversation. */
interface PackedAttachments {
  /** Each turn's attachments and admitted inputs, by the turn's position in the view. */
  readonly byTurn: ReadonlyArray<ReadonlyArray<MovedAttachment>>;
  readonly unsent: ReadonlyArray<MovedAttachment>;
  readonly parts: ReadonlyArray<PackedPart>;
  readonly partsLeftBehind: ReadonlyArray<ThreadMovePartLeftBehind>;
}

/**
 * Reads every attachment the thread's turns carried, every input a turn
 * admitted from another Chat thread, and the attachments added but not sent.
 * An admitted input lives in its own thread, which stays on this computer,
 * so its bytes travel and the moved turn owns them. A part whose bytes cannot
 * be read, or no longer match the digest the turn admitted, stays behind and
 * is named.
 */
async function packAttachments(
  view: ChatThreadView,
  folder: string,
  read: ChatThreadMoveHostOptions["readAttachment"],
): Promise<PackedAttachments> {
  const parts: PackedPart[] = [];
  const partsLeftBehind: ThreadMovePartLeftBehind[] = [];
  const carry = async (input: {
    readonly kind: "attachment" | "original-input";
    readonly threadId: string;
    readonly attachmentId: string;
    readonly displayName: string;
    readonly mediaType: string;
    readonly digest: string;
  }): Promise<MovedAttachment | undefined> => {
    const bytes = await read(input.threadId, input.attachmentId).catch(() => undefined);
    let mediaType: ChatAttachmentMediaType | undefined;
    try {
      mediaType = decodeChatAttachmentMediaType(input.mediaType);
    } catch {
      mediaType = undefined;
    }
    if (
      bytes === undefined ||
      mediaType === undefined ||
      createHash("sha256").update(bytes).digest("hex") !== input.digest
    ) {
      partsLeftBehind.push({ kind: input.kind, name: input.displayName.slice(0, 512) });
      return undefined;
    }
    const partId = `${input.kind === "attachment" ? "attachment" : "input"}-${parts.length + 1}`;
    const path = join(folder, `${partId}.part`);
    await writeFile(path, bytes, { mode: 0o600 });
    parts.push({ partId, kind: input.kind, path });
    return { partId, displayName: input.displayName.slice(0, 512), mediaType };
  };
  const finalized = new Map(
    view.attachments
      .filter((attachment) => attachment.status === "finalized")
      .map((attachment) => [String(attachment.id), attachment]),
  );
  const sent = new Set<string>();
  const byTurn: Array<ReadonlyArray<MovedAttachment>> = [];
  for (const turn of view.turns) {
    const carried: MovedAttachment[] = [];
    for (const attachmentId of turn.attachmentIds) {
      sent.add(String(attachmentId));
      // A purged attachment was removed by the person and has nothing to carry.
      const attachment = finalized.get(String(attachmentId));
      if (attachment === undefined) continue;
      const moved = await carry({
        kind: "attachment",
        threadId: String(view.thread.id),
        attachmentId: String(attachment.id),
        displayName: attachment.displayName,
        mediaType: attachment.mediaType,
        digest: attachment.digest,
      });
      if (moved !== undefined) carried.push(moved);
    }
    for (const input of turn.originalInputs ?? []) {
      if (input.source.mode !== "chat") {
        partsLeftBehind.push({ kind: "original-input", name: input.displayName });
        continue;
      }
      const moved = await carry({
        kind: "original-input",
        threadId: input.source.threadId,
        attachmentId: input.source.attachmentId,
        displayName: input.displayName,
        mediaType: input.mediaType,
        digest: input.digest,
      });
      if (moved !== undefined) carried.push(moved);
    }
    byTurn.push(carried);
  }
  const unsent: MovedAttachment[] = [];
  for (const attachment of finalized.values()) {
    if (sent.has(String(attachment.id)) || attachment.turnId !== undefined) continue;
    const moved = await carry({
      kind: "attachment",
      threadId: String(view.thread.id),
      attachmentId: String(attachment.id),
      displayName: attachment.displayName,
      mediaType: attachment.mediaType,
      digest: attachment.digest,
    });
    if (moved !== undefined) unsent.push(moved);
  }
  return { byTurn, unsent, parts, partsLeftBehind };
}

/** An attachment as it arrived, under the id this move gives it here. */
async function arrivedAttachment(
  moved: MovedAttachment,
  parts: ReadonlyMap<string, string>,
  moveId: string,
): Promise<MovedChatAttachment> {
  const path = parts.get(moved.partId);
  if (path === undefined) throw new Error(`The part ${moved.partId} did not arrive.`);
  return {
    attachmentId: decodeChatAttachmentId(movedPartUuid(moveId, moved.partId)),
    displayName: moved.displayName,
    mediaType: moved.mediaType,
    bytes: new Uint8Array(await readFile(path)),
  };
}

/**
 * The conversation a Chat thread carries: each active turn's message and the
 * answers of its completed attempts. Attempts that did not complete carry no
 * answer worth continuing from and are left out, as a branch leaves them.
 */
function conversationOf(
  view: ChatThreadView,
  externalContentIngested: boolean,
  attachments: PackedAttachments,
): MovedChatConversation {
  const contents = new Map(
    view.contents.map((content) => [String(content.contentId), content.body]),
  );
  return {
    format: MOVED_CHAT_CONVERSATION_FORMAT,
    title: view.thread.title,
    externalContentIngested,
    turns: view.turns.map((turn, index) => ({
      userText: contents.get(String(turn.userMessageRef.contentId)) ?? "",
      createdAt: turn.createdAt,
      ...((attachments.byTurn[index]?.length ?? 0) === 0
        ? {}
        : { attachments: attachments.byTurn[index] }),
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
