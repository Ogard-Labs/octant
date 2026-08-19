import type { ChatThreadView } from "@octant/contracts/chat";
import { decodeCodeThreadId, type CodeThreadId } from "@octant/contracts/code";
import {
  MAX_CODE_CONVERSATION_PAGE_SIZE,
  type CodeConversationPage,
  type CodeOperationId,
} from "@octant/contracts/code-operations";
import { UtcTimestamp } from "@octant/contracts/events";
import type { HostId } from "@octant/contracts/host";
import type { ProjectId } from "@octant/contracts/projects";
import type { ProviderInstanceId, ProviderModelId } from "@octant/contracts/providers";
import {
  decodeThreadExportOutcome,
  decodeThreadExportRequest,
  type ThreadExportAttachment,
  type ThreadExportCitation,
  type ThreadExportId,
  type ThreadExportOutcome,
  type ThreadExportRequest,
  type ThreadExportTranscriptEntry,
  type ThreadExportTranscriptStatus,
} from "@octant/contracts/thread-export";
import type { WindowId, WorkThread, WorkTurnState } from "@octant/contracts";
import { activeChatTurns } from "@octant/domain/chat-policy";
import {
  authorizeThreadExportActor,
  buildThreadExportBundle,
  collectOmissions,
  decideThreadExportAccess,
  threadExportContainsForbiddenKey,
  transcriptWithCounts,
  type ThreadExportActorKind,
  type ThreadExportArtifactSource,
  type ThreadExportSource,
} from "@octant/domain";
import { Schema } from "effect";
import type { CanvasProjection, CanvasProjectionEntry } from "./canvas/canvasProjection";

const IN_PROGRESS = new Set(["queued", "streaming", "waiting", "running", "accepted"]);
const MAX_CODE_EXPORT_CONVERSATION_PAGES = 100;
const decodeCut = Schema.decodeUnknownSync(UtcTimestamp);

export interface ThreadExportChatPort {
  readonly read: (threadId: string) => ChatThreadView | undefined;
}

export interface ThreadExportWorkPort {
  readonly read: (
    windowId: WindowId,
    threadId: string,
  ) => Promise<
    { readonly thread: WorkThread; readonly turns: ReadonlyArray<WorkTurnState> } | undefined
  >;
}

export interface ThreadExportCodePort {
  readonly readThread: (
    windowId: WindowId,
    threadId: string,
  ) => Promise<
    | {
        readonly threadId: string;
        readonly title: string;
        readonly projectId: ProjectId;
        readonly version: number;
        readonly lastSequence: number;
        readonly providerInstanceId: ProviderInstanceId;
        readonly modelId: ProviderModelId;
        readonly createdAt: UtcTimestamp;
        readonly updatedAt: UtcTimestamp;
        readonly forkedFrom?: { readonly threadId: string };
      }
    | undefined
  >;
  readonly conversation: (
    windowId: WindowId,
    threadId: CodeThreadId,
    afterCursor: number,
    limit: number,
  ) => Promise<CodeConversationPage>;
  readonly readEvidence: (
    windowId: WindowId,
    threadId: CodeThreadId,
    operationId: CodeOperationId,
    contentId: string,
  ) => Promise<{ readonly bytes: Uint8Array }>;
}

export interface ThreadExportServiceOptions {
  readonly hostId: HostId;
  readonly clock: () => string;
  readonly chat: ThreadExportChatPort;
  readonly work: ThreadExportWorkPort;
  readonly code: ThreadExportCodePort;
  readonly canvases: Pick<CanvasProjection, "byThread">;
}

/**
 * Host-authoritative export of one thread.
 *
 * Assembles the portable cut from the same projections an Open would read,
 * then shapes it through the domain policy so a secret or a path cannot
 * appear. A missing or unreadable thread is refused without disclosing which.
 */
export class ThreadExportService {
  readonly #hostId: HostId;
  readonly #clock: () => string;
  readonly #chat: ThreadExportChatPort;
  readonly #work: ThreadExportWorkPort;
  readonly #code: ThreadExportCodePort;
  readonly #canvases: Pick<CanvasProjection, "byThread">;

  constructor(options: ThreadExportServiceOptions) {
    this.#hostId = options.hostId;
    this.#clock = options.clock;
    this.#chat = options.chat;
    this.#work = options.work;
    this.#code = options.code;
    this.#canvases = options.canvases;
  }

  async exportThread(
    windowId: WindowId,
    actorKind: ThreadExportActorKind,
    input: unknown,
  ): Promise<ThreadExportOutcome> {
    const authorization = authorizeThreadExportActor(actorKind);
    if (authorization.kind === "denied") {
      return decodeThreadExportOutcome({ kind: "refused", reason: "unauthorized" });
    }
    let request: ThreadExportRequest;
    try {
      request = decodeThreadExportRequest(input);
    } catch {
      return decodeThreadExportOutcome({ kind: "refused", reason: "not-found" });
    }
    const source = await this.#assemble(windowId, request);
    if (source === undefined) {
      return decodeThreadExportOutcome({ kind: "refused", reason: "not-found" });
    }
    const bundle = buildThreadExportBundle(source);
    if (threadExportContainsForbiddenKey(bundle)) {
      return decodeThreadExportOutcome({ kind: "refused", reason: "unauthorized" });
    }
    return decodeThreadExportOutcome({ kind: "exported", bundle });
  }

  async #assemble(
    windowId: WindowId,
    request: ThreadExportRequest,
  ): Promise<ThreadExportSource | undefined> {
    if (request.mode === "chat") return this.#assembleChat(request.threadId);
    if (request.mode === "work") return this.#assembleWork(windowId, request.threadId);
    return this.#assembleCode(windowId, request.threadId);
  }

  #assembleChat(threadId: ThreadExportId): ThreadExportSource | undefined {
    const view = this.#chat.read(threadId);
    const access = decideThreadExportAccess({
      exists: view !== undefined && view.thread.lifecycle !== "deleted",
      readable:
        view !== undefined &&
        view.thread.lifecycle !== "deleted" &&
        view.thread.lifecycle !== "deleting",
    });
    if (access.kind === "refuse" || view === undefined) return undefined;
    const contentById = new Map(
      view.contents.map((content) => [String(content.contentId), content] as const),
    );
    const active = activeChatTurns(view.turns);
    const entries: ThreadExportTranscriptEntry[] = [];
    let unreadable = 0;
    let inProgress = 0;
    for (const turn of active) {
      const user = contentById.get(String(turn.userMessageRef.contentId));
      if (user === undefined) {
        unreadable += 1;
        entries.push({
          role: "user",
          text: "",
          occurredAt: turn.createdAt,
          status: "unreadable",
        });
      } else {
        entries.push({
          role: "user",
          text: user.body,
          occurredAt: turn.createdAt,
          status: "completed",
        });
      }
      for (const attempt of turn.attempts) {
        const parts = attempt.responseRefs.map((reference) =>
          contentById.get(String(reference.contentId)),
        );
        const missing = parts.some((part) => part === undefined);
        const text = parts
          .map((part) => part?.body ?? "")
          .join("")
          .trim();
        if (missing && attempt.responseRefs.length > 0) unreadable += 1;
        if (IN_PROGRESS.has(attempt.outcome)) inProgress += 1;
        entries.push({
          role: "assistant",
          text,
          occurredAt: attempt.updatedAt,
          status: transcriptStatus(attempt.outcome, missing),
        });
      }
    }
    const attachments: ThreadExportAttachment[] = view.attachments.map((attachment) => ({
      displayName: attachment.displayName,
      mediaType: attachment.mediaType,
      byteLength: attachment.byteLength,
      status: attachment.status,
    }));
    const citations: ThreadExportCitation[] = view.citations.map((citation) => ({
      sourceTitle: citation.sourceTitle,
      sourceUrl: citation.sourceUrl,
      retrievedAt: citation.retrievedAt,
    }));
    const projectId = view.thread.projectId;
    const branched =
      view.thread.branchedFrom === undefined
        ? {}
        : {
            branchedFrom: {
              threadId: String(view.thread.branchedFrom.threadId),
              sourceVersion: view.thread.branchedFrom.sourceVersion,
              carriedTurnCount: view.thread.branchedFrom.carriedTurnCount,
              occurredAt: view.thread.branchedFrom.branchedAt,
            },
          };
    return {
      threadId,
      mode: "chat",
      title: view.thread.title,
      hostId: this.#hostId,
      ...(projectId === undefined ? {} : { projectId }),
      version: view.thread.version,
      sequence: view.lastSequence,
      generatedAt: decodeCut(this.#clock()),
      providerInstanceId: view.thread.providerInstanceId,
      modelId: view.thread.modelId,
      createdAt: view.thread.createdAt,
      updatedAt: view.thread.updatedAt,
      ...branched,
      transcript: transcriptWithCounts(entries, view.turns.length - active.length),
      artifacts: this.#artifacts("chat", projectId, threadId),
      attachments,
      citations,
      omissions: collectOmissions({
        "attachment-bytes": attachments.length,
        "superseded-turns": view.turns.length - active.length,
        "in-progress": inProgress,
        "unreadable-content": unreadable,
      }),
    };
  }

  async #assembleWork(
    windowId: WindowId,
    threadId: ThreadExportId,
  ): Promise<ThreadExportSource | undefined> {
    const read = await this.#work.read(windowId, threadId);
    const access = decideThreadExportAccess({
      exists: read !== undefined,
      readable: read !== undefined,
    });
    if (access.kind === "refuse" || read === undefined) return undefined;
    const entries: ThreadExportTranscriptEntry[] = [];
    let inProgress = 0;
    for (const turn of read.turns) {
      if (IN_PROGRESS.has(turn.status)) inProgress += 1;
      if (turn.transcript.length === 0) {
        entries.push({
          role: "user",
          text: turn.prompt,
          occurredAt: turn.acceptedAt,
          status: "completed",
        });
        if (turn.response !== undefined && turn.response.length > 0) {
          entries.push({
            role: "assistant",
            text: turn.response,
            occurredAt: turn.updatedAt,
            status: transcriptStatus(turn.status, false),
          });
        }
        continue;
      }
      for (const line of turn.transcript) {
        entries.push({
          role: line.role,
          text: line.text,
          occurredAt: line.role === "user" ? turn.acceptedAt : turn.updatedAt,
          status: transcriptStatus(line.status ?? turn.status, false),
        });
      }
    }
    const completion =
      read.thread.completionEvidence === undefined
        ? {}
        : { completion: read.thread.completionEvidence };
    return {
      threadId,
      mode: "work",
      title: read.thread.title,
      hostId: this.#hostId,
      projectId: read.thread.projectId,
      version: read.thread.version,
      sequence: read.thread.version,
      generatedAt: decodeCut(this.#clock()),
      providerInstanceId: read.thread.providerInstanceId,
      modelId: read.thread.modelId,
      createdAt: read.thread.createdAt,
      updatedAt: read.thread.updatedAt,
      transcript: transcriptWithCounts(entries, 0),
      artifacts: this.#artifacts("work", read.thread.projectId, threadId),
      attachments: [],
      citations: [],
      ...completion,
      omissions: collectOmissions({ "in-progress": inProgress }),
    };
  }

  async #assembleCode(
    windowId: WindowId,
    threadId: ThreadExportId,
  ): Promise<ThreadExportSource | undefined> {
    const thread = await this.#code.readThread(windowId, threadId);
    const access = decideThreadExportAccess({
      exists: thread !== undefined,
      readable: thread !== undefined,
    });
    if (access.kind === "refuse" || thread === undefined) return undefined;
    const conversation = await this.#readCodeConversation(windowId, decodeCodeThreadId(threadId));
    const branched =
      thread.forkedFrom === undefined
        ? {}
        : {
            branchedFrom: {
              threadId: String(thread.forkedFrom.threadId),
              sourceVersion: 0,
              carriedTurnCount: 0,
              occurredAt: thread.createdAt,
            },
          };
    return {
      threadId,
      mode: "code",
      title: thread.title,
      hostId: this.#hostId,
      projectId: thread.projectId,
      version: thread.version,
      sequence: thread.lastSequence,
      generatedAt: decodeCut(this.#clock()),
      providerInstanceId: thread.providerInstanceId,
      modelId: thread.modelId,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      ...branched,
      transcript: transcriptWithCounts(conversation.entries, 0),
      artifacts: this.#artifacts("code", thread.projectId, threadId),
      attachments: [],
      citations: [],
      omissions: collectOmissions({
        "in-progress": conversation.inProgress,
        "unreadable-content": conversation.unreadable,
        "truncated-conversation": conversation.truncated ? 1 : 0,
        "bulk-outside-journal": 1,
      }),
    };
  }

  async #readCodeConversation(
    windowId: WindowId,
    threadId: CodeThreadId,
  ): Promise<{
    readonly entries: ReadonlyArray<ThreadExportTranscriptEntry>;
    readonly inProgress: number;
    readonly unreadable: number;
    readonly truncated: boolean;
  }> {
    const collected: Array<CodeConversationPage["turns"][number]> = [];
    let cursor = 0;
    let truncated = false;
    try {
      for (let pages = 0; pages < MAX_CODE_EXPORT_CONVERSATION_PAGES; pages += 1) {
        const page = await this.#code.conversation(
          windowId,
          threadId,
          cursor,
          MAX_CODE_CONVERSATION_PAGE_SIZE,
        );
        collected.push(...page.turns);
        if (!page.hasMore) break;
        if (page.nextCursor <= cursor) {
          truncated = true;
          break;
        }
        cursor = page.nextCursor;
        if (pages === MAX_CODE_EXPORT_CONVERSATION_PAGES - 1 && page.hasMore) truncated = true;
      }
    } catch {
      return { entries: [], inProgress: 0, unreadable: 0, truncated: true };
    }
    const decoder = new TextDecoder();
    const entries: ThreadExportTranscriptEntry[] = [];
    let inProgress = 0;
    let unreadable = 0;
    for (const turn of collected) {
      if (IN_PROGRESS.has(turn.status)) inProgress += 1;
      const prompt = await this.#readEvidenceText(
        windowId,
        threadId,
        turn.operationId,
        [turn.prompt.contentId],
        decoder,
      );
      if (prompt === undefined) unreadable += 1;
      else {
        entries.push({
          role: "user",
          text: prompt,
          occurredAt: turn.startedAt,
          status: "completed",
        });
      }
      if (turn.status !== "completed") continue;
      const response = await this.#readEvidenceText(
        windowId,
        threadId,
        turn.operationId,
        turn.assistant.map((reference) => reference.contentId),
        decoder,
      );
      if (response === undefined) unreadable += 1;
      else {
        entries.push({
          role: "assistant",
          text: response,
          occurredAt: turn.updatedAt,
          status: transcriptStatus(turn.status, false),
        });
      }
    }
    return { entries, inProgress, unreadable, truncated };
  }

  async #readEvidenceText(
    windowId: WindowId,
    threadId: CodeThreadId,
    operationId: CodeOperationId,
    contentIds: ReadonlyArray<string>,
    decoder: TextDecoder,
  ): Promise<string | undefined> {
    let text = "";
    for (const contentId of contentIds) {
      try {
        const evidence = await this.#code.readEvidence(windowId, threadId, operationId, contentId);
        text += decoder.decode(evidence.bytes);
      } catch {
        return undefined;
      }
    }
    const normalized = text.trim();
    return normalized.length === 0 ? undefined : normalized;
  }

  #artifacts(
    mode: "chat" | "work" | "code",
    projectId: ProjectId | undefined,
    threadId: string,
  ): ReadonlyArray<ThreadExportArtifactSource> {
    if (projectId === undefined) return [];
    return this.#canvases
      .byThread({ projectId, threadId, mode })
      .map((entry: CanvasProjectionEntry) => ({
        canvasId: String(entry.canvasId),
        versionId: String(entry.currentVersion.versionId),
        sequence: entry.currentVersion.sequence,
        title: entry.currentVersion.definition.title,
        updatedAt: entry.updatedAt,
        definition: {
          title: entry.currentVersion.definition.title,
          blocks: entry.currentVersion.definition.blocks,
        },
      }));
  }
}

function transcriptStatus(outcome: string, missing: boolean): ThreadExportTranscriptStatus {
  if (missing) return "unreadable";
  if (outcome === "completed") return "completed";
  if (outcome === "waiting") return "waiting";
  if (outcome === "interrupted") return "interrupted";
  if (outcome === "failed") return "failed";
  if (outcome === "cancelled") return "cancelled";
  if (IN_PROGRESS.has(outcome)) return "running";
  return "completed";
}
